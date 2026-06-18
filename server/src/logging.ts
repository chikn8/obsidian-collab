export type LogLevel = "debug" | "info" | "warn" | "error";

function clean(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength };
  }
  return value;
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields)) row[key] = clean(value);
  const line = JSON.stringify(row);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
