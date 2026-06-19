import { inviteDeviceLabel, parseInviteMaxDevices } from "../src/utils/inviteOptions.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("invite options\n");

check("blank max devices defaults to one", parseInviteMaxDevices("") === 1);
check("missing max devices defaults to one", parseInviteMaxDevices(undefined) === 1);
check("parses bounded integer", parseInviteMaxDevices("2") === 2);
check("trims whitespace", parseInviteMaxDevices(" 10 ") === 10);
check("rejects zero", parseInviteMaxDevices("0") === null);
check("rejects over ten", parseInviteMaxDevices("11") === null);
check("rejects decimals", parseInviteMaxDevices("1.5") === null);
check("rejects non-numbers", parseInviteMaxDevices("phone") === null);
check("labels singular", inviteDeviceLabel(1) === "1 device");
check("labels plural", inviteDeviceLabel(2) === "2 devices");
check("labels missing as one", inviteDeviceLabel(undefined) === "1 device");

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
