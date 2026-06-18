/**
 * In-memory fake of the bits of the `obsidian` API that FileProvider/SyncManager
 * touch, so the REAL source can run headless under esbuild alias. The "disk" is a
 * Map; vault events are dispatched to registered listeners.
 */
export class TFile {
  constructor(path, vault) {
    this.path = path;
    this.vault = vault;
    const dot = path.lastIndexOf(".");
    this.extension = dot >= 0 ? path.slice(dot + 1) : "";
    this.name = path.split("/").pop();
    this.stat = { mtime: 0, ctime: 0, size: 0 };
  }
}
export class TFolder {
  constructor(path) { this.path = path; this.children = []; }
}
export class Notice { constructor(_m) {} }
export const Platform = { isMobile: false };
export function normalizePath(p) { return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }

// debounce compatible with Obsidian's (fn, timeout, resetTimer) — uses real timers.
export function debounce(fn, timeout = 0) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, timeout);
  };
  wrapped.cancel = () => { if (t) clearTimeout(t); t = null; };
  return wrapped;
}

class Adapter {
  constructor() { this.files = new Map(); }
  async mkdir() {}
  async write(p, data) { this.files.set(p, data); }
  async read(p) { if (!this.files.has(p)) throw new Error("ENOENT " + p); return this.files.get(p); }
  async remove(p) { this.files.delete(p); }
  async stat(p) { return this.files.has(p) ? { mtime: 0, size: 0, type: "file" } : null; }
  async list(dir) {
    const files = [], folders = new Set();
    for (const k of this.files.keys()) {
      if (k.startsWith(dir + "/")) {
        const rest = k.slice(dir.length + 1);
        if (rest.includes("/")) folders.add(dir + "/" + rest.split("/")[0]);
        else files.push(k);
      }
    }
    return { files, folders: [...folders] };
  }
}

export class Vault {
  constructor() {
    this.tree = new Map();    // path -> TFile|TFolder
    this.content = new Map(); // path -> string
    this.adapter = new Adapter();
    this.listeners = { create: [], modify: [], delete: [], rename: [] };
  }
  on(ev, cb) { this.listeners[ev].push(cb); return { ev, cb }; }
  _emit(ev, ...args) { for (const cb of this.listeners[ev]) cb(...args); }
  getAbstractFileByPath(p) { return this.tree.get(p) || null; }
  async read(file) { return this.content.get(file.path) ?? ""; }
  async readBinary(file) {
    const value = this.content.get(file.path);
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return new TextEncoder().encode(value ?? "").buffer;
  }
  async create(path, data) {
    const f = new TFile(path, this);
    this.tree.set(path, f);
    this.content.set(path, data);
    f.stat.size = typeof data === "string" ? data.length : data?.byteLength || 0;
    this._emit("create", f);
    return f;
  }
  async createBinary(path, data) { return this.create(path, data); }
  async modify(file, data) {
    this.content.set(file.path, data);
    if (file.stat) file.stat.mtime = Date.now();
    if (file.stat) file.stat.size = typeof data === "string" ? data.length : data?.byteLength || 0;
    this._emit("modify", file);
  }
  async modifyBinary(file, data) { await this.modify(file, data); }
  async process(file, fn) {
    const current = await this.read(file);
    const next = fn(current);
    await this.modify(file, next);
    return next;
  }
  async delete(file) {
    this.tree.delete(file.path);
    this.content.delete(file.path);
    this._emit("delete", file);
  }
  async createFolder(path) { this.tree.set(path, new TFolder(path)); }
}

export class App {
  constructor() {
    this.vault = new Vault();
    this.workspace = { getActiveFile: () => null, on: () => ({}), getActiveViewOfType: () => null };
  }
}
