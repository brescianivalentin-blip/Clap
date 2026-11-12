import { create } from 'zustand';
import type { MediaItem, Project, Selection } from '../lib/types';
import { compactLanes, findClip } from '../lib/timeline';
import { saveProject } from '../lib/storage/db';
import { player } from '../lib/engine/player';
import { disposeSources } from '../lib/media/sources';

export type Panel = 'speed' | 'volume' | 'framing' | 'text' | 'format' | 'audio' | 'music' | 'export';

export interface ImportState {
  index: number;
  total: number;
  name: string;
  label: string;
  progress: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface EditorState {
  project: Project | null;
  media: Map<string, MediaItem>;
  past: Project[];
  future: Project[];
  gestureBase: Project | null;
  selection: Selection | null;
  panel: Panel | null;
  zoom: number;
  importing: ImportState | null;
  toast: Toast | null;
  saveState: 'saved' | 'saving';

  openProject(p: Project, media: MediaItem[]): void;
  closeProject(): void;
  commit(next: Project): void;
  edit(fn: (p: Project) => Project): void;
  beginGesture(): void;
  gesture(fn: (base: Project) => Project): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(sel: Selection | null): void;
  setPanel(panel: Panel | null): void;
  setZoom(z: number): void;
  addMedia(m: MediaItem): void;
  setImporting(s: ImportState | null): void;
  showToast(text: string, kind?: Toast['kind']): void;
}

const HISTORY = 80;
let toastSeq = 0;

function validSelection(p: Project, sel: Selection | null): Selection | null {
  return sel && findClip(p, sel) ? sel : null;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  media: new Map(),
  past: [],
  future: [],
  gestureBase: null,
  selection: null,
  panel: null,
  zoom: 60,
  importing: null,
  toast: null,
  saveState: 'saved',

  openProject(p, media) {
    set({
      project: p,
      media: new Map(media.map((m) => [m.id, m])),
      past: [],
      future: [],
      gestureBase: null,
      selection: null,
      panel: null,
      zoom: 60,
      saveState: 'saved',
    });
  },

  closeProject() {
    void flushSave();
    set({ project: null, media: new Map(), past: [], future: [], selection: null, panel: null, gestureBase: null });
    disposeSources();
  },

  commit(next) {
    const { project, gestureBase } = get();
    let { past } = get();
    if (!project || next === project) return;
    // An unfinished gesture (e.g. typing) becomes its own history step.
    if (gestureBase && gestureBase !== project) past = [...past, gestureBase];
    const n = compactLanes(next);
    set({
      project: n,
      past: [...past.slice(-HISTORY + 1), project],
      future: [],
      gestureBase: null,
      selection: validSelection(n, get().selection),
    });
  },

  edit(fn) {
    const p = get().project;
    if (p) get().commit(fn(p));
  },

  beginGesture() {
    const p = get().project;
    if (p) set({ gestureBase: p });
  },

  gesture(fn) {
    const base = get().gestureBase ?? get().project;
    if (!base) return;
    set({ project: fn(base) });
  },

  endGesture() {
    const { gestureBase, project, past } = get();
    if (!gestureBase || !project) {
      set({ gestureBase: null });
      return;
    }
    if (gestureBase === project) {
      set({ gestureBase: null });
      return;
    }
    const n = compactLanes(project);
    set({ project: n, gestureBase: null, past: [...past.slice(-HISTORY + 1), gestureBase], future: [] });
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length || !project) return;
    const prev = past[past.length - 1];
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY),
      selection: validSelection(prev, get().selection),
    });
  },

  redo() {
    const { past, project, future } = get();
    if (!future.length || !project) return;
    const next = future[0];
    set({
      project: next,
      future: future.slice(1),
      past: [...past, project].slice(-HISTORY),
      selection: validSelection(next, get().selection),
    });
  },

  select(sel) {
    const { panel, selection } = get();
    let next = panel;
    // Clip tool panels stay open only while the same kind of clip is selected.
    if (panel === 'speed' || panel === 'volume' || panel === 'framing' || panel === 'text') {
      if (!sel || !selection || sel.type !== selection.type) next = null;
    }
    set({ selection: sel, panel: next });
  },

  setPanel(panel) {
    set({ panel });
  },

  setZoom(z) {
    set({ zoom: Math.min(800, Math.max(4, z)) });
  },

  addMedia(m) {
    const media = new Map(get().media);
    media.set(m.id, m);
    set({ media });
  },

  setImporting(s) {
    set({ importing: s });
  },

  showToast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toast: { id, text, kind } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, kind === 'error' ? 6000 : 3200);
  },
}));

// ---- Keep the preview player in sync and save automatically ----

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Project | null = null;

export async function flushSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const p = pending;
  pending = null;
  if (!p) return;
  try {
    await saveProject({ ...p, updatedAt: Date.now() });
  } catch (e) {
    console.error('save failed', e);
    useEditor.getState().showToast("La sauvegarde a échoué. Vérifie l'espace de stockage de l'iPad.", 'error');
  }
  if (!pending) useEditor.setState({ saveState: 'saved' });
}

useEditor.subscribe((s, prev) => {
  if (s.project !== prev.project || s.media !== prev.media) {
    player.setProject(s.project, s.media);
  }
  if (s.project && s.project !== prev.project && prev.project && s.project.id === prev.project.id) {
    pending = s.project;
    if (s.saveState !== 'saving') useEditor.setState({ saveState: 'saving' });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 600);
  }
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSave();
  });
  window.addEventListener('pagehide', () => void flushSave());
}
