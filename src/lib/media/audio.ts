import type { MediaItem } from '../types';
import { readFile } from '../storage/opfs';

export const SAMPLE_RATE = 48000;

let decodeCtx: OfflineAudioContext | null = null;

function getDecodeCtx(): OfflineAudioContext {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  return decodeCtx;
}

export function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = getDecodeCtx();
  return new Promise<AudioBuffer>((resolve, reject) => {
    // Old Safari only supports the callback form.
    const p = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('decode failed')));
    if (p && typeof (p as Promise<AudioBuffer>).then === 'function') (p as Promise<AudioBuffer>).then(resolve, reject);
  });
}

export function createBuffer(channels: number, length: number, sampleRate = SAMPLE_RATE): AudioBuffer {
  return getDecodeCtx().createBuffer(channels, Math.max(1, length), sampleRate);
}

/** Path of the audio we decode for a media item. */
export function audioPathFor(m: MediaItem): string {
  return m.kind === 'audio' ? `media/${m.id}` : `audio/${m.id}`;
}

const buffers = new Map<string, Promise<AudioBuffer | null>>();
const ready = new Map<string, AudioBuffer>();

export function getAudioBuffer(m: MediaItem): Promise<AudioBuffer | null> {
  if (!m.hasAudio) return Promise.resolve(null);
  let p = buffers.get(m.id);
  if (!p) {
    p = (async () => {
      const file = await readFile(audioPathFor(m));
      const buf = await decodeAudio(await file.arrayBuffer());
      ready.set(m.id, buf);
      return buf;
    })().catch((err) => {
      console.warn('audio decode failed', m.name, err);
      buffers.delete(m.id);
      return null;
    });
    buffers.set(m.id, p);
  }
  return p;
}

export function setDecodedBuffer(id: string, buf: AudioBuffer) {
  buffers.set(id, Promise.resolve(buf));
  ready.set(id, buf);
}

// ---- Time stretching (runs in a worker) ----

let stretchWorker: Worker | null = null;
let stretchSeq = 0;
const stretchPending = new Map<number, { resolve: (c: Float32Array[]) => void; reject: (e: Error) => void }>();

function worker(): Worker {
  if (!stretchWorker) {
    stretchWorker = new Worker(new URL('./stretch-worker.ts', import.meta.url), { type: 'module' });
    stretchWorker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; channels?: Float32Array[]; error?: string }>) => {
      const p = stretchPending.get(e.data.id);
      if (!p) return;
      stretchPending.delete(e.data.id);
      if (e.data.ok && e.data.channels) p.resolve(e.data.channels);
      else p.reject(new Error(e.data.error));
    };
  }
  return stretchWorker;
}

function runStretch(buf: AudioBuffer, speed: number): Promise<AudioBuffer> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  const id = ++stretchSeq;
  return new Promise<Float32Array[]>((resolve, reject) => {
    stretchPending.set(id, { resolve, reject });
    worker().postMessage({ id, channels, sampleRate: buf.sampleRate, speed }, channels.map((c) => c.buffer));
  }).then((out) => {
    const b = createBuffer(out.length, out[0].length, buf.sampleRate);
    out.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return b;
  });
}

const stretched = new Map<string, Promise<AudioBuffer | null>>();
const stretchedReady = new Map<string, AudioBuffer>();
const speedKey = (id: string, speed: number) => `${id}@${speed.toFixed(3)}`;

/** The buffer to play for a media at a given speed (pitch preserved). */
export function getPlaybackBuffer(m: MediaItem, speed: number): Promise<AudioBuffer | null> {
  if (Math.abs(speed - 1) < 1e-3) return getAudioBuffer(m);
  const key = speedKey(m.id, speed);
  let p = stretched.get(key);
  if (!p) {
    p = getAudioBuffer(m)
      .then((b) => (b ? runStretch(b, speed) : null))
      .then((b) => {
        if (b) stretchedReady.set(key, b);
        return b;
      })
      .catch((e) => {
        console.warn('stretch failed', e);
        stretched.delete(key);
        return null;
      });
    stretched.set(key, p);
  }
  return p;
}

/** Synchronous access to an already prepared buffer. */
export function playbackBufferNow(mediaId: string, speed: number): AudioBuffer | null {
  if (Math.abs(speed - 1) < 1e-3) return ready.get(mediaId) ?? null;
  return stretchedReady.get(speedKey(mediaId, speed)) ?? null;
}

// ---- Waveform ----

export const PEAKS_PER_SECOND = 50;

export function computePeaks(buf: AudioBuffer): Uint8Array {
  const n = Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SECOND));
  const peaks = new Uint8Array(n);
  const step = buf.length / n;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  let max = 0;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s0 = Math.floor(i * step);
    const s1 = Math.min(buf.length, Math.floor((i + 1) * step));
    let m = 0;
    for (const ch of chans) for (let s = s0; s < s1; s += 4) m = Math.max(m, Math.abs(ch[s]));
    raw[i] = m;
    max = Math.max(max, m);
  }
  const k = max > 0 ? 1 / max : 0;
  for (let i = 0; i < n; i++) peaks[i] = Math.round(Math.sqrt(raw[i] * k) * 255);
  return peaks;
}
