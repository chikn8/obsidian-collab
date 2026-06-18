/**
 * In-memory fake of y-indexeddb. Persists each doc's state under its db name so a
 * provider restart (offline-then-reopen) rehydrates — exactly what the real IDB
 * layer does. whenSynced resolves after the stored state is applied.
 */
import * as Y from "yjs";

const STORE = new Map(); // dbName -> Uint8Array (last persisted state)

export class IndexeddbPersistence {
  constructor(name, doc) {
    this.name = name;
    this.doc = doc;
    this._synced = false;
    this.whenSynced = (async () => {
      const saved = STORE.get(name);
      if (saved) Y.applyUpdate(doc, saved, "idb");
      this._synced = true;
      this._onUpdate = () => { STORE.set(name, Y.encodeStateAsUpdate(doc)); };
      doc.on("update", this._onUpdate);
      return this;
    })();
  }
  on() {}
  async clearData() { STORE.delete(this.name); }
  destroy() { if (this._onUpdate) this.doc.off("update", this._onUpdate); }
}

// test helper
export function __resetIdb() { STORE.clear(); }
