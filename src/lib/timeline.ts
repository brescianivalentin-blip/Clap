import type { AudioClip, AudioRole, Framing, MediaItem, Project, Selection, TextClip, VideoClip } from './types';
import { FORMATS } from './formats';
import { clamp, uid } from './util';

/** Shortest clip allowed on the timeline, in seconds. */
export const MIN_CLIP = 0.1;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 5;
export const DEFAULT_IMAGE_DURATION = 3;
export const MAX_IMAGE_DURATION = 60;

export const clipDuration = (c: { in: number; out: number; speed: number }) => (c.out - c.in) / c.speed;
export const audioEnd = (a: AudioClip) => a.start + clipDuration(a);
export const textEnd = (t: TextClip) => t.start + t.duration;

export interface VideoSlot {
  clip: VideoClip;
  index: number;
  start: number;
  end: number;
}

export function videoLayout(p: Project): VideoSlot[] {
  let t = 0;
  return p.video.map((clip, index) => {
    const d = clipDuration(clip);
    const slot = { clip, index, start: t, end: t + d };
    t += d;
    return slot;
  });
}

export function videoEnd(p: Project): number {
  let t = 0;
  for (const c of p.video) t += clipDuration(c);
  return t;
}

/** The video track defines the length of the final video. */
export function projectDuration(p: Project): number {
  const v = videoEnd(p);
  if (v > 0) return v;
  let m = 0;
  for (const a of p.audio) m = Math.max(m, audioEnd(a));
  for (const t of p.texts) m = Math.max(m, textEnd(t));
  return m;
}

export function slotAt(layout: VideoSlot[], t: number): VideoSlot | null {
  if (!layout.length) return null;
  for (const s of layout) if (t >= s.start && t < s.end) return s;
  const last = layout[layout.length - 1];
  if (t >= last.end && t - last.end < 1e-3) return last;
  return null;
}

export function sourceTime(slot: VideoSlot, t: number): number {
  const c = slot.clip;
  if (c.kind === 'image') return 0;
  return clamp(c.in + (t - slot.start) * c.speed, c.in, Math.max(c.in, c.out - 1e-4));
}

export function defaultFraming(media: MediaItem, format: Project['format']): Framing {
  const aspect = media.width && media.height ? media.width / media.height : FORMATS[format].aspect;
  const target = FORMATS[format].aspect;
  const close = Math.abs(aspect / target - 1) < 0.12;
  return { mode: close ? 'fill' : 'fit', scale: 1, x: 0, y: 0, rotation: 0 };
}

export function makeVideoClip(media: MediaItem, format: Project['format']): VideoClip {
  const isImage = media.kind === 'image';
  return {
    id: uid(),
    mediaId: media.id,
    kind: isImage ? 'image' : 'video',
    in: 0,
    out: isImage ? DEFAULT_IMAGE_DURATION : media.duration,
    speed: 1,
    volume: 1,
    muted: false,
    audioDetached: false,
    fadeIn: 0,
    fadeOut: 0,
    framing: defaultFraming(media, format),
  };
}

/** Where to insert new clips: next to the clip under the playhead. */
export function insertionIndexAt(p: Project, t: number): number {
  const layout = videoLayout(p);
  if (!layout.length) return 0;
  const s = slotAt(layout, t);
  if (!s) return layout.length;
  return t - s.start < (s.end - s.start) / 2 ? s.index : s.index + 1;
}

export function insertVideoClips(p: Project, clips: VideoClip[], index: number): Project {
  const video = [...p.video];
  video.splice(clamp(index, 0, video.length), 0, ...clips);
  return { ...p, video };
}

