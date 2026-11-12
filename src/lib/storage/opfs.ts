// File storage for imported media and exports.
// Uses the Origin Private File System when available (persistent, disk backed),
// and falls back to memory (lost on reload) otherwise.

let worker: Worker | null = null;
let seq = 0;
let hidSeq = 0;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
const memory = new Map<string, Blob>();
let mode: 'opfs' | 'memory' | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./opfs-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve();
      else p.reject(new Error(e.data.error));
    };
  }
  return worker;
}

function call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function resolve(path: string): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let dir = await root();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return { dir, name };
}

let modePromise: Promise<'opfs' | 'memory'> | null = null;

/** Detects once whether OPFS writes work (they don't in some private browsing modes). */
export function storageMode(): Promise<'opfs' | 'memory'> {
  if (!modePromise) {
    modePromise = (async () => {
      const probe = `.probe-${Math.random().toString(36).slice(2)}`;
      try {
        if (!navigator.storage?.getDirectory || typeof Worker === 'undefined') throw new Error('no opfs');
        const w = await FileWriter.open(probe, true);
        await w.write(new Uint8Array([1, 2, 3]).buffer, 0);
        await w.close();
        const f = await readFile(probe, true);
        if (f.size !== 3) throw new Error('probe mismatch');
        await deletePath(probe, true);
        mode = 'opfs';
      } catch (e) {
        console.warn('OPFS unavailable, using memory storage', e);
        mode = 'memory';
      }
      return mode;
    })();
  }
  return modePromise;
}

export class FileWriter {
  private hid: number;
  private path: string;
  private chunks: { at: number; data: ArrayBuffer }[] | null;

  private constructor(hid: number, path: string, chunks: { at: number; data: ArrayBuffer }[] | null) {
    this.hid = hid;
    this.path = path;
    this.chunks = chunks;
  }

  static async open(path: string, forceOpfs = false): Promise<FileWriter> {
    if (!forceOpfs && mode === 'memory') return new FileWriter(0, path, []);
    const hid = ++hidSeq;
    await call({ op: 'open', hid, path });
    return new FileWriter(hid, path, null);
  }

  /** Takes ownership of `data` (it is transferred). */
  async write(data: ArrayBuffer, at: number): Promise<void> {
    if (this.chunks) {
      this.chunks.push({ at, data });
      return;
    }
    await call({ op: 'write', hid: this.hid, data, at }, [data]);
  }

  async close(): Promise<void> {
    if (this.chunks) {
      // Assemble positioned chunks (memory mode only).
      const size = this.chunks.reduce((m, c) => Math.max(m, c.at + c.data.byteLength), 0);
      const buf = new Uint8Array(size);
      for (const c of this.chunks) buf.set(new Uint8Array(c.data), c.at);
      memory.set(this.path, new Blob([buf]));
      this.chunks = null;
      return;
    }
    await call({ op: 'close', hid: this.hid });
  }

  async abort(): Promise<void> {
    if (this.chunks) {
      this.chunks = null;
      return;
    }
    await call({ op: 'abort', hid: this.hid }).catch(() => {});
    await deletePath(this.path).catch(() => {});
  }
}

/** Copies a blob into storage, reporting progress between 0 and 1. */
export async function writeBlob(path: string, blob: Blob, onProgress?: (p: number) => void): Promise<void> {
  if ((await storageMode()) === 'memory') {
    memory.set(path, blob);
    onProgress?.(1);
    return;
  }
  const w = await FileWriter.open(path);
  const CHUNK = 8 * 1024 * 1024;
  try {
    for (let off = 0; off < blob.size; off += CHUNK) {
      const buf = await blob.slice(off, off + CHUNK).arrayBuffer();
      await w.write(buf, off);
      onProgress?.(Math.min(1, (off + CHUNK) / blob.size));
    }
    await w.close();
  } catch (e) {
    await w.abort();
    throw e;
  }
}

export async function readFile(path: string, forceOpfs = false): Promise<File> {
  if (!forceOpfs && mode === 'memory') {
    const b = memory.get(path);
    if (!b) throw new Error(`Fichier introuvable : ${path}`);
    return b instanceof File ? b : new File([b], path.split('/').pop() ?? 'file');
  }
  const { dir, name } = await resolve(path);
  const fh = await dir.getFileHandle(name);
  return fh.getFile();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function deletePath(path: string, forceOpfs = false): Promise<void> {
  if (!forceOpfs && mode === 'memory') {
    memory.delete(path);
    return;
  }
  try {
    const { dir, name } = await resolve(path);
    await dir.removeEntry(name, { recursive: true });
  } catch {
    /* already gone */
  }
}

/** A WritableStream suitable for Mediabunny's StreamTarget (positioned writes). */
export function createPositionedStream(writer: FileWriter): WritableStream<{ type: 'write'; data: Uint8Array; position: number }> {
  return new WritableStream({
    async write(chunk) {
      const copy = chunk.data.slice();
      await writer.write(copy.buffer, chunk.position);
    },
    async close() {
      await writer.close();
    },
    async abort() {
      await writer.abort();
    },
  });
}

export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
