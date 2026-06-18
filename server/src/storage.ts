import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

export type AtomicData = string | Uint8Array | Buffer;

export async function atomicWriteFile(filePath: string, data: AtomicData, encoding?: BufferEncoding): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`
  );

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, "w");
    if (typeof data === "string") await handle.writeFile(data, encoding || "utf-8");
    else await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;

    await fs.rename(tmpPath, filePath);
    await fs.open(dir, "r")
      .then(async (dirHandle) => {
        try { await dirHandle.sync(); }
        finally { await dirHandle.close(); }
      })
      .catch(() => {});
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
}
