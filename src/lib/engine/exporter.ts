import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import type { MediaItem, Project, VideoClip } from '../types';
import { outputSize, type ExportResolution } from '../formats';
import { projectDuration, sourceTime, videoLayout } from '../timeline';
import { uid } from '../util';
import { SAMPLE_RATE, createBuffer } from '../media/audio';
import { getImage, getVideoSource } from '../media/sources';
import { FileWriter, createPositionedStream, deletePath, readFile, storageMode } from '../storage/opfs';
import { collectSegments, createMasterBus, prepareSegments, scheduleSegments } from './audioGraph';
import { drawComposite, type FrameSource } from './render';
import { ensureFonts } from './fonts';
import type { Ctx2D } from './text';

export interface ExportSettings {
  resolution: ExportResolution;
  fps: 30 | 60;
}

export interface ExportProgress {
  phase: 'prepare' | 'audio' | 'video' | 'finalize';
  progress: number;
  eta?: number;
}

export function videoBitrate(resolution: ExportResolution, fps: number): number {
  const base = resolution === '4k' ? 40_000_000 : 12_000_000;
  return fps > 30 ? Math.round(base * 1.5) : base;
}

export function estimateSize(duration: number, s: ExportSettings): number {
  return ((videoBitrate(s.resolution, s.fps) + 192_000) * duration) / 8;
}

let aacPolyfill = false;

async function ensureAac() {
  if (aacPolyfill) return;
  const native = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: 192_000 }).catch(() => false);
  if (native) return;
  const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
  registerAacEncoder();
  aacPolyfill = true;
}

async function renderMix(project: Project, media: Map<string, MediaItem>, duration: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const segs = collectSegments(project, media);
  await prepareSegments(segs, media);
  const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OAC(2, length, SAMPLE_RATE);
  const bus = createMasterBus(ctx);
  bus.output.connect(ctx.destination);
  scheduleSegments(ctx, bus.input, segs, 0, 0, duration);
  return new Promise<AudioBuffer>((resolve, reject) => {
    ctx.oncomplete = (e) => resolve(e.renderedBuffer);
    const p = ctx.startRendering();
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

function slice(buf: AudioBuffer, from: number, to: number): AudioBuffer {
  const out = createBuffer(buf.numberOfChannels, to - from, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(from, to), c);
  return out;
}

function fileName(project: Project): string {
  const clean = project.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'video';
  return `${clean}.mp4`;
}

export async function exportProject(
  project: Project,
  media: Map<string, MediaItem>,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<File> {
  onProgress({ phase: 'prepare', progress: 0 });
  await ensureFonts();
  const [W, H] = outputSize(project.format, settings.resolution);
  const fps = settings.fps;
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('Le projet est vide.');
  const bitrate = videoBitrate(settings.resolution, fps);

  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, bitrate });
  if (!codec) {
    throw new Error(
      settings.resolution === '4k'
        ? "Cet appareil ne peut pas exporter en 4K. Essaie en 1080p."
        : "Cet appareil ne parvient pas à encoder la vidéo.",
    );
  }
  await ensureAac();

  const opfs = (await storageMode()) === 'opfs';
  let writer: FileWriter | null = null;
  const path = `exports/${uid()}.mp4`;
  let output: Output;
  if (opfs) {
    await deletePath('exports');
    writer = await FileWriter.open(path);
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(createPositionedStream(writer) as WritableStream, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
    });
  } else {
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  }

  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d', { alpha: false }) as Ctx2D | null;
  if (!ctx) throw new Error('Canvas indisponible');

  const videoSource = new CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = new AudioBufferSource({ codec: 'aac', bitrate: 192_000 });
  output.addAudioTrack(audioSource);

  let wakeLock: { release(): Promise<void> } | null = null;
  try {
    wakeLock = (await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    /* not available */
  }

  try {
    await output.start();
    onProgress({ phase: 'audio', progress: 0 });
    const mix = await renderMix(project, media, duration);

    let audioPos = 0;
    const pushAudio = async (until: number) => {
      const target = Math.min(mix.length, Math.round(until * SAMPLE_RATE));
      while (audioPos < target) {
        const end = Math.min(target, audioPos + SAMPLE_RATE);
        await audioSource.add(slice(mix, audioPos, end));
        audioPos = end;
      }
    };

    const total = Math.max(1, Math.round(duration * fps));
    const started = performance.now();
    let done = 0;
    const renderFrame = async (i: number, frame: FrameSource | null, clip: VideoClip | null) => {
      if (signal.aborted) throw new DOMException('Export annulé', 'AbortError');
      const t = i / fps;
      drawComposite(ctx, W, H, project, t, frame, clip);
      await videoSource.add(t, 1 / fps);
      done++;
      if (done % 4 === 0 || done === total) {
        const prog = done / total;
        const elapsed = (performance.now() - started) / 1000;
        onProgress({ phase: 'video', progress: prog, eta: prog > 0.03 ? elapsed / prog - elapsed : undefined });
      }
      if (done % fps === 0) await pushAudio(t + 1);
    };

    let next = 0;
    for (const slot of videoLayout(project)) {
      const a = Math.max(next, Math.ceil(slot.start * fps - 1e-6));
      const b = Math.min(total, Math.ceil(slot.end * fps - 1e-6));
      if (b <= a) continue;
      if (slot.clip.kind === 'image') {
        const bitmap = await getImage(slot.clip.mediaId);
        for (let k = a; k < b; k++) await renderFrame(k, { type: 'bitmap', bitmap }, slot.clip);
      } else {
        const src = await getVideoSource(slot.clip.mediaId);
        const sink = new VideoSampleSink(src.track);
        const times: number[] = [];
        for (let k = a; k < b; k++) times.push(sourceTime(slot, k / fps));
        let k = a;
        for await (const sample of sink.samplesAtTimestamps(times)) {
          try {
            await renderFrame(k, sample ? { type: 'sample', sample } : null, slot.clip);
          } finally {
            sample?.close();
          }
          k++;
        }
      }
      next = b;
    }
    for (let k = next; k < total; k++) await renderFrame(k, null, null);
    await pushAudio(duration + 1);

    onProgress({ phase: 'finalize', progress: 1 });
    videoSource.close();
    audioSource.close();
    await output.finalize();

    const name = fileName(project);
    if (opfs) {
      const stored = await readFile(path);
      return new File([stored], name, { type: 'video/mp4' });
    }
    const buf = (output.target as BufferTarget).buffer;
    if (!buf) throw new Error('Export vide');
    return new File([buf], name, { type: 'video/mp4' });
  } catch (e) {
    await output.cancel().catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    throw e;
  } finally {
    await wakeLock?.release().catch(() => {});
  }
}

export async function shareFile(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  downloadFile(file);
  return 'downloaded';
}

export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
