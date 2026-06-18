/**
 * Namespaced debug logging for the collab plugin. Gated by the `debugLogging`
 * setting so it can be silenced in normal use but flipped on for bug-testing.
 * Warnings/errors always print.
 *
 *   import { log } from "../utils/log";
 *   log("bind", "bound editor", path);
 */
let DEBUG = false;

export function setDebug(on: boolean): void {
  DEBUG = on;
}

export function log(ns: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`%c[collab:${ns}]`, "color:#54a0ff;font-weight:600", ...args);
}

export function warn(ns: string, ...args: unknown[]): void {
  console.warn(`[collab:${ns}]`, ...args);
}

export function err(ns: string, ...args: unknown[]): void {
  console.error(`[collab:${ns}]`, ...args);
}
