/**
 * A single shared folder. The unit you hand to one person/group.
 *  - `id`    : unguessable namespace for this share's rooms (and Tier-1 capability).
 *  - `key`   : scoped role token sent as the WebSocket `token`.
 *  - `ownerKey`: creator-only scoped token for minting links/revoking this share.
 *  - `legacy`: the auto-migrated original folder. Uses the OLD un-prefixed rooms
 *              (__manifest__, file:...) so existing data + collaborators are untouched.
 */
export type Role = "viewer" | "commenter" | "editor";

export interface Share {
  id: string;
  key: string;
  label: string;
  localFolder: string;
  legacy?: boolean;
  /** The holder's own role for this share (default editor). Joined viewer/commenter
   *  shares carry their role; the creator's own share is editor. */
  role?: Role;
  /** Revocation epoch baked into the role key (default 1 for new shares). */
  epoch?: number;
  /** Scoped creator token for this share only. Never included in share codes. */
  ownerKey?: string;
  /** Invite metadata when this device joined via a per-recipient invite. */
  inviteId?: string;
  expiresAt?: number;
  /** Creator-local list of invites minted from this device. */
  invites?: ShareInvite[];
}

export interface ShareInvite {
  id: string;
  role: Role;
  key?: string;
  recipient?: string;
  createdAt?: number;
  expiresAt?: number;
  revokedAt?: number;
}

/**
 * One file in a share's manifest (`Y.Map("files")`, keyed by relPath).
 *
 * Schema v2 (additive — v1 clients ignore the new fields):
 *  - `fileId` gives each file a stable identity independent of its path, so a
 *    rename is "same file, new path" rather than delete+create, and concurrent
 *    same-path creates can be told apart.
 *  - deletes are TOMBSTONES (`exists:false`, the entry is retained) so the
 *    deletion replays deterministically and the file is recoverable.
 */
export interface ManifestEntry {
  /** Text entries use CRDT rooms; binary entries use content-addressed blobs. */
  kind?: "text" | "binary";
  /** Stable identity (crypto.randomUUID); assigned on create, preserved across rename. */
  fileId?: string;
  /** Redundant copy of the map key — explicit so renames carry the path. */
  path?: string;
  exists: boolean;
  deleted?: boolean;
  lastModified: number;
  createdBy?: string;
  deletedBy?: string;
  deletedAt?: number;
  renamedFrom?: string;
  renamedTo?: string;
  restoredBy?: string;
  restoredAt?: number;
  resurrectedBy?: string;
  lastEditedBy?: string;
  lastEditedAt?: number;
  blobHash?: string;
  blobSize?: number;
  blobUpdatedAt?: number;
}

/** Current manifest schema version (stored on the manifest doc's `meta` map). */
export const MANIFEST_SCHEMA_VERSION = 2;

export interface CollabPluginSettings {
  serverUrl: string;
  /** Global password for legacy (un-namespaced) rooms. Was `password`. */
  serverPassword: string;
  /** Narrow server-side mint token for creating shares. Does not derive share keys client-side. */
  shareMintToken: string;
  /** Deprecated fallback for old servers that require client-side HMAC minting. */
  serverSecret: string;
  displayName: string;
  cursorColor: string;
  /** Stable per-install identity. Joins facepile<->cursor across the separate
   *  manifest/file Y.Doc awarenesses (which have different random clientIDs).
   *  Signed for invite-bound identity checks. */
  uid: string;
  /** Persistent ECDSA identity keypair. Private key stays local. */
  identityPublicKey: string;
  identityPrivateKey: string;
  identitySignature: string;
  /** Your ntfy topic for @mention pushes (e.g. elijah-cli-...). Empty = no pushes. */
  ntfyTopic: string;
  /** Verbose console logging for bug-testing. */
  debugLogging: boolean;
  /** Persist a redacted structured diagnostic trace for feedback-loop debugging. */
  diagnosticLogging: boolean;
  shares: Share[];
}

export const DEFAULT_SETTINGS: CollabPluginSettings = {
  serverUrl: "ws://localhost:1234",
  serverPassword: "",
  shareMintToken: "",
  serverSecret: "",
  displayName: "Anonymous",
  cursorColor: "#ff6b6b",
  uid: "",
  identityPublicKey: "",
  identityPrivateKey: "",
  identitySignature: "",
  ntfyTopic: "",
  debugLogging: false,
  diagnosticLogging: false,
  shares: [],
};

/** Sentinel id for the auto-migrated original folder (keeps un-prefixed rooms). */
export const LEGACY_SHARE_ID = "__legacy__";

export const CURSOR_COLORS = [
  "#ff6b6b",
  "#4ecdc4",
  "#45b7d1",
  "#96ceb4",
  "#feca57",
  "#ff9ff3",
  "#54a0ff",
  "#5f27cd",
  "#01a3a4",
  "#f368e0",
  "#ff6348",
  "#2ed573",
];

/**
 * Deterministic color from a stable seed (uid). Used as a fallback when the
 * user hasn't picked an explicit cursorColor, so the same person gets a stable
 * color for avatars AND editor cursors. NOTE: only 12 palette entries — for
 * >12 concurrent distinct users, collisions are guaranteed (pigeonhole).
 */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length];
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type SyncStatus = "disconnected" | "connecting" | "connected" | "syncing" | "error";

export interface ConnectedUser {
  clientId: number;
  name: string;
  color: string;
  device?: string;
}
