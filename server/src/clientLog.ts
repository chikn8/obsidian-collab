export const CLIENT_LOG_MAX_BYTES = Number(process.env.CLIENT_LOG_MAX_BYTES || 64 * 1024);

const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 40;
const SECRET_KEY_RE = /(authorization|auth|credential|password|secret|token|key|code|content|body|text)/i;

export function clientLogFields(args: {
  shareId: string;
  role: string;
  remote: string;
  body: any;
}): Record<string, unknown> {
  const row = cleanObject(args.body?.row);
  const context = cleanObject(args.body?.context);
  return {
    shareId: cleanString(args.shareId),
    role: cleanString(args.role),
    remote: cleanString(args.remote),
    client: {
      sessionId: cleanString(String(row.sessionId || "")),
      seq: finiteNumber(row.seq),
      ts: cleanString(String(row.ts || "")),
      dt: finiteNumber(row.dt),
      level: cleanString(String(row.level || "")),
      ns: cleanString(String(row.ns || "")),
      event: cleanString(String(row.event || "")),
    },
    clientFields: clean("fields", row.fields, 0),
    clientContext: context,
  };
}

function cleanObject(value: unknown): Record<string, any> {
  const cleaned = clean("root", value, 0);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
    ? cleaned as Record<string, any>
    : {};
}

function clean(key: string, value: unknown, depth: number): unknown {
  if (value === undefined) return undefined;
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) {
    if (depth > 2) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY).map((child, i) => clean(String(i), child, depth + 1));
  }
  if (typeof value === "object") {
    if (depth > 2) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      const cleaned = clean(childKey, childValue, depth + 1);
      if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return out;
  }
  return cleanString(String(value));
}

function cleanString(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (clean.length <= MAX_STRING) return clean;
  return `${clean.slice(0, MAX_STRING)}...(${clean.length} chars)`;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
