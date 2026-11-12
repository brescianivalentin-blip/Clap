import type { VideoSample } from 'mediabunny';
import type { MediaItem, Project, VideoClip } from '../types';
import { projectDuration, slotAt, sourceTime, videoLayout } from '../timeline';
import { clamp } from '../util';
import { getImage, getVideoSource, imageNow } from '../media/sources';
import { getAudioBuffer } from '../media/audio';
import { collectSegments, createMasterBus, prepareSegments, scheduleSegments } from './audioGraph';
import { drawComposite, type FrameSource } from './render';
import { ensureFonts } from './fonts';

type Listener = (t: number, playing: boolean) => void;

/** Decodes the frames of one clip during playback, in step with the audio clock. */
class ClipStream {
  current: VideoSample | null = null;
  private closed = false;
  private it: AsyncGenerator<VideoSample, void, unknown> | null = null;

  private player: Player;
  readonly clip: VideoClip;
  readonly clipStart: number;

  constructor(player: Player, clip: VideoClip, clipStart: number, from: number) {
    this.player = player;
    this.clip = clip;
    this.clipStart = clipStart;
    void this.run(from);
  }

  private async run(from: number) {
    try {
      const src = await getVideoSource(this.clip.mediaId);
      if (this.closed) return;
      const c = this.clip;
      const srcStart = clamp(c.in + (from - this.clipStart) * c.speed, c.in, c.out);
      this.it = src.sink.samples(srcStart, c.out);
      for await (const sample of this.it) {
        if (this.closed) {
          sample.close();
          break;
        }
        const due = this.clipStart + (sample.timestamp - c.in) / c.speed;
        while (!this.closed && due > this.player.time + 0.004) await this.player.nextTick();
        if (this.closed) {
          sample.close();
          break;
        }
        this.current?.close();
        this.current = sample;
      }
    } catch (e) {
      if (!this.closed) console.warn('playback stream error', e);
    }
  }

  close() {
    this.closed = true;
    this.current?.close();
    this.current = null;
    const it = this.it;
    this.it = null;
    it?.return(undefined).catch(() => {});
  }
}

interface Still {
  clipId: string;
  srcT: number;
  frame: FrameSource;
}

export class Player {
  project: Project | null = null;
  media = new Map<string, MediaItem>();
  /** Called after every draw, e.g. to refresh overlays. */
  onDraw: (() => void) | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private _time = 0;
  private _playing = false;
  private started = false;
  private audioCtx: AudioContext | null = null;
  private bus: { input: GainNode; output: AudioNode } | null = null;
  private nodes: AudioBufferSourceNode[] = [];
  private playCtxStart = 0;
  private playFrom = 0;
  private streams = new Map<string, ClipStream>();
  private raf = 0;
  private listeners = new Set<Listener>();
  private waiters: (() => void)[] = [];
  private still: Still | null = null;
  private stillWanted: number | null = null;
  private stillBusy = false;
  private token = 0;

  get time() {
    return this._time;
  }

  get playing() {
    return this._playing;
  }

