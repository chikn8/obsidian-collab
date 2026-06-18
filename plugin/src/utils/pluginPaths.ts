import type { App } from "obsidian";

export const PLUGIN_ID = "live-collab";
export const LEGACY_PLUGIN_ID = "obsidian-collab";

export function configDir(app: App): string {
  return ((app.vault as any).configDir as string | undefined) || ".obsidian";
}

export function pluginDataDir(app: App, pluginId = PLUGIN_ID): string {
  return `${configDir(app)}/plugins/${pluginId}`;
}

export function pluginDataPath(app: App, relPath: string): string {
  return `${pluginDataDir(app)}/${relPath.replace(/^\/+/, "")}`;
}

export function legacyPluginDataPath(app: App, relPath: string): string {
  return `${pluginDataDir(app, LEGACY_PLUGIN_ID)}/${relPath.replace(/^\/+/, "")}`;
}

export async function readLegacyPluginData(app: App): Promise<Record<string, unknown> | null> {
  try {
    const raw = await app.vault.adapter.read(legacyPluginDataPath(app, "data.json"));
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
