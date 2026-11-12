import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Film, ImagePlus, Pencil, RotateCw, X } from 'lucide-react';
import type { Framing, TextClip, VideoClip } from '../../lib/types';
import { FORMATS } from '../../lib/formats';
import { slotAt, textEnd, updateTextClip, updateVideoClip, videoLayout } from '../../lib/timeline';
import { clamp } from '../../lib/util';
import { player } from '../../lib/engine/player';
import { activeTexts } from '../../lib/engine/render';
import { hitText, textBox } from '../../lib/engine/text';
import { useEditor } from '../../state/editor';
import { importVisual } from '../../state/actions';
import { pickFiles } from '../files';
import { primeKeyboard } from './panels';

interface Pt {
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'tap'; x0: number; y0: number; t0: number; moved: boolean }
  | { kind: 'text'; id: string; ref: TextClip; pts: Pt[]; moved: boolean; t0: number }
  | { kind: 'frame'; id: string; ref: Framing; pts: Pt[]; moved: boolean; t0: number };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function Preview() {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [time, setTime] = useState(player.time);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const aspect = FORMATS[project.format].aspect;
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const pad = r.width < 500 ? 8 : 14;
      const aw = Math.max(10, r.width - pad * 2);
      const ah = Math.max(10, r.height - pad * 2);
      let w = aw;
      let h = aw / aspect;
      if (h > ah) {
        h = ah;
        w = ah * aspect;
      }
      setSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || !size.w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let pw = Math.round(size.w * dpr);
    let ph = Math.round(size.h * dpr);
    const k = Math.min(1, 1920 / Math.max(pw, ph));
    pw = Math.round(pw * k);
    ph = Math.round(ph * k);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    player.attach(c);
  }, [size]);

  useEffect(() => {
    const c = canvasRef.current;
    return () => {
      if (c) player.detach(c);
    };
  }, []);

  // Re-render overlays only when the set of visible texts changes.
  useEffect(() => {
    let key = '';
    return player.subscribe((t) => {
      const p = useEditor.getState().project;
      if (!p) return;
      const k = activeTexts(p, t).map((x) => x.id).join(',') + (slotAt(videoLayout(p), t)?.clip.id ?? '');
      if (k !== key) {
        key = k;
        setTime(t);
      }
    });
  }, []);

  const ctx = canvasRef.current?.getContext('2d') ?? null;
  const canvasW = canvasRef.current?.width ?? 1;
  const scale = size.w / canvasW; // css px per canvas px

  const selectedText =
    selection?.type === 'text' ? project.texts.find((x) => x.id === selection.id && time >= x.start && time < textEnd(x)) ?? null : null;

  const box = useMemo(() => {
    if (!selectedText || !ctx || !canvasRef.current) return null;
    const b = textBox(ctx, selectedText, canvasRef.current.width, canvasRef.current.height);
    return { cx: b.cx * scale, cy: b.cy * scale, w: b.w * scale, h: b.h * scale, rotation: b.rotation };
  }, [selectedText, ctx, scale]);

  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * canvasRef.current!.width, y: ((clientY - r.top) / r.height) * canvasRef.current!.height };
  };

  const hitTest = (clientX: number, clientY: number): TextClip | null => {
    if (!ctx || !canvasRef.current) return null;
    const { x, y } = toCanvas(clientX, clientY);
    const W = canvasRef.current.width;
    const H = canvasRef.current.height;
    // Drawn last = on top: lane 0.
    const list = activeTexts(project, player.time).reverse();
    for (const t of list) if (hitText(textBox(ctx, t, W, H), x, y, 14 / Math.max(scale, 0.01))) return t;
    return null;
  };

  const currentVideoClip = (): VideoClip | null => {
    if (selection?.type !== 'video') return null;
    const slot = slotAt(videoLayout(project), player.time);
    return slot && slot.clip.id === selection.id ? slot.clip : null;
  };

  const rebase = () => {
    const g = gesture.current;
    if (!g || g.kind === 'tap') return;
    const p = useEditor.getState().project!;
    g.pts = [...pointers.current.values()];
    if (g.kind === 'text') g.ref = p.texts.find((x) => x.id === g.id) ?? g.ref;
    else g.ref = p.video.find((x) => x.id === g.id)?.framing ?? g.ref;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ed = useEditor.getState();
    if (pointers.current.size === 1) {
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        if (player.playing) player.pause();
        if (selection?.type !== 'text' || selection.id !== hit.id) ed.select({ type: 'text', id: hit.id });
        ed.beginGesture();
        gesture.current = { kind: 'text', id: hit.id, ref: hit, pts: [{ x: e.clientX, y: e.clientY }], moved: false, t0: performance.now() };
        return;
      }
      const vc = currentVideoClip();
      if (vc) {
        ed.beginGesture();
        gesture.current = { kind: 'frame', id: vc.id, ref: vc.framing, pts: [{ x: e.clientX, y: e.clientY }], moved: false, t0: performance.now() };
        return;
      }
      gesture.current = { kind: 'tap', x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
    } else {
      rebase();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'tap') {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 10) g.moved = true;
      return;
    }
    const pts = [...pointers.current.values()];
    const W = size.w;
    const H = size.h;
    if (pts.length !== g.pts.length) {
      rebase();
      return;
    }
    let dx = 0;
    let dy = 0;
    let k = 1;
    let da = 0;
    if (pts.length === 1) {
      dx = pts[0].x - g.pts[0].x;
      dy = pts[0].y - g.pts[0].y;
    } else {
      const m0 = mid(g.pts[0], g.pts[1]);
      const m1 = mid(pts[0], pts[1]);
      dx = m1.x - m0.x;
      dy = m1.y - m0.y;
      k = dist(pts[0], pts[1]) / Math.max(1, dist(g.pts[0], g.pts[1]));
      da = angle(pts[0], pts[1]) - angle(g.pts[0], g.pts[1]);
    }
    if (Math.abs(dx) + Math.abs(dy) > 3 || Math.abs(k - 1) > 0.02) g.moved = true;
    if (!g.moved) return;
    const ed = useEditor.getState();
    if (g.kind === 'text') {
      let x = clamp(g.ref.x + dx / W, -0.2, 1.2);
      let y = clamp(g.ref.y + dy / H, -0.2, 1.2);
      const v = Math.abs(x - 0.5) < 0.015;
      const h = Math.abs(y - 0.5) < 0.012;
      if (v) x = 0.5;
      if (h) y = 0.5;
      let rotation = g.ref.rotation + da;
      const deg = ((((rotation * 180) / Math.PI) % 360) + 360) % 360;
      if (deg < 4 || deg > 356) rotation = 0;
      const sizeV = clamp(g.ref.size * k, 0.02, 0.45);
      setGuides({ v, h });
      ed.gesture((base) => updateTextClip(base, g.id, { x, y, rotation, size: sizeV }));
    } else {
      let x = g.ref.x + dx / W;
      let y = g.ref.y + dy / H;
      const v = Math.abs(x) < 0.015;
      const h = Math.abs(y) < 0.015;
      if (v) x = 0;
      if (h) y = 0;
      const s = clamp(g.ref.scale * k, 0.25, 8);
      setGuides({ v, h });
      ed.gesture((base) => updateVideoClip(base, g.id, { framing: { ...g.ref, x, y, scale: s } }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size > 0) {
      rebase();
      return;
    }
    gesture.current = null;
    setGuides({ v: false, h: false });
    const ed = useEditor.getState();
    if (g.kind === 'tap') {
      if (!g.moved && performance.now() - g.t0 < 500) {
        if (ed.selection?.type === 'text') ed.select(null);
        else player.toggle();
      }
      return;
    }
    ed.endGesture();
    if (g.kind === 'text' && !g.moved) {
      const now = performance.now();
      if (lastTap.current && lastTap.current.id === g.id && now - lastTap.current.t < 400) {
        primeKeyboard();
        ed.setPanel('text');
        lastTap.current = null;
      } else {
        lastTap.current = { id: g.id, t: now };
      }
    }
  };

  // Scale / rotate handle of the text box.
  const handleDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!selectedText || !box) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const c = { x: r.left + box.cx, y: r.top + box.cy };
    const v0 = { x: e.clientX - c.x, y: e.clientY - c.y };
    const ref = selectedText;
    const ed = useEditor.getState();
    ed.beginGesture();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const v = { x: ev.clientX - c.x, y: ev.clientY - c.y };
      const k = Math.hypot(v.x, v.y) / Math.max(1, Math.hypot(v0.x, v0.y));
      let rotation = ref.rotation + Math.atan2(v.y, v.x) - Math.atan2(v0.y, v0.x);
      const deg = ((((rotation * 180) / Math.PI) % 360) + 360) % 360;
      if (deg < 4 || deg > 356) rotation = 0;
      ed.gesture((base) => updateTextClip(base, ref.id, { size: clamp(ref.size * k, 0.02, 0.45), rotation }));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      ed.endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const isEmpty = project.video.length === 0 && project.texts.length === 0 && project.audio.length === 0;
  const frameOutline = selection?.type === 'video' && currentVideoClip();

  return (
    <div className="stage" ref={wrapRef}>
      <div
        className="canvas-wrap"
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="preview-canvas" style={{ width: size.w, height: size.h }} />
        {guides.v && <div className="guide v" />}
        {guides.h && <div className="guide h" />}
        {frameOutline && <div className="frame-outline" />}
        {box && (
          <div
            className="text-box"
            style={{
              left: box.cx,
              top: box.cy,
              width: box.w + 12,
              height: box.h + 8,
              transform: `translate(-50%, -50%) rotate(${box.rotation}rad)`,
            }}
          >
            <button
              className="tb-handle tl"
              aria-label="Supprimer le texte"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const ed = useEditor.getState();
                ed.edit((p) => ({ ...p, texts: p.texts.filter((x) => x.id !== selectedText!.id) }));
                ed.select(null);
              }}
            >
              <X size={14} strokeWidth={3} />
            </button>
            <button
              className="tb-handle tr"
              aria-label="Modifier le texte"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                primeKeyboard();
                useEditor.getState().setPanel('text');
              }}
            >
              <Pencil size={13} strokeWidth={2.6} />
            </button>
            <button className="tb-handle br" aria-label="Taille et rotation" onPointerDown={handleDrag}>
              <RotateCw size={13} strokeWidth={2.6} />
            </button>
          </div>
        )}
      </div>
      {isEmpty && (
        <div className="empty-stage">
          <div className="empty-icon">
            <Film size={30} />
          </div>
          <p>Ajoute tes vidéos pour commencer le montage.</p>
          <button className="btn-primary big" onClick={() => pickFiles('visual', (f) => void importVisual(f))}>
            <ImagePlus size={20} /> Importer des vidéos
          </button>
        </div>
      )}
    </div>
  );
}
