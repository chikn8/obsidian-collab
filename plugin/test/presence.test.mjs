import {
  collectPresenceDevices,
  deviceColor,
  presenceLabel,
} from "../src/collab/PresenceModel.ts";
import { PresenceController, isTypingInputType, isTypingUserEvent } from "../src/collab/Presence.ts";

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
  getLocalState() {
    return this.states.get(this.clientID) || null;
  }
}

class MutableAwareness extends FakeAwareness {
  constructor(clientID, states) {
    super(clientID, states);
    this.handlers = new Set();
    this.writes = 0;
  }
  getLocalState() {
    return this.states.get(this.clientID) || null;
  }
  setLocalStateField(field, value) {
    this.writes++;
    const cur = this.getLocalState() || {};
    this.states.set(this.clientID, { ...cur, [field]: value });
    for (const handler of this.handlers) handler();
  }
  on(_event, handler) {
    this.handlers.add(handler);
  }
  off(_event, handler) {
    this.handlers.delete(handler);
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

{
  const base = "#54a0ff";
  const scoped = deviceColor(base, "desktop-1");
  const awareness = new FakeAwareness(1, [[
    1,
    {
      user: { uid: "same-user", deviceId: "desktop-1", name: "Elijah", color: scoped, baseColor: base, device: "desktop" },
      presence: { activeFile: "note.md", typing: false },
    },
  ]]);
  const users = collectPresenceDevices({ manifestAwareness: awareness, relPath: "note.md" });
  check("device-scoped awareness color is not jittered twice", users[0].color === scoped, `${users[0].color} vs ${scoped}`);
  check("base color remains available for grouping", users[0].baseColor === base, users[0].baseColor);
}

{
  const awareness = new FakeAwareness(9, [[
    9,
    {
      user: { uid: "same-user", deviceId: "desktop-1", name: "Elijah", color: "#54a0ff", device: "desktop" },
      presence: { activeFile: "note.md", typing: false },
    },
  ]]);
  awareness.getStates = () => new Map();
  const users = collectPresenceDevices({ manifestAwareness: awareness, relPath: "note.md" });
  check("local awareness fallback keeps self visible", users.length === 1 && users[0].isSelf, JSON.stringify(users));
}

{
  const manifestAwareness = new MutableAwareness(1, [[
    1,
    {
      user: { uid: "same-user", deviceId: "desktop-1", name: "Elijah", displayName: "Elijah", color: "#54a0ff", device: "desktop" },
    },
  ]]);
  const fileAwareness = new MutableAwareness(1, []);
  const dispatches = [];
  const controller = new PresenceController(
    { dispatch(effect) { dispatches.push(effect); } },
    {},
    manifestAwareness,
    fileAwareness,
    "note.md"
  );
  controller.start();
  const presence = manifestAwareness.getLocalState()?.presence;
  check("presence controller advertises active file on start", presence?.activeFile === "note.md", JSON.stringify(presence));
  check("presence controller starts non-typing", presence?.typing === false, JSON.stringify(presence));
  check("presence controller refreshes roster on start", dispatches.length > 0);
  const writesBeforeNoop = manifestAwareness.writes;
  controller.setTyping(false);
  check("presence controller typing false is idempotent", manifestAwareness.writes === writesBeforeNoop);
  controller.setTyping(true);
  const typingPresence = manifestAwareness.getLocalState()?.presence;
  check("presence controller can mark local typing", typingPresence?.typing === true, JSON.stringify(typingPresence));
  const writesBeforeNoopTyping = manifestAwareness.writes;
  controller.setTyping(true);
  check("presence controller typing true is idempotent", manifestAwareness.writes === writesBeforeNoopTyping);
  controller.stop();
  const stoppedPresence = manifestAwareness.getLocalState()?.presence;
  check("presence controller clears active file on stop", stoppedPresence?.activeFile === null && stoppedPresence?.typing === false, JSON.stringify(stoppedPresence));
}

{
  check("insert input counts as typing", isTypingInputType("insertText") === true);
  check("delete input counts as typing", isTypingInputType("deleteContentBackward") === true);
  check("history input counts as typing", isTypingInputType("historyUndo") === true);
  check("format input does not count as typing", isTypingInputType("formatBold") === false);
  check("codemirror input user event counts as typing", isTypingUserEvent("input.type") === true);
  check("codemirror delete user event counts as typing", isTypingUserEvent("delete.selection") === true);
  check("codemirror select user event does not count as typing", isTypingUserEvent("select.pointer") === false);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
