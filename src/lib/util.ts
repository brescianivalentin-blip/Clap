export const uid = (): string =>
  Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** "0:07", "1:24" — or with tenths "0:07.4". */
export function formatTime(t: number, tenths = false): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const total = tenths ? Math.floor(t * 10) / 10 : Math.floor(t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}

/** Short duration label: "4,2 s", "1 min 05". */
export function formatDuration(t: number): string {
  if (t < 60) return `${t.toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m} min ${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
}

export function relativeDate(ts: number): string {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) {
    const d = Math.floor(diff / 86400);
    return d === 1 ? 'hier' : `il y a ${d} jours`;
  }
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
