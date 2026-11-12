import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Gauge, Mic, Music, Plus, Type, VolumeX } from 'lucide-react';
import type { AudioClip, MediaItem, Project, TextClip, VideoClip } from '../../lib/types';
import {
  audioEnd,
  clipDuration,
  moveVideoClip,
  placeAudioClip,
  placeTextClip,
  projectDuration,
  textEnd,
  trimAudioClip,
  trimTextClip,
  trimVideoClip,
  updateAudioClip,
  updateTextClip,
  updateVideoClip,
  videoLayout,
  type VideoSlot,
} from '../../lib/timeline';
import { clamp, formatDuration, formatTime } from '../../lib/util';
import { player } from '../../lib/engine/player';
import { loadThumbs, thumbStyle, usePeaks, useThumbs, type LoadedThumbs } from '../../lib/assets';
import { PEAKS_PER_SECOND } from '../../lib/media/audio';
import { useEditor } from '../../state/editor';
import { addText, importVisual } from '../../state/actions';
import { pickFiles } from '../files';
import { primeKeyboard } from './panels';

const RULER_H = 26;
const VIDEO_H = 60;
const TEXT_H = 30;
const AUDIO_H = 42;
const GAP = 6;
const TILE = 52;
const TILE_GAP = 6;

interface View {
  start: number;
  end: number;
}

type Drag =
  | { kind: 'trim-video'; id: string; index: number; edge: 'start' | 'end'; x0: number; base: VideoClip; slotStart: number; mediaDur: number }
  | { kind: 'trim-audio'; id: string; edge: 'start' | 'end'; x0: number; base: AudioClip; mediaDur: number }
  | { kind: 'trim-text'; id: string; edge: 'start' | 'end'; x0: number; base: TextClip }
  | { kind: 'move-audio'; id: string; x0: number; y0: number; base: AudioClip }
  | { kind: 'move-text'; id: string; x0: number; y0: number; base: TextClip }
  | { kind: 'reorder'; from: number };

interface Reorder {
  from: number;
  x: number;
  rowLeft: number;
  target: number;
}

// ---------- Canvas strips (only the visible part is drawn) ----------

function useVisibleRange(x: number, w: number, view: View) {
  const a = Math.max(x, view.start);
  const b = Math.min(x + w, view.end);
  return b > a ? { a, b } : null;
}

