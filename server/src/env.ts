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

/** Positive-number env parse with a floor. A typo'd interval must fall back to
 *  the default, not become NaN (setTimeout(NaN) fires immediately → tight loop)
 *  or a sub-second stampede. */
export function envInt(name: string, defaultValue: number, minValue = 0): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.warn(`[env] ignoring invalid ${name}="${raw}"; using ${defaultValue}`);
    return defaultValue;
  }
  return Math.floor(parsed);
}
