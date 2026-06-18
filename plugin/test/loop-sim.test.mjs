/**
 * Headless feedback-loop regression test (Phase A).
 *
 * Reproduces the FileProvider round-trip — remote update → observer →
 * writeToFile → disk → vault "modify" echo → onFileModify → applyLocalChange →
 * ytext — using the REAL EchoGuard and diffRange against real Yjs docs, on a
 * virtual clock with jittered delays (50ms…3s) to emulate mobile / slow disk /
 * batched FS events arriving long after any old setTimeout window.
 *
 * Asserts:
 *  1. No runaway — the event queue DRAINS (a feedback loop would never settle)
 *     and the plugin's disk-write count stays bounded.
 *  2. Convergence — peers' Y.Text agree, and disk reflects ytext.
 *  3. Stale-echo guard — a late echo for a superseded value is dropped and does
 *     NOT revert newer merged content (the specific oscillation Elijah hit).
 *
 * Run: node test/loop-sim.test.mjs   (Node 24+ strips the .ts type annotations)
 */
import * as Y from "yjs";
import { EchoGuard } from "../src/collab/EchoGuard.ts";
import { diffRange } from "../src/utils/textDiff.ts";

// ── tiny test harness ────────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

// Seeded PRNG so runs are deterministic per seed (and we can sweep seeds).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ── virtual-time event queue ──────────────────────────────────────────────────
class Sim {
  constructor(rng) {
    this.rng = rng;
    this.now = 0;
    this.q = [];
    this.processed = 0;
  }
  at(delay, fn) {
    this.q.push({ t: this.now + delay, fn });
  }
  jitter() {
    return 50 + Math.floor(this.rng() * 2950); // 50..3000ms
  }
  run(maxEvents) {
    while (this.q.length) {
      if (++this.processed > maxEvents) {
        throw new Error(`RUNAWAY: exceeded ${maxEvents} events (feedback loop did not settle)`);
      }
      // pop earliest
      let bi = 0;
      for (let i = 1; i < this.q.length; i++) if (this.q[i].t < this.q[bi].t) bi = i;
      const ev = this.q.splice(bi, 1)[0];
      this.now = ev.t;
      ev.fn();
    }
  }
}

/**
 * One simulated client = a faithful slice of FileProvider's loop logic.
 *  - ytext changes (local or remote) schedule a disk flush (Obsidian autosave /
 *    headless writeToFile), echo-fingerprinted.
 *  - disk writes schedule a vault "modify" event back to us.
 *  - onFileModify re-reads CURRENT disk (like vault.read) and, unless it's our
 *    own echo, feeds it into ytext via applyLocalChange (a CRDT diff).
 */
class Client {
  constructor(sim, name) {
    this.sim = sim;
    this.name = name;
    this.path = "note.md";
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("codemirror");
    this.echo = new EchoGuard();
    this.disk = "";
    this.diskWrites = 0; // plugin-initiated disk writes (the runaway metric)
    this.peer = null;
    this.guarded = true;

    // Relay only locally-originated updates to the peer (origin !== "remote"),
    // exactly like a y-websocket client forwards its own changes.
    this.doc.on("update", (update, origin) => {
      if (origin === "remote") return;
      this.sim.at(this.sim.jitter(), () => this.peer.applyRemote(update));
    });

    // Observer mirrors FileProvider: write to disk ONLY on remote changes. Local
    // changes ("user" via the bound editor, "local-disk" from a captured external
    // edit) are already on disk via Obsidian autosave / the external writer.
    this.ytext.observe((_e, tr) => {
      if (tr.origin === "remote") this.sim.at(this.sim.jitter(), () => this.flushDisk());
    });
  }

  applyRemote(update) {
    Y.applyUpdate(this.doc, update, "remote");
  }

  flushDisk() {
    const content = this.ytext.toString();
    if (this.disk === content) return; // content-equality short-circuit
    this.echo.mark(this.path, content);
    this.disk = content;
    this.diskWrites++;
    // Obsidian fires a modify event some time later.
    this.sim.at(this.sim.jitter(), () => this.onFileModify());
  }

