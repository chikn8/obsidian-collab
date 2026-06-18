export function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

export function productionDefault(): boolean {
  return process.env.NODE_ENV === "production";
}
