export type FormatId = 'tiktok' | 'reel' | 'youtube';

export type MediaKind = 'video' | 'image' | 'audio';

export interface MediaItem {
  id: string;
  projectId: string;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number;
  /** Seconds. 0 for images. */
  duration: number;
  /** Display size (rotation applied). 0 for audio. */
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  createdAt: number;
  libraryId?: string;
}

export interface Framing {
  mode: 'fill' | 'fit';
  /** User zoom, multiplies the base fill/fit scale. */
  scale: number;
  /** Offset of the image centre, as a fraction of the output width / height. */
  x: number;
  y: number;
  /** Extra rotation in degrees (0, 90, 180, 270). */
  rotation: number;
}

export interface VideoClip {
  id: string;
  mediaId: string;
  kind: 'video' | 'image';
  /** Source in / out points in seconds. For images, in = 0 and out = displayed duration. */
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  audioDetached: boolean;
  fadeIn: number;
  fadeOut: number;
  framing: Framing;
}

export type AudioRole = 'music' | 'import' | 'extracted';

export interface AudioClip {
  id: string;
  mediaId: string;
  role: AudioRole;
  lane: number;
  /** Timeline start in seconds. */
  start: number;
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
}

export type TextStyle = 'plain' | 'outline' | 'background' | 'shadow';
export type TextAlign = 'left' | 'center' | 'right';

export interface TextClip {
  id: string;
  lane: number;
  start: number;
  duration: number;
  text: string;
  font: string;
  color: string;
  style: TextStyle;
  /** Font size as a fraction of the shorter side of the output frame. */
  size: number;
  /** Centre position as a fraction of output width / height. */
  x: number;
  y: number;
  /** Radians. */
  rotation: number;
  align: TextAlign;
}

export interface Project {
  id: string;
  name: string;
  format: FormatId;
  createdAt: number;
  updatedAt: number;
  video: VideoClip[];
  audio: AudioClip[];
  texts: TextClip[];
  version: 1;
}

export type Selection =
  | { type: 'video'; id: string }
  | { type: 'audio'; id: string }
  | { type: 'text'; id: string };
