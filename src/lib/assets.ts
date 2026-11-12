import { useEffect, useState } from 'react';
import { getAsset } from './storage/db';
import type { ThumbSheet } from './media/importer';

export interface LoadedThumbs {
  sheet: ThumbSheet;
  img: HTMLImageElement;
  url: string;
}

const thumbCache = new Map<string, Promise<LoadedThumbs | null>>();
const peakCache = new Map<string, Promise<Uint8Array | null>>();

export function loadThumbs(mediaId: string): Promise<LoadedThumbs | null> {
  let p = thumbCache.get(mediaId);
  if (!p) {
    p = (async () => {
      const sheet = await getAsset<ThumbSheet>(`thumbs:${mediaId}`);
      if (!sheet) return null;
      const url = URL.createObjectURL(sheet.blob);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {});
      return { sheet, img, url };
    })();
    thumbCache.set(mediaId, p);
  }
  return p;
}

export function loadPeaks(mediaId: string): Promise<Uint8Array | null> {
  let p = peakCache.get(mediaId);
  if (!p) {
    p = getAsset<Uint8Array>(`peaks:${mediaId}`).then((v) => v ?? null);
    peakCache.set(mediaId, p);
  }
  return p;
}

export function useThumbs(mediaId: string | undefined): LoadedThumbs | null {
  const [v, setV] = useState<LoadedThumbs | null>(null);
  useEffect(() => {
    let alive = true;
    if (mediaId) void loadThumbs(mediaId).then((t) => alive && setV(t));
    return () => {
      alive = false;
    };
  }, [mediaId]);
  return v;
}

export function usePeaks(mediaId: string | undefined): Uint8Array | null {
  const [v, setV] = useState<Uint8Array | null>(null);
  useEffect(() => {
    let alive = true;
    if (mediaId) void loadPeaks(mediaId).then((t) => alive && setV(t));
    return () => {
      alive = false;
    };
  }, [mediaId]);
  return v;
}

/** CSS background for thumbnail `index` of a sheet, displayed at `size` px. */
export function thumbStyle(t: LoadedThumbs, index: number, size: number): React.CSSProperties {
  const { cols, count } = t.sheet;
  const i = Math.max(0, Math.min(count - 1, index));
  const rows = Math.ceil(count / cols);
  const usedCols = Math.min(count, cols);
  return {
    backgroundImage: `url(${t.url})`,
    backgroundSize: `${usedCols * size}px ${rows * size}px`,
    backgroundPosition: `${-(i % cols) * size}px ${-Math.floor(i / cols) * size}px`,
  };
}

/** Snapshot of the preview saved when leaving a project, used as its cover. */
export function useCover(projectId: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let u: string | null = null;
    void getAsset<Blob>(`cover:${projectId}`).then((b) => {
      if (!alive || !b) return;
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [projectId]);
  return url;
}
