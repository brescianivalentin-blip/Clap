import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack } from 'mediabunny';
import { readFile } from '../storage/opfs';

export interface VideoSourceEntry {
  input: Input;
  track: InputVideoTrack;
  /** Sink tuned for interactive preview. */
  sink: VideoSampleSink;
}

const videoSources = new Map<string, Promise<VideoSourceEntry>>();

export function getVideoSource(mediaId: string): Promise<VideoSourceEntry> {
  let p = videoSources.get(mediaId);
  if (!p) {
    p = (async () => {
      const file = await readFile(`media/${mediaId}`);
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('Pas de piste vidéo');
      const sink = new VideoSampleSink(track, { optimizeForLatency: true });
      return { input, track, sink };
    })();
    p.catch(() => videoSources.delete(mediaId));
    videoSources.set(mediaId, p);
  }
  return p;
}

const images = new Map<string, Promise<ImageBitmap>>();
const imagesReady = new Map<string, ImageBitmap>();
const MAX_IMAGE_SIDE = 4096;

export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Fallback through an <img> element (wider format support on some Safari versions).
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bmp = await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  if (scale >= 1) return bmp;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return createImageBitmap(c);
}

export function getImage(mediaId: string): Promise<ImageBitmap> {
  let p = images.get(mediaId);
  if (!p) {
    p = readFile(`media/${mediaId}`)
      .then(loadBitmap)
      .then((b) => {
        imagesReady.set(mediaId, b);
        return b;
      });
    p.catch(() => images.delete(mediaId));
    images.set(mediaId, p);
  }
  return p;
}

export function imageNow(mediaId: string): ImageBitmap | null {
  return imagesReady.get(mediaId) ?? null;
}

/** Releases decoders and cached images (when leaving a project). */
export function disposeSources() {
  for (const p of videoSources.values()) p.then((s) => s.input.dispose()).catch(() => {});
  videoSources.clear();
  for (const b of imagesReady.values()) b.close();
  images.clear();
  imagesReady.clear();
}
