import {
  collectPresenceDevices,
  deviceColor,
  presenceLabel,
} from "../src/collab/PresenceModel.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

class FakeAwareness {
  constructor(clientID, states) {
    this.clientID = clientID;
    this.states = new Map(states);
  }
  getStates() {
    return this.states;
  }
}

console.log("presence model\n");

{
  const awareness = new FakeAwareness(1, [
    [1, {
      user: { uid: "same-user", deviceId: "desktop-1", name: "Elijah (desktop)", displayName: "Elijah", color: "#54a0ff", device: "desktop" },
      presence: { activeFile: "note.md", typing: true },
    }],
    [2, {
      user: { uid: "same-user", deviceId: "phone-1", name: "Elijah", color: "#54a0ff", device: "mobile" },
      presence: { activeFile: "note.md", typing: false },
    }],
    [3, {
      user: { uid: "other-user", deviceId: "laptop-1", name: "Saket", color: "#ff6b6b", device: "desktop" },
      presence: { activeFile: "other.md", typing: false },
    }],
  ]);
  const users = collectPresenceDevices({
    manifestAwareness: awareness,
    relPath: "note.md",
    caretKeys: new Set(["same-user:desktop-1"]),
  });

  check("same person can appear as two devices", users.length === 2, `count=${users.length}`);
  check("self device sorts first", users[0].deviceId === "desktop-1", users.map((u) => u.deviceId).join(","));
  check("typing state is per-device", users[0].typing === true && users[1].typing === false);
  check("caret state is per-device", users[0].hasCaret === true && users[1].hasCaret === false);
  check("device colors differ", users[0].color !== users[1].color, `${users[0].color} vs ${users[1].color}`);
  check("label includes device and status", presenceLabel(users[0]).includes("desktop") && presenceLabel(users[0]).includes("typing"));
  check("displayName prevents duplicate device label", presenceLabel(users[0]) === "Elijah (desktop) (you) - typing", presenceLabel(users[0]));
}

{
  const base = "#54a0ff";
  check("deviceColor is deterministic", deviceColor(base, "phone") === deviceColor(base, "phone"));
  check("deviceColor preserves hex shape", /^#[0-9a-f]{6}$/i.test(deviceColor(base, "phone")));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