const FilmStrip = memo(function FilmStrip({
  thumbs,
  clip,
  x,
  w,
  view,
  zoom,
}: {
  thumbs: LoadedThumbs | null;
  clip: VideoClip;
  x: number;
  w: number;
  view: View;
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vis = useVisibleRange(x, w, view);
  useEffect(() => {
    const c = ref.current;
    if (!c || !vis || !thumbs) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = vis.b - vis.a;
    c.width = Math.max(1, Math.round(cw * dpr));
    c.height = Math.round(VIDEO_H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tw = VIDEO_H;
    const offset = vis.a - x;
    const k0 = Math.floor(offset / tw);
    const k1 = Math.ceil((vis.b - x) / tw);
    const { cols, size, interval, count } = thumbs.sheet;
    for (let k = k0; k < k1; k++) {
      let idx = 0;
      if (clip.kind === 'video') {
        const local = (k * tw + tw / 2) / zoom;
        const src = clip.in + local * clip.speed;
        idx = clamp(Math.floor(src / interval), 0, count - 1);
      }
      ctx.drawImage(thumbs.img, (idx % cols) * size, Math.floor(idx / cols) * size, size, size, k * tw - offset, 0, tw, tw);
    }
  }, [thumbs, clip.in, clip.speed, clip.kind, x, w, vis?.a, vis?.b, zoom]);
  if (!vis) return null;
  return <canvas ref={ref} className="strip" style={{ left: vis.a - x, width: vis.b - vis.a, height: VIDEO_H }} />;
});

const Waveform = memo(function Waveform({
  peaks,
  srcIn,
  speed,
  x,
  w,
  view,
  zoom,
  height,
}: {
  peaks: Uint8Array | null;
  srcIn: number;
  speed: number;
  x: number;
  w: number;
  view: View;
  zoom: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const vis = useVisibleRange(x, w, view);
  useEffect(() => {
    const c = ref.current;
    if (!c || !vis || !peaks) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = vis.b - vis.a;
    c.width = Math.max(1, Math.round(cw * dpr));
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    const mid = height / 2;
    const offset = vis.a - x;
    for (let px = 0; px < cw; px += 3) {
      const local = (offset + px) / zoom;
      const src = srcIn + local * speed;
      const i = Math.floor(src * PEAKS_PER_SECOND);
      const v = (peaks[clamp(i, 0, peaks.length - 1)] ?? 0) / 255;
      const hh = Math.max(1, v * (height - 6) * 0.5);
      ctx.fillRect(px, mid - hh, 2, hh * 2);
    }
  }, [peaks, srcIn, speed, x, w, vis?.a, vis?.b, zoom, height]);
  if (!vis) return null;
  return <canvas ref={ref} className="wave" style={{ left: vis.a - x, width: vis.b - vis.a, height }} />;
});

// ---------- Ruler ----------

function Ruler({ pad, zoom, view, length }: { pad: number; zoom: number; view: View; length: number }) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => s * zoom >= 70) ?? 120;
  const t0 = Math.max(0, Math.floor((view.start - pad) / zoom / step) * step);
  const t1 = Math.min(length + step, (view.end - pad) / zoom);
  const ticks: number[] = [];
  for (let t = t0; t <= t1 && ticks.length < 400; t += step) ticks.push(t);
  return (
    <div className="ruler" style={{ height: RULER_H }}>
      {ticks.map((t) => (
        <div key={t} className="tick" style={{ left: pad + t * zoom }}>
          <span>{formatTime(t, step < 1)}</span>
          <i style={{ left: (step * zoom) / 2 }} />
        </div>
      ))}
    </div>
  );
}

// ---------- Timeline ----------

export function Timeline() {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(0);
  const [view, setView] = useState<View>({ start: 0, end: 3000 });
  const [shift, setShift] = useState<{ from: number; px: number } | null>(null);
  const [snapX, setSnapX] = useState<number | null>(null);
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const zoomRef = useRef(zoom);
  const programmatic = useRef(-1);
  const userScrollAt = useRef(0);
  const follow = useRef(true);
  const drag = useRef<Drag | null>(null);
  const seekRaf = useRef(0);
  const fitted = useRef<string | null>(null);

  zoomRef.current = zoom;
  const pad = vw / 2;
  const layout = useMemo(() => videoLayout(project), [project]);
  const duration = projectDuration(project);
  const contentEnd = useMemo(() => {
    let m = duration;
    for (const a of project.audio) m = Math.max(m, audioEnd(a));
    for (const t of project.texts) m = Math.max(m, textEnd(t));
    return m;
  }, [project, duration]);
  const textLanes = project.texts.length ? Math.max(...project.texts.map((t) => t.lane)) + 1 : 0;
  const audioLanes = project.audio.length ? Math.max(...project.audio.map((a) => a.lane)) + 1 : 0;
  const width = Math.max(vw + 1, pad * 2 + contentEnd * zoom + 90);

  const rows = {
    video: RULER_H + 4,
    text: RULER_H + 4 + VIDEO_H + GAP,
    audio: RULER_H + 4 + VIDEO_H + GAP + Math.max(1, textLanes) * (TEXT_H + 4) + GAP,
  };
  const height = rows.audio + Math.max(1, audioLanes) * (AUDIO_H + 4) + 10;

  const setScroll = useCallback((x: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = x;
    programmatic.current = el.scrollLeft;
  }, []);

  const updateView = useCallback((sl: number, w: number, force = false) => {
    setView((v) => {
      const center = sl + w / 2;
      const vc = (v.start + v.end) / 2;
      if (!force && Math.abs(center - vc) < w * 0.5 && v.end - v.start >= w * 2.5) return v;
      return { start: sl - w, end: sl + w * 2 };
    });
  }, []);

  // Viewport size.
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Fit the whole project in view when opening it.
  useLayoutEffect(() => {
    if (!vw || fitted.current === project.id || duration <= 0) return;
    fitted.current = project.id;
    useEditor.getState().setZoom(clamp((vw * 0.45) / duration, 8, 160));
  }, [vw, duration, project.id]);

  // Keep the playhead time under the centre line when zooming or resizing.
  useLayoutEffect(() => {
    if (!vw) return;
    setScroll(player.time * zoom);
    updateView(player.time * zoom, vw, true);
  }, [zoom, vw, setScroll, updateView]);

  // Follow the player (playback, seeks from elsewhere).
  useEffect(
    () =>
      player.subscribe((t) => {
        const el = scrollRef.current;
        if (!el || !follow.current) return;
        if (performance.now() - userScrollAt.current < 180) return;
        const x = t * zoomRef.current;
        if (Math.abs(el.scrollLeft - x) < 0.5) return;
        setScroll(x);
        updateView(x, el.clientWidth);
      }),
    [setScroll, updateView],
  );

  const onScroll = () => {
    const el = scrollRef.current!;
    const sl = el.scrollLeft;
    updateView(sl, el.clientWidth);
    if (Math.abs(sl - programmatic.current) < 1.5) return;
    programmatic.current = -1;
    userScrollAt.current = performance.now();
    if (!seekRaf.current) {
      seekRaf.current = requestAnimationFrame(() => {
        seekRaf.current = 0;
        const s = scrollRef.current;
        if (s) player.seek(s.scrollLeft / zoomRef.current);
      });
    }
  };

  // Pinch to zoom, pause on touch, block native scroll during drags.
  useEffect(() => {
    const el = scrollRef.current!;
    let pinch: { d0: number; z0: number } | null = null;
    const d = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (player.playing) player.pause();
      if (e.touches.length === 2) {
        pinch = { d0: d(e), z0: zoomRef.current };
        e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        useEditor.getState().setZoom((pinch.z0 * d(e)) / Math.max(1, pinch.d0));
      } else if (drag.current) {
        e.preventDefault();
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        useEditor.getState().setZoom(zoomRef.current * Math.exp(-e.deltaY * 0.01));
      }
    };
    const onMouseDown = () => {
      if (player.playing) player.pause();
    };
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  // ----- Snapping -----
  const snapCandidates = useCallback(
    (excludeId: string) => {
      const c: number[] = [0, player.time];
      for (const s of layout) if (s.clip.id !== excludeId) c.push(s.start, s.end);
      for (const a of project.audio) if (a.id !== excludeId) c.push(a.start, audioEnd(a));
      for (const t of project.texts) if (t.id !== excludeId) c.push(t.start, textEnd(t));
      return c;
    },
    [layout, project],
  );

  const snap = (t: number, cands: number[]): number | null => {
    const thr = 10 / zoomRef.current;
    let best: number | null = null;
    for (const c of cands) if (Math.abs(c - t) < thr && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
    return best;
  };

  // ----- Drag handling (window listeners, robust to re-renders) -----
  const startDrag = (d: Drag, e: React.PointerEvent | PointerEvent) => {
    drag.current = d;
    follow.current = false;
    if (d.kind !== 'reorder') useEditor.getState().beginGesture();
    const cands = d.kind === 'reorder' ? [] : snapCandidates(d.id);
    let raf = 0;
    let lastX = e.clientX;
    let lastY = e.clientY;

    const apply = () => {
      raf = 0;
      const g = drag.current;
      if (!g) return;
      const ed = useEditor.getState();
      const z = zoomRef.current;
      if (g.kind === 'trim-video') {
        let dt = (lastX - g.x0) / z;
        const edgeT = g.edge === 'start' ? g.slotStart + dt : g.slotStart + clipDuration(g.base) + dt;
        const s = snap(edgeT, cands);
        if (s !== null) dt += s - edgeT;
        const patch = trimVideoClip(g.base, g.edge, dt, g.mediaDur);
        const next = { ...g.base, ...patch };
        ed.gesture((b) => updateVideoClip(b, g.id, patch));
        if (g.edge === 'start') {
          const px = (clipDuration(g.base) - clipDuration(next)) * z;
          setShift({ from: g.index, px });
          setSnapX(s !== null ? pad + s * z : null);
          player.seek(g.slotStart);
        } else {
          setShift(null);
          setSnapX(s !== null ? pad + s * z : null);
          player.seek(g.slotStart + clipDuration(next) - 0.001);
        }
      } else if (g.kind === 'trim-audio') {
        let dt = (lastX - g.x0) / z;
        const edgeT = g.edge === 'start' ? g.base.start + dt : audioEnd(g.base) + dt;
        const s = snap(edgeT, cands);
        if (s !== null) dt += s - edgeT;
        const patch = trimAudioClip(g.base, g.edge, dt, g.mediaDur);
        ed.gesture((b) => updateAudioClip(b, g.id, patch));
        setSnapX(s !== null ? pad + s * z : null);
      } else if (g.kind === 'trim-text') {
        let dt = (lastX - g.x0) / z;
        const edgeT = g.edge === 'start' ? g.base.start + dt : textEnd(g.base) + dt;
        const s = snap(edgeT, cands);
        if (s !== null) dt += s - edgeT;
        const patch = trimTextClip(g.base, g.edge, dt);
        ed.gesture((b) => updateTextClip(b, g.id, patch));
        setSnapX(s !== null ? pad + s * z : null);
      } else if (g.kind === 'move-audio' || g.kind === 'move-text') {
        const dur = g.kind === 'move-audio' ? clipDuration(g.base) : g.base.duration;
        let start = Math.max(0, g.base.start + (lastX - g.x0) / z);
        const s1 = snap(start, cands);
        const s2 = snap(start + dur, cands);
        let shown: number | null = null;
        if (s1 !== null && (s2 === null || Math.abs(s1 - start) <= Math.abs(s2 - start - dur))) {
          start = s1;
          shown = s1;
        } else if (s2 !== null) {
          start = s2 - dur;
          shown = s2;
        }
        const laneH = g.kind === 'move-audio' ? AUDIO_H + 4 : TEXT_H + 4;
        const lane = Math.max(0, g.base.lane + Math.round((lastY - g.y0) / laneH));
        if (g.kind === 'move-audio') ed.gesture((b) => placeAudioClip(b, g.id, start, lane));
        else ed.gesture((b) => placeTextClip(b, g.id, start, lane));
        setSnapX(shown !== null ? pad + shown * z : null);
      }
    };

    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      const g = drag.current;
      if (g?.kind === 'reorder') {
        setReorder((r) => {
          if (!r) return r;
          const n = useEditor.getState().project!.video.length;
          const target = clamp(Math.round((ev.clientX - r.rowLeft - TILE / 2) / (TILE + TILE_GAP)), 0, n - 1);
          return { ...r, x: ev.clientX, target };
        });
        return;
      }
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (raf) {
        cancelAnimationFrame(raf);
        apply();
      }
      const g = drag.current;
      drag.current = null;
      follow.current = true;
      setShift(null);
      setSnapX(null);
      const ed = useEditor.getState();
      if (g?.kind === 'reorder') {
        setReorder((r) => {
          if (r && r.target !== r.from) ed.edit((p) => moveVideoClip(p, r.from, r.target));
          return null;
        });
      } else {
        ed.endGesture();
        if (g?.kind === 'trim-video') {
          const el = scrollRef.current;
          if (el) player.seek(el.scrollLeft / zoomRef.current);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ----- Taps & long press on clips -----
  const press = useRef<{ x: number; y: number; t: number; timer: number; id: string } | null>(null);

  const onClipDown = (e: React.PointerEvent, type: 'video' | 'audio' | 'text', id: string, index = 0) => {
    if (e.button > 0) return;
    e.stopPropagation();
    const ed = useEditor.getState();
    const isSel = ed.selection?.type === type && ed.selection.id === id;
    const p = ed.project!;
    // Dragging the body of a selected sound / text moves it.
    if (isSel && type !== 'video') {
      e.stopPropagation();
      const base = type === 'audio' ? p.audio.find((a) => a.id === id)! : p.texts.find((t) => t.id === id)!;
      let moved = false;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const watch = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
          moved = true;
          window.removeEventListener('pointermove', watch);
          window.removeEventListener('pointerup', cancel);
          startDrag(
            type === 'audio'
              ? { kind: 'move-audio', id, x0, y0, base: base as AudioClip }
              : { kind: 'move-text', id, x0, y0, base: base as TextClip },
            ev,
          );
        }
      };
      const cancel = () => {
        window.removeEventListener('pointermove', watch);
        window.removeEventListener('pointerup', cancel);
        if (!moved) {
          if (type === 'text') {
            primeKeyboard();
            ed.setPanel('text');
          } else ed.select(null);
        }
      };
      window.addEventListener('pointermove', watch);
      window.addEventListener('pointerup', cancel);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!press.current || type !== 'video') return;
      press.current = null;
      if (player.playing) player.pause();
      const n = p.video.length;
      if (n < 2) return;
      ed.select(null);
      setReorder({ from: index, x: e.clientX, rowLeft: e.clientX - (index * (TILE + TILE_GAP) + TILE / 2), target: index });
      startDrag({ kind: 'reorder', from: index }, e);
    }, 420);
    press.current = { x: e.clientX, y: e.clientY, t: performance.now(), timer, id };
    const mv = (ev: PointerEvent) => {
      if (press.current && Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 8) {
        clearTimeout(press.current.timer);
        press.current = null;
      }
    };
    const end = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const pr = press.current;
      press.current = null;
      if (!pr) return;
      clearTimeout(pr.timer);
      if (performance.now() - pr.t < 420) ed.select(isSel ? null : { type, id });
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onHandleDown = (e: React.PointerEvent, type: 'video' | 'audio' | 'text', id: string, edge: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const p = useEditor.getState().project!;
    if (player.playing) player.pause();
    if (type === 'video') {
      const slot = layout.find((s) => s.clip.id === id)!;
      const m = media.get(slot.clip.mediaId);
      startDrag({ kind: 'trim-video', id, index: slot.index, edge, x0: e.clientX, base: slot.clip, slotStart: slot.start, mediaDur: m?.duration || slot.clip.out }, e);
    } else if (type === 'audio') {
      const a = p.audio.find((x) => x.id === id)!;
      startDrag({ kind: 'trim-audio', id, edge, x0: e.clientX, base: a, mediaDur: media.get(a.mediaId)?.duration || a.out }, e);
    } else {
      const t = p.texts.find((x) => x.id === id)!;
      startDrag({ kind: 'trim-text', id, edge, x0: e.clientX, base: t }, e);
    }
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    const x0 = e.clientX;
    const y0 = e.clientY;
    const t0 = performance.now();
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8 && performance.now() - t0 < 400) useEditor.getState().select(null);
    };
    window.addEventListener('pointerup', up);
  };

  const sel = (type: string, id: string) => selection?.type === type && selection.id === id;
  const shiftFor = (index: number) => (shift && index >= shift.from ? shift.px : 0);
  const endX = pad + duration * zoom;

  return (
    <div className="timeline">
      <div className="tl-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="tl-content" style={{ width, height }} onPointerDown={onBackgroundDown}>
          {vw > 0 && <Ruler pad={pad} zoom={zoom} view={view} length={contentEnd} />}

          {/* Main video track */}
          {layout.map((slot) => (
            <VideoClipView
              key={slot.clip.id}
              slot={slot}
              media={media.get(slot.clip.mediaId)}
              x={pad + slot.start * zoom + shiftFor(slot.index)}
              w={(slot.end - slot.start) * zoom}
              top={rows.video}
              selected={sel('video', slot.clip.id)}
              dimmed={!!reorder}
              view={view}
              zoom={zoom}
              onDown={(e) => onClipDown(e, 'video', slot.clip.id, slot.index)}
              onHandle={(e, edge) => onHandleDown(e, 'video', slot.clip.id, edge)}
            />
          ))}
          <button
            className="add-clip"
            style={{ left: (layout.length ? endX + shiftFor(layout.length) : pad) + 10, top: rows.video + (VIDEO_H - 44) / 2 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => pickFiles('visual', (f) => void importVisual(f))}
            aria-label="Ajouter des vidéos"
          >
            <Plus size={22} strokeWidth={2.6} />
          </button>

          {/* Texts */}
          {project.texts.length === 0 ? (
            <button
              className="add-row text"
              style={{ top: rows.text, height: TEXT_H, left: pad, width: Math.max(220, contentEnd * zoom + 60) }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                primeKeyboard();
                addText();
              }}
            >
              <span className="add-row-label">
                <Type size={15} /> Ajouter un texte
              </span>
            </button>
          ) : (
            project.texts.map((t) => (
              <FreeClipView
                key={t.id}
                kind="text"
                x={pad + t.start * zoom}
                w={t.duration * zoom}
                top={rows.text + t.lane * (TEXT_H + 4)}
                height={TEXT_H}
                selected={sel('text', t.id)}
                onDown={(e) => onClipDown(e, 'text', t.id)}
                onHandle={(e, edge) => onHandleDown(e, 'text', t.id, edge)}
                label={t.text.replace(/\n/g, ' ') || 'Texte'}
                icon={<Type size={13} />}
              />
            ))
          )}

          {/* Sounds */}
          {project.audio.length === 0 ? (
            <button
              className="add-row audio"
              style={{ top: rows.audio, height: AUDIO_H, left: pad, width: Math.max(260, contentEnd * zoom + 60) }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => useEditor.getState().setPanel('audio')}
            >
              <span className="add-row-label">
                <Music size={15} /> Ajouter une musique ou un son
              </span>
            </button>
          ) : (
            project.audio.map((a) => (
              <AudioClipView
                key={a.id}
                clip={a}
                media={media.get(a.mediaId)}
                x={pad + a.start * zoom}
                w={clipDuration(a) * zoom}
                top={rows.audio + a.lane * (AUDIO_H + 4)}
                selected={sel('audio', a.id)}
                view={view}
                zoom={zoom}
                onDown={(e) => onClipDown(e, 'audio', a.id)}
                onHandle={(e, edge) => onHandleDown(e, 'audio', a.id, edge)}
              />
            ))
          )}

          {duration > 0 && contentEnd > duration + 0.01 && (
            <div className="beyond-end" style={{ left: endX, width: (contentEnd - duration) * zoom + 90, top: rows.text - 2, height: height - rows.text }} />
          )}
          {snapX !== null && <div className="snap-line" style={{ left: snapX, height }} />}
        </div>
      </div>
      <div className="playhead" />
      {reorder && <ReorderLayer project={project} reorder={reorder} top={rows.video} />}
    </div>
  );
}

// ---------- Clip views ----------

interface HandleProps {
  onHandle(e: React.PointerEvent, edge: 'start' | 'end'): void;
}

function Handles({ onHandle }: HandleProps) {
  return (
    <>
      <div className="handle start" onPointerDown={(e) => onHandle(e, 'start')}>
        <i />
      </div>
      <div className="handle end" onPointerDown={(e) => onHandle(e, 'end')}>
        <i />
      </div>
    </>
  );
}

const VideoClipView = memo(function VideoClipView({
  slot,
  media,
  x,
  w,
  top,
  selected,
  dimmed,
  view,
  zoom,
  onDown,
  onHandle,
}: {
  slot: VideoSlot;
  media: MediaItem | undefined;
  x: number;
  w: number;
  top: number;
  selected: boolean;
  dimmed: boolean;
  view: View;
  zoom: number;
  onDown(e: React.PointerEvent): void;
} & HandleProps) {
  const thumbs = useThumbs(slot.clip.mediaId);
  const c = slot.clip;
  const silent = c.kind === 'video' && (c.muted || c.audioDetached || !media?.hasAudio);
  return (
    <div
      className={`clip video${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
      style={{ left: x, width: Math.max(4, w - 2), top, height: VIDEO_H }}
      onPointerDown={onDown}
    >
      <div className="clip-inner">
        <FilmStrip thumbs={thumbs} clip={c} x={x} w={w} view={view} zoom={zoom} />
        <div className="clip-badges">
          {c.speed !== 1 && (
            <span className="badge">
              <Gauge size={11} /> {c.speed.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')}×
            </span>
          )}
          {silent && c.kind === 'video' && (
            <span className="badge">
              <VolumeX size={11} />
            </span>
          )}
        </div>
        {selected && <span className="clip-duration">{formatDuration(slot.end - slot.start)}</span>}
      </div>
      {selected && <Handles onHandle={onHandle} />}
    </div>
  );
});

const AudioClipView = memo(function AudioClipView({
  clip,
  media,
  x,
  w,
  top,
  selected,
  view,
  zoom,
  onDown,
  onHandle,
}: {
  clip: AudioClip;
  media: MediaItem | undefined;
  x: number;
  w: number;
  top: number;
  selected: boolean;
  view: View;
  zoom: number;
  onDown(e: React.PointerEvent): void;
} & HandleProps) {
  const peaks = usePeaks(clip.mediaId);
  const Icon = clip.role === 'music' ? Music : clip.role === 'extracted' ? AudioLines : Mic;
  return (
    <div
      className={`clip audio ${clip.role}${selected ? ' selected' : ''}${clip.muted ? ' muted' : ''}`}
      style={{ left: x, width: Math.max(4, w - 2), top, height: AUDIO_H }}
      onPointerDown={onDown}
    >
      <div className="clip-inner">
        <Waveform peaks={peaks} srcIn={clip.in} speed={clip.speed} x={x} w={w} view={view} zoom={zoom} height={AUDIO_H - 18} />
        <span className="clip-label">
          <Icon size={12} /> {media?.name ?? 'Son'}
          {clip.speed !== 1 && ` · ${clip.speed.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')}×`}
        </span>
      </div>
      {selected && <Handles onHandle={onHandle} />}
    </div>
  );
});

function FreeClipView({
  kind,
  x,
  w,
  top,
  height,
  selected,
  onDown,
  onHandle,
  label,
  icon,
}: {
  kind: 'text';
  x: number;
  w: number;
  top: number;
  height: number;
  selected: boolean;
  onDown(e: React.PointerEvent): void;
  label: string;
  icon: React.ReactNode;
} & HandleProps) {
  return (
    <div className={`clip ${kind}${selected ? ' selected' : ''}`} style={{ left: x, width: Math.max(4, w - 2), top, height }} onPointerDown={onDown}>
      <div className="clip-inner">
        <span className="clip-label">
          {icon} {label}
        </span>
      </div>
      {selected && <Handles onHandle={onHandle} />}
    </div>
  );
}

function ReorderLayer({ project, reorder, top }: { project: Project; reorder: Reorder; top: number }) {
  const [thumbs, setThumbs] = useState<Map<string, LoadedThumbs | null>>(new Map());
  useEffect(() => {
    let alive = true;
    void Promise.all(project.video.map(async (c) => [c.mediaId, await loadThumbs(c.mediaId)] as const)).then((list) => {
      if (alive) setThumbs(new Map(list));
    });
    return () => {
      alive = false;
    };
  }, [project.video]);
  const order = project.video.map((_, i) => i).filter((i) => i !== reorder.from);
  order.splice(reorder.target, 0, -1);
  return (
    <div className="reorder-layer" style={{ top: top - 2 }}>
      {order.map((i, pos) => {
        if (i === -1) return <div key="ph" className="reorder-tile placeholder" style={{ left: reorder.rowLeft + pos * (TILE + TILE_GAP) }} />;
        const c = project.video[i];
        const t = thumbs.get(c.mediaId);
        return (
          <div key={c.id} className="reorder-tile" style={{ left: reorder.rowLeft + pos * (TILE + TILE_GAP), ...(t ? thumbStyle(t, 0, TILE) : {}) }} />
        );
      })}
      {(() => {
        const c = project.video[reorder.from];
        const t = thumbs.get(c.mediaId);
        return <div className="reorder-tile lifted" style={{ left: reorder.x - TILE / 2, ...(t ? thumbStyle(t, 0, TILE) : {}) }} />;
      })()}
    </div>
  );
}
