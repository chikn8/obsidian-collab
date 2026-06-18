/**
 * Bundles integration.test.mjs with obsidian/y-indexeddb/y-websocket aliased to
 * the in-memory fakes (so the REAL FileProvider source runs headless), then
 * executes it. esbuild dedups to a single bundled `yjs`, which is required for
 * Y.Doc identity to match across the provider and the fakes.
 */
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [path.join(dir, "integration.test.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "warning",
  alias: {
    obsidian: path.join(dir, "fakes/obsidian.mjs"),
    "y-indexeddb": path.join(dir, "fakes/y-indexeddb.mjs"),
    "y-websocket": path.join(dir, "fakes/y-websocket.mjs"),
  },
});

const code = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
await import(dataUrl);
