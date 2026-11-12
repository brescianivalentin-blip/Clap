import type { MediaItem, Project } from '../types';
import { audioEnd, clipDuration, videoLayout } from '../timeline';
import { clamp } from '../util';
import { getPlaybackBuffer, playbackBufferNow } from '../media/audio';

/** A piece of sound placed on the timeline. */
export interface AudioSegment {
  mediaId: string;
  speed: number;
  start: number;
  end: number;
  srcIn: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export function collectSegments(p: Project, media: Map<string, MediaItem>): AudioSegment[] {
  const segs: AudioSegment[] = [];
  for (const s of videoLayout(p)) {
    const c = s.clip;
    if (c.kind !== 'video' || c.muted || c.audioDetached || c.volume <= 0) continue;
    if (!media.get(c.mediaId)?.hasAudio) continue;
    segs.push({
      mediaId: c.mediaId,
      speed: c.speed,
      start: s.start,
      end: s.end,
      srcIn: c.in,
      volume: c.volume,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut,
    });
  }
  for (const a of p.audio) {
    if (a.muted || a.volume <= 0 || !media.get(a.mediaId)?.hasAudio) continue;
    if (clipDuration(a) <= 0) continue;
    segs.push({
      mediaId: a.mediaId,
      speed: a.speed,
      start: a.start,
      end: audioEnd(a),
      srcIn: a.in,
      volume: a.volume,
      fadeIn: a.fadeIn,
      fadeOut: a.fadeOut,
    });
  }
  return segs;
}

/** Decodes / stretches every buffer the segments need. */
export async function prepareSegments(segs: AudioSegment[], media: Map<string, MediaItem>): Promise<void> {
  await Promise.all(
    segs.map((s) => {
      const m = media.get(s.mediaId);
      return m ? getPlaybackBuffer(m, s.speed) : null;
    }),
  );
}

function gainAt(s: AudioSegment, t: number): number {
  let v = s.volume;
  if (s.fadeIn > 0 && t < s.start + s.fadeIn) v *= clamp((t - s.start) / s.fadeIn, 0, 1);
  if (s.fadeOut > 0 && t > s.end - s.fadeOut) v *= clamp((s.end - t) / s.fadeOut, 0, 1);
  return v;
}

/**
 * Schedules segments into an (Offline)AudioContext.
 * `from` is the timeline time that corresponds to context time `ctxStart`.
 */
export function scheduleSegments(
  ctx: BaseAudioContext,
  dest: AudioNode,
  segs: AudioSegment[],
  from: number,
  ctxStart: number,
  until: number,
): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = [];
  const ct = (t: number) => ctxStart + (t - from);
  for (const s of segs) {
    const t1 = Math.min(s.end, until);
    if (t1 <= from || s.start >= until) continue;
    const buf = playbackBufferNow(s.mediaId, s.speed);
    if (!buf) continue;
    const t0 = Math.max(s.start, from);
    const offset = s.srcIn / s.speed + (t0 - s.start);
    if (offset >= buf.duration) continue;
    const dur = Math.min(t1 - t0, buf.duration - offset);
    if (dur <= 0.001) continue;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const p = g.gain;
    p.setValueAtTime(gainAt(s, t0), ct(t0));
    const fadeInEnd = s.start + s.fadeIn;
    if (s.fadeIn > 0 && fadeInEnd > t0 && fadeInEnd < t1) p.linearRampToValueAtTime(gainAt(s, fadeInEnd), ct(fadeInEnd));
    if (s.fadeOut > 0) {
      const fadeOutStart = s.end - s.fadeOut;
      if (fadeOutStart > t0 && fadeOutStart < t1) p.setValueAtTime(gainAt(s, fadeOutStart), ct(fadeOutStart));
      if (t1 > t0) p.linearRampToValueAtTime(gainAt(s, t1), ct(t1));
    }
    src.connect(g);
    g.connect(dest);
    src.start(ct(t0), offset, dur);
    nodes.push(src);
  }
  return nodes;
}

/** Master bus: gentle limiter so volumes above 100 % don't clip. */
export function createMasterBus(ctx: BaseAudioContext): { input: GainNode; output: AudioNode } {
  const input = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  input.connect(limiter);
  return { input, output: limiter };
}
