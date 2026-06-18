import {
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  legacyPluginDataPath,
  pluginDataPath,
  readLegacyPluginData,
} from "../src/utils/pluginPaths.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("plugin paths\n");

const files = new Map([
  [".mobile-config/plugins/obsidian-collab/data.json", JSON.stringify({ serverUrl: "wss://example", shares: [{ id: "share-1" }] })],
]);
const app = {
  vault: {
    configDir: ".mobile-config",
    adapter: {
      async read(path) {
        if (!files.has(path)) throw new Error(`missing ${path}`);
        return files.get(path);
      },
    },
  },
};

check("current id is public-safe", PLUGIN_ID === "live-collab" && !PLUGIN_ID.includes("obsidian"), PLUGIN_ID);
check("legacy id is available for migration", LEGACY_PLUGIN_ID === "obsidian-collab", LEGACY_PLUGIN_ID);
check("current data path uses new plugin id", pluginDataPath(app, "diagnostics/x.json").startsWith(".mobile-config/plugins/live-collab/"), pluginDataPath(app, "diagnostics/x.json"));
check("legacy data path uses old plugin id", legacyPluginDataPath(app, "data.json") === ".mobile-config/plugins/obsidian-collab/data.json", legacyPluginDataPath(app, "data.json"));

const legacy = await readLegacyPluginData(app);
check("reads legacy settings data", legacy?.serverUrl === "wss://example" && legacy?.shares?.[0]?.id === "share-1");

files.set(".mobile-config/plugins/obsidian-collab/data.json", "[]");
check("ignores non-object legacy data", (await readLegacyPluginData(app)) === null);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
