#!/usr/bin/env bash
# start-collab.sh — bring up the obsidian-collab server + localtunnel in one shot.
# - Reuses a stable AUTH_TOKEN (stored in .collab-token, gitignored)
# - Reuses a stable localtunnel subdomain (so the URL ideally stays the same)
# - Prints a copy-paste block for your friend
# - Cleans up server + tunnel on Ctrl+C

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$PROJECT_DIR/server"
TOKEN_FILE="$PROJECT_DIR/.collab-token"
SUBDOMAIN_FILE="$PROJECT_DIR/.collab-subdomain"
SERVER_LOG="/tmp/obsidian-collab-server.log"
TUNNEL_LOG="/tmp/obsidian-collab-tunnel.log"
PORT=1234

# ---------- Token (stable across restarts) ----------
if [[ ! -f "$TOKEN_FILE" ]]; then
  # 16 hex chars, same shape as the one you've been using
  openssl rand -hex 8 > "$TOKEN_FILE"
  echo "Generated new AUTH_TOKEN at $TOKEN_FILE"
fi
AUTH_TOKEN="$(cat "$TOKEN_FILE")"

# ---------- Subdomain (stable, but may be taken on first run) ----------
if [[ ! -f "$SUBDOMAIN_FILE" ]]; then
  # Default: something unique-ish to you. Edit this file to change later.
  echo "saket-obsidian-collab" > "$SUBDOMAIN_FILE"
  echo "Set default subdomain in $SUBDOMAIN_FILE (edit if it's taken)"
fi
SUBDOMAIN="$(cat "$SUBDOMAIN_FILE")"

# ---------- Cleanup on exit ----------
SERVER_PID=""
TUNNEL_PID=""
cleanup() {
  echo ""
  echo "Shutting down..."
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Bye."
}
trap cleanup INT TERM EXIT

# ---------- Start server ----------
echo "Starting collab server on :$PORT ..."
cd "$SERVER_DIR"
if [[ ! -d node_modules ]]; then
  echo "Installing server deps (first run)..."
  npm install
fi
AUTH_TOKEN="$AUTH_TOKEN" npm run dev >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cd "$PROJECT_DIR"

# Wait for server to be listening
for _ in $(seq 1 30); do
  if grep -q "WebSocket: ws://localhost:$PORT" "$SERVER_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.3
done
if ! grep -q "WebSocket: ws://localhost:$PORT" "$SERVER_LOG"; then
  echo "Server didn't start. Last log:"
  tail -20 "$SERVER_LOG"
  exit 1
fi
echo "  server up."

# ---------- Start tunnel ----------
echo "Opening localtunnel (subdomain: $SUBDOMAIN) ..."
: >"$TUNNEL_LOG"
npx --yes localtunnel --port "$PORT" --subdomain "$SUBDOMAIN" >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Parse the URL from tunnel output
TUNNEL_URL=""
for _ in $(seq 1 40); do
  if grep -qE "your url is: https?://[^ ]+" "$TUNNEL_LOG" 2>/dev/null; then
    TUNNEL_URL="$(grep -oE "https?://[a-zA-Z0-9.-]+\.loca\.lt" "$TUNNEL_LOG" | head -1)"
    break
  fi
  sleep 0.3
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Tunnel didn't come up. Last log:"
  tail -20 "$TUNNEL_LOG"
  exit 1
fi

# Convert https:// -> wss:// for the plugin
WSS_URL="${TUNNEL_URL/https:\/\//wss://}"
WSS_URL="${WSS_URL/http:\/\//ws://}"

GOT_SUB="$(echo "$TUNNEL_URL" | sed -E 's#https?://([^.]+)\.loca\.lt#\1#')"

# ---------- Print the share block ----------
cat <<EOF

==================================================
  Obsidian Collab is live
==================================================

  Server URL  : $WSS_URL
  Password    : $AUTH_TOKEN

EOF

if [[ "$GOT_SUB" != "$SUBDOMAIN" ]]; then
  cat <<EOF
  ⚠️  Subdomain "$SUBDOMAIN" was taken — got "$GOT_SUB" instead.
      Edit .collab-subdomain to pick a different stable name.

EOF
fi

cat <<EOF
  Send this to your friend:
  --------------------------------------------------
  Server URL: $WSS_URL
  Password:   $AUTH_TOKEN
  --------------------------------------------------

  Logs:
    server  -> $SERVER_LOG
    tunnel  -> $TUNNEL_LOG

  Press Ctrl+C to stop.
==================================================

EOF

# Block until either child exits (Bash 3.2 compatible — macOS ships with 3.2)
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do
  sleep 1
done
