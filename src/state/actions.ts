import type { MediaItem, Project } from '../lib/types';
import {
  addAudioClip,
  addTextClip,
  createProject,
  insertionIndexAt,
  insertVideoClips,
  makeVideoClip,
  projectDuration,
  videoEnd,
  videoLayout,
} from '../lib/timeline';
import { getProject, mediaForProject, saveProject } from '../lib/storage/db';
import { importFile, ImportError, type ImportStage } from '../lib/media/importer';
import { player } from '../lib/engine/player';
import type { FormatId } from '../lib/types';
import { useEditor } from './editor';
import { useApp } from './app';
import { requestPersistence, storageMode } from '../lib/storage/opfs';

const STAGE_LABEL: Record<ImportStage, string> = {
  copy: 'Copie',
  analyze: 'Analyse',
  thumbs: 'Aperçus',
  audio: 'Son',
};

const STAGE_WEIGHT: Record<ImportStage, [number, number]> = {
  copy: [0, 0.45],
  analyze: [0.45, 0.5],
  thumbs: [0.5, 0.85],
  audio: [0.85, 1],
};

export async function newProject(format: FormatId): Promise<Project> {
  const n = new Date();
  const name = `Vidéo du ${n.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  const p = createProject(name, format);
  await saveProject(p);
  void requestPersistence();
  useEditor.getState().openProject(p, []);
  useApp.getState().go('editor');
  void storageMode().then((m) => {
    if (m === 'memory') {
      useEditor
        .getState()
        .showToast("Le stockage de l'iPad n'est pas disponible (navigation privée ?) : ce projet ne sera pas conservé.", 'error');
    }
  });
  return p;
}

export async function openProject(id: string) {
  const p = await getProject(id);
  if (!p) return;
  const media = await mediaForProject(id);
  void requestPersistence();
  useEditor.getState().openProject(p, media);
  useApp.getState().go('editor');
}

async function importAll(files: File[], projectId: string): Promise<MediaItem[]> {
  const ed = useEditor.getState();
  const imported: MediaItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const m = await importFile(f, projectId, (stage, p) => {
        const [a, b] = STAGE_WEIGHT[stage];
        useEditor.getState().setImporting({
          index: i,
          total: files.length,
          name: f.name,
          label: STAGE_LABEL[stage],
          progress: a + (b - a) * p,
        });
      });
      imported.push(m);
      useEditor.getState().addMedia(m);
    } catch (e) {
      errors.push(e instanceof ImportError ? e.message : `Import impossible pour « ${f.name} ».`);
    }
  }
  ed.setImporting(null);
  if (errors.length) ed.showToast(errors.length === 1 ? errors[0] : `${errors.length} fichiers n'ont pas pu être importés. ${errors[0]}`, 'error');
  return imported;
}

/** Imports videos / photos onto the main track (sounds go on an audio track). */
export async function importVisual(files: File[]) {
  const project = useEditor.getState().project;
  if (!project || !files.length) return;
  player.pause();
  useEditor.getState().setImporting({ index: 0, total: files.length, name: files[0].name, label: 'Copie', progress: 0 });
  const imported = await importAll(files, project.id);
  if (!imported.length) return;
  const ed = useEditor.getState();
  let p = ed.project!;
  const visual = imported.filter((m) => m.kind !== 'audio');
  const sounds = imported.filter((m) => m.kind === 'audio');
  const t = player.time;
  let firstStart = 0;
  if (visual.length) {
    const idx = insertionIndexAt(p, t);
    p = insertVideoClips(p, visual.map((m) => makeVideoClip(m, p.format)), idx);
    firstStart = videoLayout(p)[idx]?.start ?? 0;
  }
  for (const m of sounds) p = addAudioClip(p, m, 'import', audioStartFor(p, t)).project;
  ed.commit(p);
  if (visual.length) player.seek(firstStart);
}

function audioStartFor(p: Project, t: number): number {
  const end = videoEnd(p);
  return end > 0 && t >= end - 0.2 ? 0 : t;
}

/** Imports sounds (voice-over, music files…) on audio tracks at the playhead. */
export async function importAudio(files: File[]) {
  const project = useEditor.getState().project;
  if (!project || !files.length) return;
  player.pause();
  useEditor.getState().setImporting({ index: 0, total: files.length, name: files[0].name, label: 'Copie', progress: 0 });
  const imported = await importAll(files, project.id);
  if (!imported.length) return;
  const ed = useEditor.getState();
  let p = ed.project!;
  const start = audioStartFor(p, player.time);
  let lastId: string | null = null;
  for (const m of imported) {
    if (m.kind === 'audio' || m.hasAudio) {
      const r = addAudioClip(p, m, 'import', start);
      p = r.project;
      lastId = r.id;
    }
  }
  ed.commit(p);
  if (lastId) ed.select({ type: 'audio', id: lastId });
  ed.setPanel(null);
}

export interface LibraryTrack {
  id: string;
  title: string;
  artist: string;
  mood: string;
  duration: number;
  file: string;
  license: string;
  source: string;
}

export async function addLibraryTrack(track: LibraryTrack) {
  const ed = useEditor.getState();
  const project = ed.project;
  if (!project) return;
  player.pause();
  let media = [...ed.media.values()].find((m) => m.libraryId === track.id);
  if (!media) {
    ed.setImporting({ index: 0, total: 1, name: track.title, label: 'Téléchargement', progress: 0 });
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}music/${track.file}`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const file = new File([blob], `${track.title}.${track.file.split('.').pop()}`, { type: blob.type || 'audio/mpeg' });
      media = await importFile(file, project.id, (stage, p) => {
        const [a, b] = STAGE_WEIGHT[stage];
        useEditor.getState().setImporting({ index: 0, total: 1, name: track.title, label: STAGE_LABEL[stage], progress: a + (b - a) * p });
      }, track.id);
      useEditor.getState().addMedia(media);
    } catch (e) {
      console.error(e);
      useEditor.getState().setImporting(null);
      useEditor.getState().showToast(`Impossible d'ajouter « ${track.title} ». Vérifie la connexion internet.`, 'error');
      return;
    }
    useEditor.getState().setImporting(null);
  }
  const st = useEditor.getState();
  const p = st.project!;
  const r = addAudioClip(p, media, 'music', audioStartFor(p, player.time));
  st.commit(r.project);
  st.select({ type: 'audio', id: r.id });
  st.setPanel(null);
  st.showToast(`« ${track.title} » ajoutée`);
}

export function addText() {
  const ed = useEditor.getState();
  const p = ed.project;
  if (!p) return;
  player.pause();
  const t = player.time;
  const total = projectDuration(p);
  let start = t;
  if (total > 0 && start >= total - 0.3) start = Math.max(0, total - 3);
  const duration = total > 0 ? Math.max(0.5, Math.min(3, total - start)) : 3;
  const r = addTextClip(p, {
    start,
    duration,
    text: 'Ton texte',
    font: 'classique',
    color: 'white',
    style: 'outline',
    size: 0.075,
    x: 0.5,
    y: 0.42,
    rotation: 0,
    align: 'center',
  });
  ed.commit(r.project);
  ed.select({ type: 'text', id: r.id });
  ed.setPanel('text');
  if (start !== t) player.seek(start + 0.01);
}
