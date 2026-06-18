export interface PresenceDevice {
  presenceKey: string;
  uid: string;
  deviceId: string;
  name: string;
  color: string;
  baseColor: string;
  device?: string;
  activeFile: string | null;
  typing: boolean;
  hasCaret: boolean;
  isSelf: boolean;
}

export function presenceKeyFromState(state: any, clientId: number): string {
  const uid = state?.user?.uid || "unknown";
  return `${uid}:${state?.user?.deviceId || clientId}`;
}

export function deviceIdFromState(state: any, clientId: number): string {
  return state?.user?.deviceId || String(clientId);
}

export function presenceLabel(user: PresenceDevice): string {
  const device = user.device ? ` (${user.device})` : "";
  const status = user.typing ? "typing" : user.hasCaret ? "editing" : "viewing";
  return user.isSelf
    ? `${user.name}${device} (you) - ${status}`
    : `${user.name}${device} - ${status}`;
}

export function presenceInitial(name: string): string {
  return (name?.trim()?.[0] || "?").toUpperCase();
}

export function collectPresenceDevices(args: {
  manifestAwareness: any;
  relPath?: string | null;
  caretKeys?: Set<string>;
}): PresenceDevice[] {
  const out: PresenceDevice[] = [];
  const seen = new Set<string>();
  const myClientId = args.manifestAwareness?.clientID;
  args.manifestAwareness?.getStates?.().forEach((state: any, clientId: number) => {
    const user = state?.user;
    const presence = state?.presence;
    if (!user?.uid) return;
    const activeFile = presence?.activeFile ?? null;
    if (args.relPath !== undefined && activeFile !== args.relPath) return;
    const key = presenceKeyFromState(state, clientId);
    if (seen.has(key)) return;
    seen.add(key);
    const baseColor = user.color || "#888888";
    const deviceId = deviceIdFromState(state, clientId);
    const displayName = user.displayName || user.name || "Anonymous";
    out.push({
      presenceKey: key,
      uid: user.uid,
      deviceId,
      name: displayName,
      color: deviceColor(baseColor, deviceId),
      baseColor,
      device: user.device,
      activeFile,
      typing: !!presence?.typing,
      hasCaret: !!args.caretKeys?.has(key),
      isSelf: clientId === myClientId,
    });
  });
  return sortPresence(out);
}

export function sortPresence(users: PresenceDevice[]): PresenceDevice[] {
  return [...users].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    const name = a.name.localeCompare(b.name);
    if (name !== 0) return name;
    return (a.device || "").localeCompare(b.device || "");
  });
}

export function deviceColor(baseColor: string, deviceId: string): string {
  const rgb = parseHex(baseColor);
  if (!rgb) return baseColor;
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const jitter = (hash(deviceId) % 37) - 18;
  const saturation = clamp(hsl.s + ((hash(deviceId + "s") % 15) - 5), 45, 88);
  const lightness = clamp(hsl.l + ((hash(deviceId + "l") % 17) - 8), 36, 66);
  return hslToHex((hsl.h + jitter + 360) % 360, saturation, lightness);
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return `#${toHex((r + m) * 255)}${toHex((g + m) * 255)}${toHex((b + m) * 255)}`;
}

function toHex(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0");
}

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
