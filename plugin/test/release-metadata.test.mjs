import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "../manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "../package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(here, "../../versions.json"), "utf8"));

console.log("release metadata\n");

check("manifest and package versions match", manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);
check("versions.json maps current version to minAppVersion", versions[manifest.version] === manifest.minAppVersion, `${versions[manifest.version]} vs ${manifest.minAppVersion}`);
check("manifest declares mobile compatibility", manifest.isDesktopOnly === false);
check("plugin id is folder-safe", /^[a-z][a-z0-9-]*$/.test(manifest.id), manifest.id);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
