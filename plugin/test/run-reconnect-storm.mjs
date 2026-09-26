/**
 * Bundles reconnect-storm.test.mjs against a plugin source tree and runs it.
 *   node test/run-reconnect-storm.mjs              # this tree, asserts bounds
 *   node test/run-reconnect-storm.mjs /tmp/old/src # another tree, report only
 */
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcArg = process.argv[2];
const src = path.resolve(srcArg || path.join(dir, "../src"));
if (!srcArg && !process.env.STORM_ASSERT) process.env.STORM_ASSERT = "1";

const result = await esbuild.build({
  entryPoints: [path.join(dir, "reconnect-storm.test.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "warning",
  // Resolve bare imports from the old tree through this package's node_modules.
  nodePaths: [path.join(dir, "../node_modules")],
  alias: {
    "@src": src,
    obsidian: path.join(dir, "fakes/obsidian-storm.mjs"),
    "y-indexeddb": path.join(dir, "fakes/y-indexeddb.mjs"),
    "y-websocket": path.join(dir, "fakes/y-websocket.mjs"),
  },
});

const code = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
await import(dataUrl);
