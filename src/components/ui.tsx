import { useRef, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { clamp } from '../lib/util';
import { useEditor } from '../state/editor';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  onChange(v: number): void;
  onStart?(): void;
  onEnd?(): void;
  log?: boolean;
  step?: number;
  /** Values the thumb sticks to when close. */
  detents?: number[];
  label?: string;
}

/** Touch friendly slider: tap or drag anywhere on the track. */
export function Slider({ value, min, max, onChange, onStart, onEnd, log, step, detents, label }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));
  const update = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const p = clamp((clientX - r.left) / r.width, 0, 1);
    let v = fromPos(p);
    if (detents) {
      for (const d of detents) if (Math.abs(toPos(d) - p) < 0.025) v = d;
    }
    if (step) v = Math.round(v / step) * step;
    onChange(clamp(v, min, max));
  };
  const pos = clamp(toPos(value), 0, 1) * 100;
  return (
    <div
      ref={ref}
      className="slider"
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        active.current = true;
        onStart?.();
        update(e.clientX);
      }}
      onPointerMove={(e) => active.current && update(e.clientX)}
      onPointerUp={() => {
        if (!active.current) return;
        active.current = false;
        onEnd?.();
      }}
      onPointerCancel={() => {
        if (!active.current) return;
        active.current = false;
        onEnd?.();
      }}
    >
      <div className="slider-track">
        <div className="slider-fill" style={{ width: `${pos}%` }} />
        {detents?.map((d) => (
          <div key={d} className="slider-detent" style={{ left: `${clamp(toPos(d), 0, 1) * 100}%` }} />
        ))}
      </div>
      <div className="slider-thumb" style={{ left: `${pos}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange(v: T): void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function PanelSheet({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  return (
    <div className={`panel-sheet${wide ? ' wide' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <button className="panel-done" onClick={onClose} aria-label="Valider">
          <Check size={20} strokeWidth={2.6} />
        </button>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Modal({ children, onClose, className }: { children: ReactNode; onClose?(): void; className?: string }) {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${className ?? ''}`}>
        {onClose && (
          <button className="modal-close" onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function ToastHost() {
  const toast = useEditor((s) => s.toast);
  if (!toast) return null;
  return (
    <div key={toast.id} className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  );
}

export function Spinner({ size = 22 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress">
      <div className="progress-fill" style={{ width: `${clamp(value, 0, 1) * 100}%` }} />
    </div>
  );
}