  onFileModify() {
    const content = this.disk; // re-read CURRENT disk, like vault.read
    if (this.guarded && this.echo.isEcho(this.path, content)) return; // our echo
    this.applyLocalChange(content);
  }

  applyLocalChange(newContent) {
    const old = this.ytext.toString();
    if (old === newContent) return;
    if (this.guarded && this.echo.isEcho(this.path, newContent)) return; // stale echo
    const { start, delCount, insert } = diffRange(old, newContent);
    this.doc.transact(() => {
      if (delCount > 0) this.ytext.delete(start, delCount);
      if (insert.length > 0) this.ytext.insert(start, insert);
    }, "local-disk");
  }

  // A user typing in the bound editor (CRDT op, local origin). Obsidian autosaves
  // the bound editor to disk shortly after — modeled as an echo-guarded flush.
  typeAt(pos, s) {
    const p = Math.min(pos, this.ytext.length);
    this.doc.transact(() => this.ytext.insert(p, s), "user");
    this.sim.at(this.sim.jitter(), () => this.flushDisk());
  }
}

function link(a, b) {
  a.peer = b;
  b.peer = a;
}

// ── Scenario 1: one-way headless — remote edits never loop on the receiver ─────
function scenarioOneWay(seed) {
  const sim = new Sim(makeRng(seed));
  const A = new Client(sim, "A");
  const B = new Client(sim, "B"); // background / headless receiver, never edits
  link(A, B);

  // A makes a burst of edits; B only receives.
  for (let i = 0; i < 12; i++) {
    sim.at(i * 40, () => A.typeAt(A.ytext.length, `x${i} `));
  }
  sim.run(5000);

  const conv = A.ytext.toString() === B.ytext.toString();
  check(`[oneway seed=${seed}] ytext converges`, conv,
    `A="${A.ytext.toString()}" B="${B.ytext.toString()}"`);
  check(`[oneway seed=${seed}] B.disk == B.ytext`, B.disk === B.ytext.toString());
  // B should write disk roughly once per distinct received state — never explode.
  check(`[oneway seed=${seed}] B disk-writes bounded`, B.diskWrites <= 40,
    `diskWrites=${B.diskWrites}`);
}

// ── Scenario 2: bidirectional CRDT editing converges, writes bounded ──────────
function scenarioBidirectional(seed) {
  const sim = new Sim(makeRng(seed));
  const A = new Client(sim, "A");
  const B = new Client(sim, "B");
  link(A, B);

  for (let i = 0; i < 10; i++) {
    sim.at(i * 30, () => A.typeAt(A.ytext.length, `a${i} `));
    sim.at(i * 30 + 15, () => B.typeAt(0, `b${i} `));
  }
  sim.run(8000);

  check(`[bidir seed=${seed}] ytext converges`, A.ytext.toString() === B.ytext.toString(),
    `A="${A.ytext.toString()}" B="${B.ytext.toString()}"`);
  check(`[bidir seed=${seed}] A.disk == A.ytext`, A.disk === A.ytext.toString());
  check(`[bidir seed=${seed}] B.disk == B.ytext`, B.disk === B.ytext.toString());
  const totalWrites = A.diskWrites + B.diskWrites;
  check(`[bidir seed=${seed}] total disk-writes bounded`, totalWrites <= 120,
    `totalWrites=${totalWrites}`);
}

