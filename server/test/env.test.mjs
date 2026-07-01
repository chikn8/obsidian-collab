import { envFlag, envInt, productionDefault } from "../src/env.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server env helpers\n");

const originalNodeEnv = process.env.NODE_ENV;
const originalFlag = process.env.TEST_COLLAB_FLAG;
const originalInt = process.env.TEST_COLLAB_INT;

try {
  delete process.env.TEST_COLLAB_FLAG;
  check("missing flag uses default false", envFlag("TEST_COLLAB_FLAG") === false);
  check("missing flag can default true", envFlag("TEST_COLLAB_FLAG", true) === true);

  process.env.TEST_COLLAB_FLAG = "true";
  check("true flag parses true", envFlag("TEST_COLLAB_FLAG") === true);

  process.env.TEST_COLLAB_FLAG = "0";
  check("zero flag parses false", envFlag("TEST_COLLAB_FLAG", true) === false);

  process.env.TEST_COLLAB_FLAG = "";
  check("empty flag falls back to default", envFlag("TEST_COLLAB_FLAG", true) === true);

  process.env.NODE_ENV = "production";
  check("production default is true in production", productionDefault() === true);

  process.env.NODE_ENV = "test";
  check("production default is false outside production", productionDefault() === false);

  delete process.env.TEST_COLLAB_INT;
  check("missing int uses default", envInt("TEST_COLLAB_INT", 42) === 42);

  process.env.TEST_COLLAB_INT = "1234";
  check("int parses numeric value", envInt("TEST_COLLAB_INT", 42) === 1234);

  {
    const originalWarn = console.warn;
    try {
      console.warn = () => {};
      process.env.TEST_COLLAB_INT = "10s";
      check("invalid int falls back to default", envInt("TEST_COLLAB_INT", 42) === 42);

      process.env.TEST_COLLAB_INT = "50";
      check("int below min falls back to default", envInt("TEST_COLLAB_INT", 42, 1000) === 42);
    } finally {
      console.warn = originalWarn;
    }
  }
} finally {
  if (originalFlag === undefined) delete process.env.TEST_COLLAB_FLAG;
  else process.env.TEST_COLLAB_FLAG = originalFlag;
  if (originalInt === undefined) delete process.env.TEST_COLLAB_INT;
  else process.env.TEST_COLLAB_INT = originalInt;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
