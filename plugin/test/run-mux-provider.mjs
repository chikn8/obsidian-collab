/**
 * Bundles mux-provider.test.mjs so the test and MuxProvider share one bundled
 * yjs instance. Running this test directly through tsx can load duplicate Yjs
 * constructors, which breaks protocol constructor checks.
 */
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [path.join(dir, "mux-provider.test.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "warning",
});

const code = result.outputFiles[0].text;
const dataUrl = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
await import(dataUrl);
