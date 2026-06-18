import type { App } from "obsidian";

export function configDir(app: App): string {
  return ((app.vault as any).configDir as string | undefined) || ".obsidian";
}

export function pluginDataDir(app: App): string {
  return `${configDir(app)}/plugins/obsidian-collab`;
}

export function pluginDataPath(app: App, relPath: string): string {
  return `${pluginDataDir(app)}/${relPath.replace(/^\/+/, "")}`;
}
