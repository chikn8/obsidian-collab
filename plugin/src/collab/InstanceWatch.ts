import { App, Notice } from "obsidian";
import { err, log } from "../utils/log";
import { pluginDataPath } from "../utils/pluginPaths";

const HEARTBEAT_MS = 30_000;
const FRESH_MS = 75_000; // an instance is "live" if its heartbeat is this recent

/**
 * Detects a second Obsidian instance holding the SAME vault on disk (two app
 * windows / processes pointing at one folder). EchoGuard already makes the two
 * converge safely — this is just a heads-up so the user knows why they might see
 * extra sync churn. Cross-process safe: each instance heartbeats its own file in
 * a shared vault dir and watches for any OTHER fresh heartbeat.
 */
export class InstanceWatch {
  private app: App;
  private id: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;
  private registerInterval: (id: number) => void;

  constructor(app: App, registerInterval: (id: number) => void) {
    this.app = app;
    this.id = (globalThis.crypto?.randomUUID?.() as string) || `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.registerInterval = registerInterval;
  }

  private dir(): string {
    return pluginDataPath(this.app, "instances");
  }

  async start(): Promise<void> {
    await this.beat();
    await this.check();
    this.timer = setInterval(() => {
      this.beat().then(() => this.check()).catch((e) => err("loop", "instance watch heartbeat failed", e));
    }, HEARTBEAT_MS);
    this.registerInterval(this.timer as unknown as number);
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { await this.app.vault.adapter.remove(`${this.dir()}/${this.id}.json`); } catch { /* ignore */ }
  }

  private async beat(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.dir();
    await adapter.mkdir(dir).catch((e) => err("loop", "instance watch mkdir failed", e));
    await adapter.write(`${dir}/${this.id}.json`, JSON.stringify({ ts: Date.now() })).catch((e) => err("loop", "instance watch write failed", e));
  }

  private async check(): Promise<void> {
    const adapter = this.app.vault.adapter;
    let others = 0;
    try {
      const listing = await adapter.list(this.dir());
      const now = Date.now();
      for (const f of listing.files) {
        if (f.endsWith(`${this.id}.json`)) continue;
        try {
          const stat = await adapter.stat(f);
          if (stat && now - stat.mtime > FRESH_MS) {
            await adapter.remove(f).catch((e) => log("loop", "stale instance reap failed", f, e));
            continue;
          }
          others++;
        } catch (e) {
          log("loop", "instance watch stat failed", f, e);
        }
      }
    } catch (e) {
      log("loop", "instance watch list failed", e);
      return;
    }

    if (others > 0 && !this.warned) {
      this.warned = true;
      log("loop", "another Obsidian instance detected on this vault");
      new Notice(
        "Heads up: this vault looks open in another Obsidian instance. Collab edits still merge safely, but close one to avoid extra sync churn.",
        12000
      );
    } else if (others === 0) {
      this.warned = false; // allow a fresh warning if another instance returns
    }
  }
}
