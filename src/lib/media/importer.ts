import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  type InputVideoTrack,
} from 'mediabunny';
import type { MediaItem, MediaKind } from '../types';
import { baseName, clamp, uid } from '../util';
import { deletePath, readFile, writeBlob } from '../storage/opfs';
import { putAsset, putMedia } from '../storage/db';
import { computePeaks, decodeAudio, setDecodedBuffer } from './audio';
import { loadBitmap } from './sources';

export interface ThumbSheet {
  blob: Blob;
  count: number;
  /** Seconds of source covered by each thumbnail. */
  interval: number;
  cols: number;
  size: number;
}

export type ImportStage = 'copy' | 'analyze' | 'thumbs' | 'audio';

export class ImportError extends Error {}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|aac|caf|aif|aiff|flac|ogg|opus)$/i;
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|avif)$/i;

export function detectKind(file: File): MediaKind | null {
  const t = file.type;
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

const THUMB = 112;

function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.78): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), type, q));
}

async function makeVideoThumbs(vt: InputVideoTrack, duration: number, onProgress: (p: number) => void): Promise<ThumbSheet> {
  const count = clamp(Math.round(duration), 1, 120);
  const interval = duration / count;
  const packets = new EncodedPacketSink(vt);
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.01, (i + 0.5) * interval);
    // Key frames decode on their own: much faster for long camera files.
    const key = await packets.getKeyPacket(t, { metadataOnly: true }).catch(() => null);
    times.push(key && t - key.timestamp < interval * 1.5 ? key.timestamp : t);
  }
  const cols = 10;
  const sheet = document.createElement('canvas');
  sheet.width = Math.min(count, cols) * THUMB;
  sheet.height = Math.ceil(count / cols) * THUMB;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#1c1c22';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  const sink = new CanvasSink(vt, { width: THUMB, height: THUMB, fit: 'cover', poolSize: 1 });
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (wc) ctx.drawImage(wc.canvas, (i % cols) * THUMB, Math.floor(i / cols) * THUMB);
    i++;
    onProgress(i / count);
  }
  return { blob: await canvasToBlob(sheet), count, interval, cols, size: THUMB };
}

async function makeImageThumb(bmp: ImageBitmap): Promise<ThumbSheet> {
  const c = document.createElement('canvas');
  c.width = THUMB;
  c.height = THUMB;
  const ctx = c.getContext('2d')!;
  const s = Math.max(THUMB / bmp.width, THUMB / bmp.height);
  const w = bmp.width * s;
  const h = bmp.height * s;
  ctx.drawImage(bmp, (THUMB - w) / 2, (THUMB - h) / 2, w, h);
  return { blob: await canvasToBlob(c), count: 1, interval: 1, cols: 1, size: THUMB };
}

/** Copies the audio track of a video into a small .m4a without re-encoding. */
async function extractAudio(input: Input, id: string): Promise<boolean> {
  try {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conv = await Conversion.init({ input, output, tracks: 'primary', video: { discard: true }, showWarnings: false });
    if (!conv.isValid) return false;
    await conv.execute();
    const buf = output.target.buffer;
    if (!buf) return false;
    await writeBlob(`audio/${id}`, new Blob([buf], { type: 'audio/mp4' }));
    return true;
  } catch (e) {
    console.warn('audio extraction failed', e);
    return false;
  }
}

export async function importFile(
  file: File,
  projectId: string,
  onProgress: (stage: ImportStage, p: number) => void,
  libraryId?: string,
): Promise<MediaItem> {
  let kind = detectKind(file);
  if (!kind) throw new ImportError(`« ${file.name} » n'est pas un fichier vidéo, photo ou audio.`);
  const id = uid();
  const media: MediaItem = {
    id,
    projectId,
    kind,
    name: baseName(file.name),
    mime: file.type,
    size: file.size,
    duration: 0,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: false,
    createdAt: Date.now(),
    libraryId,
  };
  try {
    await writeBlob(`media/${id}`, file, (p) => onProgress('copy', p));
    const stored = await readFile(`media/${id}`);
    onProgress('analyze', 0);
    let audioBuffer: AudioBuffer | null = null;

    if (kind === 'image') {
      const bmp = await loadBitmap(stored).catch(() => {
        throw new ImportError(`Impossible de lire la photo « ${file.name} ».`);
      });
      media.width = bmp.width;
      media.height = bmp.height;
      await putAsset(`thumbs:${id}`, await makeImageThumb(bmp));
      bmp.close();
    } else if (kind === 'video') {
      const input = new Input({ source: new BlobSource(stored), formats: ALL_FORMATS });
      try {
        if (!(await input.canRead())) throw new ImportError(`Le format de « ${file.name} » n'est pas pris en charge.`);
        const vt = await input.getPrimaryVideoTrack();
        const at = await input.getPrimaryAudioTrack();
        if (!vt) {
          if (!at) throw new ImportError(`« ${file.name} » ne contient ni image ni son.`);
          kind = media.kind = 'audio';
        } else {
          if (!(await vt.canDecode())) {
            throw new ImportError(`Cet appareil ne sait pas lire la vidéo « ${file.name} » (codec ${vt.codec ?? 'inconnu'}).`);
          }
          media.duration = await input.computeDuration([vt]);
          media.width = await vt.getDisplayWidth();
          media.height = await vt.getDisplayHeight();
          try {
            media.fps = Math.round((await vt.computeFrameRateMetrics({ targetPacketCount: 60 })).bestGuessFrameRate);
          } catch {
            media.fps = 30;
          }
          onProgress('thumbs', 0);
          await putAsset(`thumbs:${id}`, await makeVideoThumbs(vt, media.duration, (p) => onProgress('thumbs', p)));
          if (at) {
            onProgress('audio', 0);
            if (await extractAudio(input, id)) {
              const f = await readFile(`audio/${id}`);
              audioBuffer = await decodeAudio(await f.arrayBuffer()).catch(() => null);
            }
          }
        }
      } finally {
        input.dispose();
      }
    }

    if (kind === 'audio') {
      onProgress('audio', 0);
      audioBuffer = await decodeAudio(await stored.arrayBuffer()).catch(() => {
        throw new ImportError(`Impossible de lire le son « ${file.name} ».`);
      });
      media.duration = audioBuffer.duration;
    }

    if (audioBuffer) {
      media.hasAudio = true;
      setDecodedBuffer(id, audioBuffer);
      await putAsset(`peaks:${id}`, computePeaks(audioBuffer));
    }
    onProgress('audio', 1);
    await putMedia(media);
    return media;
  } catch (e) {
    await deletePath(`media/${id}`);
    await deletePath(`audio/${id}`);
    if (e instanceof ImportError) throw e;
    console.error(e);
    throw new ImportError(`Import impossible pour « ${file.name} ».`);
  }
}
