// Writes files into the Origin Private File System. Safari only supports
// synchronous access handles (inside a worker) for writing, so all writes go through here.

interface SyncHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type Req =
  | { id: number; op: 'open'; hid: number; path: string }
  | { id: number; op: 'write'; hid: number; data: ArrayBuffer; at: number }
  | { id: number; op: 'close'; hid: number }
  | { id: number; op: 'abort'; hid: number };

const handles = new Map<number, SyncHandle>();

async function fileHandle(path: string): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir.getFileHandle(name, { create: true });
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.op === 'open') {
      const fh = await fileHandle(m.path);
      const h = (await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
      h.truncate(0);
      handles.set(m.hid, h);
    } else if (m.op === 'write') {
      const h = handles.get(m.hid);
      if (!h) throw new Error('Fichier non ouvert');
      const bytes = new Uint8Array(m.data);
      let off = 0;
      while (off < bytes.length) {
        const n = h.write(bytes.subarray(off), { at: m.at + off });
        if (n <= 0) throw new Error("Écriture impossible (stockage plein ?)");
        off += n;
      }
    } else if (m.op === 'close' || m.op === 'abort') {
      const h = handles.get(m.hid);
      if (h) {
        if (m.op === 'close') h.flush();
        h.close();
        handles.delete(m.hid);
      }
    }
    (self as unknown as Worker).postMessage({ id: m.id, ok: true });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