  get duration() {
    return this.project ? projectDuration(this.project) : 0;
  }

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.redraw();
    void ensureFonts().then(() => this.redraw());
  }

  detach(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) {
      this.canvas = null;
      this.ctx = null;
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l(this._time, this._playing);
  }

  nextTick(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  private flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  setProject(p: Project | null, media: Map<string, MediaItem>) {
    const sameProject = p && this.project && p.id === this.project.id;
    this.project = p;
    this.media = media;
    if (!p) {
      this.stop();
      return;
    }
    if (!sameProject) {
      this._time = 0;
      for (const m of media.values()) if (m.hasAudio) void getAudioBuffer(m);
    }
    for (const c of p.video) if (c.kind === 'image' && !imageNow(c.mediaId)) void getImage(c.mediaId).then(() => this.refreshStill());
    if (this._playing) this.pause();
    const dur = projectDuration(p);
    if (this._time > dur) {
      this._time = dur;
      this.emit();
    }
    this.refreshStill();
  }

  private ensureAudio(): AudioContext {
    if (!this.audioCtx) {
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (session) session.type = 'playback';
      } catch {
        /* ignore */
      }
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AC({ latencyHint: 'interactive' });
      this.bus = createMasterBus(this.audioCtx);
      this.bus.output.connect(this.audioCtx.destination);
    }
    return this.audioCtx;
  }

  /** Must be called from a user gesture (tap) for audio to start on iPad. */
  play() {
    const p = this.project;
    if (!p || this._playing) return;
    const dur = projectDuration(p);
    if (dur <= 0.05) return;
    if (this._time >= dur - 0.03) this._time = 0;
    const ctx = this.ensureAudio();
    void ctx.resume();
    this._playing = true;
    this.started = false;
    const token = ++this.token;
    this.emit();
    const segs = collectSegments(p, this.media);
    const start = () => {
      if (token !== this.token || !this._playing || !this.bus) return;
      this.playFrom = this._time;
      this.playCtxStart = ctx.currentTime + 0.06;
      this.nodes = scheduleSegments(ctx, this.bus.input, segs, this.playFrom, this.playCtxStart, dur);
      this.started = true;
      this.raf = requestAnimationFrame(this.tick);
    };
    prepareSegments(segs, this.media).then(start, start);
  }

  private clock(): number {
    if (!this.audioCtx || !this.started) return this._time;
    const latency = (this.audioCtx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    return this.playFrom + Math.max(0, this.audioCtx.currentTime - this.playCtxStart - latency);
  }

  private tick = () => {
    const p = this.project;
    if (!this._playing || !p) return;
    const dur = projectDuration(p);
    const t = this.clock();
    if (t >= dur) {
      this.pause();
      this._time = dur;
      this.emit();
      this.requestStill(dur);
      return;
    }
    this._time = t;
    const layout = videoLayout(p);
    const slot = slotAt(layout, t);
    // Keep a decoder running for the current clip, and warm up the next one.
    const keep = new Set<string>();
    if (slot) {
      if (slot.clip.kind === 'video') {
        keep.add(slot.clip.id);
        if (!this.streams.has(slot.clip.id)) this.streams.set(slot.clip.id, new ClipStream(this, slot.clip, slot.start, t));
      }
      const next = layout[slot.index + 1];
      if (next && slot.end - t < 1.2) {
        if (next.clip.kind === 'video') {
          keep.add(next.clip.id);
          if (!this.streams.has(next.clip.id)) this.streams.set(next.clip.id, new ClipStream(this, next.clip, next.start, next.start));
        } else if (!imageNow(next.clip.mediaId)) {
          void getImage(next.clip.mediaId);
        }
      }
    }
    for (const [id, s] of this.streams) {
      if (!keep.has(id)) {
        s.close();
        this.streams.delete(id);
      }
    }
    if (slot) {
      if (slot.clip.kind === 'video') {
        const sample = this.streams.get(slot.clip.id)?.current;
        // No frame decoded yet: keep the previous picture rather than flashing black.
        if (sample) this.draw(t, { type: 'sample', sample }, slot.clip);
      } else {
        const b = imageNow(slot.clip.mediaId);
        if (b) this.draw(t, { type: 'bitmap', bitmap: b }, slot.clip);
      }
    } else {
      this.draw(t, null, null);
    }
    this.emit();
    this.flushWaiters();
    this.raf = requestAnimationFrame(this.tick);
  };

  pause() {
    if (!this._playing) return;
    const dur = this.duration;
    this._time = clamp(this.clock(), 0, dur);
    this._playing = false;
    this.started = false;
    this.token++;
    cancelAnimationFrame(this.raf);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
      n.disconnect();
    }
    this.nodes = [];
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    this.flushWaiters();
    this.emit();
    this.requestStill(this._time);
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(t: number) {
    if (!this.project) return;
    const dur = projectDuration(this.project);
    const nt = clamp(t, 0, dur);
    if (this._playing) this.pause();
    this._time = nt;
    this.emit();
    this.requestStill(nt);
  }

  private stop() {
    if (this._playing) this.pause();
    this.releaseStill();
    this._time = 0;
    if (this.ctx && this.canvas) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private releaseStill() {
    if (this.still?.frame.type === 'sample') this.still.frame.sample.close();
    this.still = null;
  }

  /** Redraws the paused frame if it is still valid, otherwise decodes the right one. */
  refreshStill() {
    const p = this.project;
    if (!p || this._playing) return;
    const slot = slotAt(videoLayout(p), this._time);
    if (slot && this.still && this.still.clipId === slot.clip.id) {
      const srcT = sourceTime(slot, this._time);
      if (slot.clip.kind === 'image' || Math.abs(srcT - this.still.srcT) < 1e-3) {
        this.redraw();
        return;
      }
    }
    this.redraw();
    this.requestStill(this._time);
  }

  private requestStill(t: number) {
    this.stillWanted = t;
    if (this.stillBusy) return;
    this.stillBusy = true;
    void (async () => {
      try {
        while (this.stillWanted !== null) {
          const want = this.stillWanted;
          this.stillWanted = null;
          const result = await this.fetchFrame(want).catch((e) => {
            console.warn('frame decode failed', e);
            return null;
          });
          if (this._playing) {
            if (result?.frame.type === 'sample') result.frame.sample.close();
            break;
          }
          this.releaseStill();
          this.still = result;
          if (this.stillWanted === null) this.redraw();
        }
      } finally {
        this.stillBusy = false;
      }
    })();
  }

  private async fetchFrame(t: number): Promise<Still | null> {
    const p = this.project;
    if (!p) return null;
    const slot = slotAt(videoLayout(p), t);
    if (!slot) return null;
    const c = slot.clip;
    if (c.kind === 'image') {
      const bitmap = await getImage(c.mediaId);
      return { clipId: c.id, srcT: 0, frame: { type: 'bitmap', bitmap } };
    }
    const srcT = sourceTime(slot, t);
    const src = await getVideoSource(c.mediaId);
    const sample = await src.sink.getSample(srcT);
    if (!sample) return null;
    return { clipId: c.id, srcT, frame: { type: 'sample', sample } };
  }

  /** Synchronous redraw of the paused picture (texts, framing…). */
  redraw() {
    const p = this.project;
    if (!p || this._playing) return;
    const slot = slotAt(videoLayout(p), this._time);
    let frame: FrameSource | null = null;
    let clip: VideoClip | null = null;
    if (this.still) {
      const owner = p.video.find((c) => c.id === this.still!.clipId);
      if (owner) {
        frame = this.still.frame;
        clip = slot?.clip.id === owner.id ? slot.clip : owner;
      }
    }
    if (!frame && slot?.clip.kind === 'image') {
      const b = imageNow(slot.clip.mediaId);
      if (b) {
        frame = { type: 'bitmap', bitmap: b };
        clip = slot.clip;
      }
    }
    this.draw(this._time, frame, clip);
  }

  private draw(t: number, frame: FrameSource | null, clip: VideoClip | null) {
    if (!this.ctx || !this.canvas || !this.project) return;
    try {
      drawComposite(this.ctx, this.canvas.width, this.canvas.height, this.project, t, frame, clip);
    } catch (e) {
      console.warn('draw failed', e);
    }
    this.onDraw?.();
  }

  /** Small JPEG of the current picture (used as the project cover). */
  snapshot(maxSide = 480): Promise<Blob | null> {
    const src = this.canvas;
    if (!src || !src.width) return Promise.resolve(null);
    const k = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
  }
}

export const player = new Player();