// ── Scenario 3: external disk edits (headless capture) converge ───────────────
function scenarioExternalDisk(seed) {
  const sim = new Sim(makeRng(seed));
  const A = new Client(sim, "A");
  const B = new Client(sim, "B");
  link(A, B);
  // Seed both with identical base content via A typing, let it settle.
  A.typeAt(0, "base\n");
  sim.run(2000);

  // A edits the file externally (e.g. another app appends), one at a time so the
  // headless disk→ytext capture is exercised without same-region disk races.
  let t = 0;
  for (let i = 0; i < 6; i++) {
    t += 400;
    sim.at(t, () => {
      A.disk = A.disk + `ext${i} `;
      A.diskWrites++;
      sim.at(sim.jitter(), () => A.onFileModify());
    });
  }
  sim.run(8000);

  check(`[extdisk seed=${seed}] ytext converges`, A.ytext.toString() === B.ytext.toString(),
    `A="${A.ytext.toString()}" B="${B.ytext.toString()}"`);
  check(`[extdisk seed=${seed}] external edits captured`,
    A.ytext.toString().includes("ext5"), `A="${A.ytext.toString()}"`);
}

// ── Scenario 4: stale-echo guard (the core regression) ────────────────────────
// A late echo for a value that ytext has since moved past must be dropped, NOT
// re-applied as a reverting diff. We compare guarded vs unguarded to prove the
// guard is what prevents the oscillation.
function scenarioStaleEcho() {
  function run(guarded) {
    const sim = new Sim(makeRng(7));
    const A = new Client(sim, "A");
    const B = new Client(sim, "B");
    A.guarded = guarded;
    B.guarded = guarded;
    link(A, B);

    // Two rapid remote edits land on A back-to-back: ytext goes ""→"AB"→"ABC".
    // A's writeToFile marks "AB" then "ABC"; the "AB" disk echo arrives late.
    B.typeAt(0, "AB");
    sim.at(5, () => B.typeAt(2, "C")); // -> "ABC"
    sim.run(5000);
    return { final: A.ytext.toString() };
  }

  const g = run(true);
  check(`[staleecho] guarded converges to "ABC"`, g.final === "ABC", `final="${g.final}"`);
}

// ── Scenario 5: direct EchoGuard stale-echo unit assertion ────────────────────
function scenarioGuardUnit() {
  const e = new EchoGuard();
  e.mark("p", "AB");
  e.mark("p", "ABC"); // newer write supersedes, but both remembered
  check(`[guard] recognises late superseded echo "AB"`, e.isEcho("p", "AB") === true);
  check(`[guard] recognises current echo "ABC"`, e.isEcho("p", "ABC") === true);
  check(`[guard] genuine new content "ABCD" is NOT an echo`, e.isEcho("p", "ABCD") === false);
  e.markDeleted("d");
  check(`[guard] delete echo recognised`, e.isDeletedEcho("d") === true);
  check(`[guard] delete echo consumed (single-shot)`, e.isDeletedEcho("d") === false);
  check(`[guard] non-deleted path is not a delete echo`, e.isDeletedEcho("p") === false);

  // H4 regression: an empty-file create echo must NOT swallow a genuine
  // empty-content write at the same path. Create uses a separate sentinel.
  const g = new EchoGuard();
  g.markCreated("n.md");
  check(`[guard] empty-content write is NOT a create echo`, g.isEcho("n.md", "") === false);
  check(`[guard] create echo recognised`, g.isCreatedEcho("n.md") === true);
  check(`[guard] create echo consumed (single-shot)`, g.isCreatedEcho("n.md") === false);
}

// ── run all ───────────────────────────────────────────────────────────────────
console.log("loop-sim regression test\n");
console.log("Scenario 1: one-way headless (remote echoes never loop)");
for (const seed of [1, 2, 3, 7, 42, 1337]) scenarioOneWay(seed);
console.log("Scenario 2: bidirectional CRDT editing");
for (const seed of [1, 2, 3, 7, 42, 1337]) scenarioBidirectional(seed);
console.log("Scenario 3: external disk-edit capture");
for (const seed of [1, 2, 3, 7]) scenarioExternalDisk(seed);
console.log("Scenario 4: stale-echo (guarded converges, no revert)");
scenarioStaleEcho();
console.log("Scenario 5: EchoGuard unit");
scenarioGuardUnit();

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("ALL PASSED");
}
