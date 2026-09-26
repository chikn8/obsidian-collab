// obsidian fake for the reconnect-storm harness: SyncManager is bundled whole,
// so it also needs the exports the FileProvider-only fake leaves out.
export * from "./obsidian.mjs";
export class MarkdownView {}
export async function requestUrl() { throw new Error("no network in the reconnect-storm harness"); }
