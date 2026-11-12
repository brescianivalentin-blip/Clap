import type { VideoSample } from 'mediabunny';
import type { Framing, Project, TextClip, VideoClip } from '../types';
import { textEnd } from '../timeline';
import { drawText, type Ctx2D } from './text';

export type FrameSource =
  | { type: 'sample'; sample: VideoSample }
  | { type: 'bitmap'; bitmap: ImageBitmap };

function sourceSize(src: FrameSource): [number, number] {
  return src.type === 'sample'
    ? [src.sample.displayWidth, src.sample.displayHeight]
    : [src.bitmap.width, src.bitmap.height];
}

function drawSource(ctx: Ctx2D, src: FrameSource, x: number, y: number, w: number, h: number) {
  if (src.type === 'sample') src.sample.draw(ctx, x, y, w, h);
  else ctx.drawImage(src.bitmap, x, y, w, h);
}

let blurSmall: HTMLCanvasElement | OffscreenCanvas | null = null;

function smallCanvas(w: number, h: number) {
  if (!blurSmall) blurSmall = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (blurSmall.width !== w || blurSmall.height !== h) {
    blurSmall.width = w;
    blurSmall.height = h;
  }
  return blurSmall;
}

/** Soft blurred copy of the frame behind "fit" clips (no ctx.filter needed: downscale then upscale). */
function drawBlurBackground(ctx: Ctx2D, W: number, H: number, src: FrameSource, rot: number) {
  const sw = Math.max(8, Math.round(W / 48));
  const sh = Math.max(8, Math.round(H / 48));
  const small = smallCanvas(sw, sh);
  const sctx = small.getContext('2d') as Ctx2D | null;
  if (!sctx) return;
  const [dw, dh] = sourceSize(src);
  const effW = rot % 180 ? dh : dw;
  const effH = rot % 180 ? dw : dh;
  const s = Math.max(sw / effW, sh / effH) * 1.15;
  sctx.save();
  sctx.imageSmoothingEnabled = true;
  sctx.translate(sw / 2, sh / 2);
  sctx.rotate((rot * Math.PI) / 180);
  sctx.scale(s, s);
  drawSource(sctx, src, -dw / 2, -dh / 2, dw, dh);
  sctx.restore();
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small as CanvasImageSource, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export function baseScale(framing: Framing, srcW: number, srcH: number, W: number, H: number): number {
  const rot = ((framing.rotation % 360) + 360) % 360;
  const effW = rot % 180 ? srcH : srcW;
  const effH = rot % 180 ? srcW : srcH;
  return framing.mode === 'fill' ? Math.max(W / effW, H / effH) : Math.min(W / effW, H / effH);
}

export function drawVideoLayer(ctx: Ctx2D, W: number, H: number, src: FrameSource, framing: Framing) {
  const rot = ((framing.rotation % 360) + 360) % 360;
  const [dw, dh] = sourceSize(src);
  if (!dw || !dh) return;
  if (framing.mode === 'fit') drawBlurBackground(ctx, W, H, src, rot);
  const s = baseScale(framing, dw, dh, W, H) * framing.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2 + framing.x * W, H / 2 + framing.y * H);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(s, s);
  drawSource(ctx, src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export function activeTexts(p: Project, t: number): TextClip[] {
  return p.texts.filter((x) => t >= x.start && t < textEnd(x)).sort((a, b) => b.lane - a.lane);
}

export function drawComposite(
  ctx: Ctx2D,
  W: number,
  H: number,
  project: Project,
  t: number,
  frame: FrameSource | null,
  clip: VideoClip | null,
) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (frame && clip) drawVideoLayer(ctx, W, H, frame, clip.framing);
  for (const tx of activeTexts(project, t)) drawText(ctx, tx, W, H);
}
