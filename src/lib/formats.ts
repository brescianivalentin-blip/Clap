import type { FormatId } from './types';

export interface FormatInfo {
  id: FormatId;
  label: string;
  hint: string;
  /** width / height */
  aspect: number;
  vertical: boolean;
}

export const FORMATS: Record<FormatId, FormatInfo> = {
  tiktok: { id: 'tiktok', label: 'TikTok', hint: 'Vertical 9:16', aspect: 9 / 16, vertical: true },
  reel: { id: 'reel', label: 'Reel Instagram', hint: 'Vertical 9:16', aspect: 9 / 16, vertical: true },
  youtube: { id: 'youtube', label: 'YouTube', hint: 'Horizontal 16:9', aspect: 16 / 9, vertical: false },
};

export const FORMAT_LIST: FormatInfo[] = [FORMATS.tiktok, FORMATS.reel, FORMATS.youtube];

export type ExportResolution = '1080' | '4k';

export function outputSize(format: FormatId, res: ExportResolution): [number, number] {
  const long = res === '4k' ? 3840 : 1920;
  const short = res === '4k' ? 2160 : 1080;
  return FORMATS[format].vertical ? [short, long] : [long, short];
}