export function updateVideoClip(p: Project, id: string, patch: Partial<VideoClip>): Project {
  return { ...p, video: p.video.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function updateAudioClip(p: Project, id: string, patch: Partial<AudioClip>): Project {
  return { ...p, audio: p.audio.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function updateTextClip(p: Project, id: string, patch: Partial<TextClip>): Project {
  return { ...p, texts: p.texts.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function moveVideoClip(p: Project, from: number, to: number): Project {
  if (from === to) return p;
  const video = [...p.video];
  const [c] = video.splice(from, 1);
  video.splice(clamp(to, 0, video.length), 0, c);
  return { ...p, video };
}

interface Laned {
  id: string;
  lane: number;
}

function overlaps(a0: number, a1: number, b0: number, b1: number) {
  return a0 < b1 - 1e-6 && b0 < a1 - 1e-6;
}

export function freeLane<T extends Laned>(
  items: T[],
  range: (it: T) => [number, number],
  start: number,
  end: number,
  preferred = 0,
  excludeId?: string,
): number {
  const conflict = (lane: number) =>
    items.some((it) => {
      if (it.id === excludeId || it.lane !== lane) return false;
      const [s, e] = range(it);
      return overlaps(start, end, s, e);
    });
  if (!conflict(preferred)) return preferred;
  for (let lane = 0; lane < 64; lane++) if (!conflict(lane)) return lane;
  return 64;
}

const audioRange = (a: AudioClip): [number, number] => [a.start, audioEnd(a)];
const textRange = (t: TextClip): [number, number] => [t.start, textEnd(t)];

/** Renumbers lanes so that there are no empty lanes in between. */
export function compactLanes(p: Project): Project {
  const remap = <T extends Laned>(items: T[]): T[] => {
    const used = [...new Set(items.map((i) => i.lane))].sort((a, b) => a - b);
    if (used.every((l, i) => l === i)) return items;
    const map = new Map(used.map((l, i) => [l, i]));
    return items.map((i) => ({ ...i, lane: map.get(i.lane) ?? 0 }));
  };
  const audio = remap(p.audio);
  const texts = remap(p.texts);
  if (audio === p.audio && texts === p.texts) return p;
  return { ...p, audio, texts };
}

/** Moves a free clip (text / audio) and resolves lane conflicts. */
export function placeAudioClip(p: Project, id: string, start: number, lane: number): Project {
  const clip = p.audio.find((a) => a.id === id);
  if (!clip) return p;
  const s = Math.max(0, start);
  const e = s + clipDuration(clip);
  const l = freeLane(p.audio, audioRange, s, e, Math.max(0, lane), id);
  return compactLanes(updateAudioClip(p, id, { start: s, lane: l }));
}

export function placeTextClip(p: Project, id: string, start: number, lane: number): Project {
  const clip = p.texts.find((t) => t.id === id);
  if (!clip) return p;
  const s = Math.max(0, start);
  const l = freeLane(p.texts, textRange, s, s + clip.duration, Math.max(0, lane), id);
  return compactLanes(updateTextClip(p, id, { start: s, lane: l }));
}

export function addAudioClip(
  p: Project,
  media: MediaItem,
  role: AudioRole,
  start: number,
  opts: Partial<AudioClip> = {},
): { project: Project; id: string } {
  const projectLen = videoEnd(p);
  let out = media.duration;
  // Music longer than the video is trimmed to the end of the video.
  if (role === 'music' && projectLen > 0 && start < projectLen) out = Math.min(out, projectLen - start);
  const clip: AudioClip = {
    id: uid(),
    mediaId: media.id,
    role,
    lane: 0,
    start,
    in: 0,
    out: Math.max(MIN_CLIP, out),
    speed: 1,
    volume: role === 'music' ? 0.6 : 1,
    muted: false,
    fadeIn: 0,
    fadeOut: role === 'music' ? Math.min(1.5, out / 4) : 0,
    ...opts,
  };
  clip.lane = freeLane(p.audio, audioRange, clip.start, audioEnd(clip));
  return { project: { ...p, audio: [...p.audio, clip] }, id: clip.id };
}

export function addTextClip(p: Project, base: Omit<TextClip, 'id' | 'lane'>): { project: Project; id: string } {
  const clip: TextClip = { ...base, id: uid(), lane: 0 };
  clip.lane = freeLane(p.texts, textRange, clip.start, textEnd(clip));
  return { project: { ...p, texts: [...p.texts, clip] }, id: clip.id };
}

export function detachAudio(p: Project, videoId: string): { project: Project; id: string } | null {
  const slot = videoLayout(p).find((s) => s.clip.id === videoId);
  if (!slot || slot.clip.kind !== 'video' || slot.clip.audioDetached) return null;
  const c = slot.clip;
  const clip: AudioClip = {
    id: uid(),
    mediaId: c.mediaId,
    role: 'extracted',
    lane: 0,
    start: slot.start,
    in: c.in,
    out: c.out,
    speed: c.speed,
    volume: c.volume,
    muted: c.muted,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
  };
  clip.lane = freeLane(p.audio, audioRange, clip.start, audioEnd(clip));
  const project = updateVideoClip({ ...p, audio: [...p.audio, clip] }, videoId, { audioDetached: true });
  return { project, id: clip.id };
}

export function deleteSelection(p: Project, sel: Selection): Project {
  if (sel.type === 'video') return { ...p, video: p.video.filter((c) => c.id !== sel.id) };
  if (sel.type === 'audio') return compactLanes({ ...p, audio: p.audio.filter((c) => c.id !== sel.id) });
  return compactLanes({ ...p, texts: p.texts.filter((c) => c.id !== sel.id) });
}

export function duplicateSelection(p: Project, sel: Selection): { project: Project; selection: Selection } | null {
  if (sel.type === 'video') {
    const i = p.video.findIndex((c) => c.id === sel.id);
    if (i < 0) return null;
    const copy = { ...p.video[i], id: uid(), framing: { ...p.video[i].framing } };
    return { project: insertVideoClips(p, [copy], i + 1), selection: { type: 'video', id: copy.id } };
  }
  if (sel.type === 'audio') {
    const a = p.audio.find((c) => c.id === sel.id);
    if (!a) return null;
    const copy: AudioClip = { ...a, id: uid(), start: audioEnd(a) };
    copy.lane = freeLane(p.audio, audioRange, copy.start, audioEnd(copy), a.lane);
    return { project: { ...p, audio: [...p.audio, copy] }, selection: { type: 'audio', id: copy.id } };
  }
  const t = p.texts.find((c) => c.id === sel.id);
  if (!t) return null;
  const copy: TextClip = { ...t, id: uid(), start: textEnd(t) };
  copy.lane = freeLane(p.texts, textRange, copy.start, textEnd(copy), t.lane);
  return { project: { ...p, texts: [...p.texts, copy] }, selection: { type: 'text', id: copy.id } };
}

/**
 * Splits the selected clip at time t — or, with no usable selection, the video clip under the playhead.
 * Returns null when there is nothing to split there.
 */
export function splitAt(p: Project, sel: Selection | null, t: number): { project: Project; selection: Selection } | null {
  if (sel?.type === 'audio') {
    const a = p.audio.find((c) => c.id === sel.id);
    if (a && t > a.start + MIN_CLIP && t < audioEnd(a) - MIN_CLIP) {
      const cut = a.in + (t - a.start) * a.speed;
      const first: AudioClip = { ...a, out: cut, fadeOut: 0 };
      const second: AudioClip = { ...a, id: uid(), start: t, in: cut, fadeIn: 0 };
      return {
        project: { ...p, audio: p.audio.flatMap((c) => (c.id === a.id ? [first, second] : [c])) },
        selection: { type: 'audio', id: second.id },
      };
    }
    return null;
  }
  if (sel?.type === 'text') {
    const x = p.texts.find((c) => c.id === sel.id);
    if (x && t > x.start + MIN_CLIP && t < textEnd(x) - MIN_CLIP) {
      const first: TextClip = { ...x, duration: t - x.start };
      const second: TextClip = { ...x, id: uid(), start: t, duration: textEnd(x) - t };
      return {
        project: { ...p, texts: p.texts.flatMap((c) => (c.id === x.id ? [first, second] : [c])) },
        selection: { type: 'text', id: second.id },
      };
    }
    return null;
  }
  const layout = videoLayout(p);
  const slot = slotAt(layout, t);
  if (!slot) return null;
  if (t <= slot.start + MIN_CLIP || t >= slot.end - MIN_CLIP) return null;
  const c = slot.clip;
  const local = t - slot.start;
  let first: VideoClip;
  let second: VideoClip;
  if (c.kind === 'image') {
    first = { ...c, out: local, fadeOut: 0 };
    second = { ...c, id: uid(), in: 0, out: c.out - local, fadeIn: 0, framing: { ...c.framing } };
  } else {
    const cut = c.in + local * c.speed;
    first = { ...c, out: cut, fadeOut: 0 };
    second = { ...c, id: uid(), in: cut, fadeIn: 0, framing: { ...c.framing } };
  }
  const video = [...p.video];
  video.splice(slot.index, 1, first, second);
  return { project: { ...p, video }, selection: { type: 'video', id: second.id } };
}

/** Applies a trim drag of `dt` timeline seconds to a clip, relative to its state `base` at gesture start. */
export function trimVideoClip(base: VideoClip, edge: 'start' | 'end', dt: number, mediaDuration: number): Partial<VideoClip> {
  if (base.kind === 'image') {
    const d = edge === 'start' ? base.out - dt : base.out + dt;
    return { in: 0, out: clamp(d, MIN_CLIP, MAX_IMAGE_DURATION) };
  }
  if (edge === 'start') {
    return { in: clamp(base.in + dt * base.speed, 0, base.out - MIN_CLIP * base.speed) };
  }
  return { out: clamp(base.out + dt * base.speed, base.in + MIN_CLIP * base.speed, mediaDuration) };
}

export function trimAudioClip(base: AudioClip, edge: 'start' | 'end', dt: number, mediaDuration: number): Partial<AudioClip> {
  if (edge === 'start') {
    const minDt = Math.max(-base.in / base.speed, -base.start);
    const maxDt = clipDuration(base) - MIN_CLIP;
    const d = clamp(dt, minDt, maxDt);
    return { start: base.start + d, in: base.in + d * base.speed };
  }
  return { out: clamp(base.out + dt * base.speed, base.in + MIN_CLIP * base.speed, mediaDuration) };
}

export function trimTextClip(base: TextClip, edge: 'start' | 'end', dt: number): Partial<TextClip> {
  if (edge === 'start') {
    const d = clamp(dt, -base.start, base.duration - 0.3);
    return { start: base.start + d, duration: base.duration - d };
  }
  return { duration: Math.max(0.3, base.duration + dt) };
}

export function findClip(p: Project, sel: Selection | null): VideoClip | AudioClip | TextClip | null {
  if (!sel) return null;
  if (sel.type === 'video') return p.video.find((c) => c.id === sel.id) ?? null;
  if (sel.type === 'audio') return p.audio.find((c) => c.id === sel.id) ?? null;
  return p.texts.find((c) => c.id === sel.id) ?? null;
}

export function createProject(name: string, format: Project['format']): Project {
  const now = Date.now();
  return { id: uid(), name, format, createdAt: now, updatedAt: now, video: [], audio: [], texts: [], version: 1 };
}
