import type { TextClip } from '../types';
import { colorHex, contrastOn, fontCss, getFont } from './fonts';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TextLayout {
  lines: string[];
  widths: number[];
  fontPx: number;
  lineH: number;
  width: number;
  height: number;
  padX: number;
  padY: number;
}

export function layoutText(ctx: Ctx2D, clip: TextClip, W: number, H: number): TextLayout {
  const font = getFont(clip.font);
  const fontPx = Math.max(4, clip.size * Math.min(W, H) * font.scale);
  ctx.font = fontCss(font, fontPx);
  const maxW = W * 0.88;
  const lines: string[] = [];
  for (const para of (clip.text || ' ').split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lineH = fontPx * 1.22;
  const boxed = clip.style === 'background';
  const padX = boxed ? fontPx * 0.34 : fontPx * 0.1;
  const padY = boxed ? fontPx * 0.12 : fontPx * 0.04;
  const width = Math.max(fontPx * 0.6, ...widths) + padX * 2;
  const height = lines.length * lineH + padY * 2;
  return { lines, widths, fontPx, lineH, width, height, padX, padY };
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawText(ctx: Ctx2D, clip: TextClip, W: number, H: number): TextLayout {
  const L = layoutText(ctx, clip, W, H);
  const font = getFont(clip.font);
  const color = colorHex(clip.color);
  ctx.save();
  ctx.translate(clip.x * W, clip.y * H);
  ctx.rotate(clip.rotation);
  ctx.font = fontCss(font, L.fontPx);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const top = -L.height / 2 + L.padY;
  const xFor = (w: number) =>
    clip.align === 'left' ? -L.width / 2 + L.padX : clip.align === 'right' ? L.width / 2 - L.padX - w : -w / 2;

  if (clip.style === 'background') {
    ctx.fillStyle = color;
    L.lines.forEach((line, i) => {
      if (!line.trim()) return;
      const w = L.widths[i];
      roundRect(ctx, xFor(w) - L.padX, top + i * L.lineH - L.padY * 0.5, w + L.padX * 2, L.lineH + L.padY, L.fontPx * 0.24);
      ctx.fill();
    });
  }

  const fill = clip.style === 'background' ? contrastOn(color) : color;
  if (clip.style === 'shadow') {
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = L.fontPx * 0.3;
    ctx.shadowOffsetY = L.fontPx * 0.06;
  }
  L.lines.forEach((line, i) => {
    const x = xFor(L.widths[i]);
    const y = top + i * L.lineH + L.lineH / 2;
    if (clip.style === 'outline') {
      ctx.strokeStyle = contrastOn(color);
      ctx.lineWidth = L.fontPx * 0.16;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
  return L;
}

/** Corners of the text box in canvas pixels (for hit testing and handles). */
export function textBox(ctx: Ctx2D, clip: TextClip, W: number, H: number) {
  const L = layoutText(ctx, clip, W, H);
  return { cx: clip.x * W, cy: clip.y * H, w: L.width, h: L.height, rotation: clip.rotation };
}

export function hitText(box: ReturnType<typeof textBox>, px: number, py: number, margin = 0): boolean {
  const dx = px - box.cx;
  const dy = py - box.cy;
  const c = Math.cos(-box.rotation);
  const s = Math.sin(-box.rotation);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= box.w / 2 + margin && Math.abs(ly) <= box.h / 2 + margin;
}
