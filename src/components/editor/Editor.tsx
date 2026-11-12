import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Check,
  ChevronLeft,
  Copy,
  Crop,
  Gauge,
  ImagePlus,
  Music,
  Pause,
  Pencil,
  Play,
  Ratio,
  Redo2,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Volume2,
  X,
} from 'lucide-react';
import type { Selection } from '../../lib/types';
import { deleteSelection, detachAudio, duplicateSelection, findClip, projectDuration, splitAt } from '../../lib/timeline';
import { formatTime } from '../../lib/util';
import { player } from '../../lib/engine/player';
import { deleteAsset, putAsset } from '../../lib/storage/db';
import { flushSave, useEditor } from '../../state/editor';
import { useApp } from '../../state/app';
import { addText, importVisual } from '../../state/actions';
import { pickFiles } from '../files';
import { ProgressBar, ToastHost } from '../ui';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { PanelHost, primeKeyboard } from './panels';
import { ExportDialog } from './ExportDialog';

function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      root.style.setProperty('--vvh', `${h}px`);
      root.style.setProperty('--vvtop', `${top}px`);
      const kb = vv ? Math.max(0, window.innerHeight - vv.height) : 0;
      root.classList.toggle('kb-open', kb > 120);
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.classList.remove('kb-open');
    };
  }, []);
}

async function saveCover(projectId: string, empty: boolean) {
  try {
    if (empty) {
      await deleteAsset(`cover:${projectId}`);
      return;
    }
    const blob = await player.snapshot();
    if (blob) await putAsset(`cover:${projectId}`, blob);
  } catch {
    /* cover is optional */
  }
}

function TopBar({ onExport }: { onExport(): void }) {
  const project = useEditor((s) => s.project)!;
  const saveState = useEditor((s) => s.saveState);
  const back = async () => {
    player.pause();
    await saveCover(project.id, project.video.length === 0 && project.texts.length === 0);
    await flushSave();
    useEditor.getState().closeProject();
    useApp.getState().go('home');
  };
  const rename = () => {
    const name = window.prompt('Nom du projet', project.name)?.trim();
    if (name && name !== project.name) useEditor.getState().edit((p) => ({ ...p, name }));
  };
  return (
    <header className="topbar">
      <button className="tb-back" onClick={() => void back()}>
        <ChevronLeft size={22} />
        <span>Projets</span>
      </button>
      <button className="tb-title" onClick={rename}>
        {project.name}
      </button>
      <div className="tb-right">
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? (
            <>
              <Check size={14} strokeWidth={3} /> Enregistré
            </>
          ) : (
            'Enregistrement…'
          )}
        </span>
        <button className="btn-primary" onClick={onExport} disabled={projectDuration(project) <= 0}>
          Exporter
        </button>
      </div>
    </header>
  );
}

function Transport() {
  const project = useEditor((s) => s.project)!;
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(player.playing);
  useEffect(
    () =>
      player.subscribe((t, pl) => {
        if (timeRef.current) timeRef.current.textContent = formatTime(t);
        setPlaying(pl);
      }),
    [],
  );
  return (
    <div className="transport">
      <div className="tr-time">
        <span ref={timeRef}>{formatTime(player.time)}</span>
        <span className="tr-total"> / {formatTime(projectDuration(project))}</span>
      </div>
      <button className="tr-play" onClick={() => player.toggle()} aria-label={playing ? 'Pause' : 'Lecture'}>
        {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
      </button>
      <div className="tr-history">
        <button onClick={() => useEditor.getState().undo()} disabled={!canUndo} aria-label="Annuler">
          <Undo2 size={20} />
        </button>
        <button onClick={() => useEditor.getState().redo()} disabled={!canRedo} aria-label="Rétablir">
          <Redo2 size={20} />
        </button>
      </div>
    </div>
  );
}

interface Tool {
  id: string;
  label: string;
  icon: React.ReactNode;
  run(): void;
  danger?: boolean;
  active?: boolean;
}

function doSplit() {
  const ed = useEditor.getState();
  const p = ed.project!;
  const r = splitAt(p, ed.selection, player.time);
  if (!r) {
    ed.showToast('Place la ligne blanche sur le clip, là où tu veux couper.');
    return;
  }
  ed.commit(r.project);
  if (ed.selection) ed.select(r.selection);
}

function Toolbar() {
  const selection = useEditor((s) => s.selection);
  const panel = useEditor((s) => s.panel);
  const project = useEditor((s) => s.project)!;
  const ed = useEditor.getState;
  const clip = findClip(project, selection);

  const remove = (sel: Selection) => {
    ed().commit(deleteSelection(ed().project!, sel));
    ed().select(null);
  };
  const duplicate = (sel: Selection) => {
    const r = duplicateSelection(ed().project!, sel);
    if (r) {
      ed().commit(r.project);
      ed().select(r.selection);
    }
  };
  const openPanel = (p: Parameters<ReturnType<typeof ed>['setPanel']>[0]) => ed().setPanel(panel === p ? null : p);

  let tools: Tool[];
  if (!selection || !clip) {
    tools = [
      { id: 'import', label: 'Importer', icon: <ImagePlus size={22} />, run: () => pickFiles('visual', (f) => void importVisual(f)) },
      { id: 'split', label: 'Diviser', icon: <Scissors size={22} />, run: doSplit },
      { id: 'audio', label: 'Audio', icon: <Music size={22} />, run: () => openPanel('audio'), active: panel === 'audio' || panel === 'music' },
      {
        id: 'text',
        label: 'Texte',
        icon: <Type size={22} />,
        run: () => {
          primeKeyboard();
          addText();
        },
      },
      { id: 'format', label: 'Format', icon: <Ratio size={22} />, run: () => openPanel('format'), active: panel === 'format' },
    ];
  } else if (selection.type === 'video') {
    const isVideo = 'kind' in clip && clip.kind === 'video';
    tools = [
      { id: 'split', label: 'Diviser', icon: <Scissors size={22} />, run: doSplit },
      ...(isVideo
        ? [
            { id: 'speed', label: 'Vitesse', icon: <Gauge size={22} />, run: () => openPanel('speed'), active: panel === 'speed' },
            { id: 'volume', label: 'Volume', icon: <Volume2 size={22} />, run: () => openPanel('volume'), active: panel === 'volume' },
          ]
        : []),
      { id: 'framing', label: 'Cadrage', icon: <Crop size={22} />, run: () => openPanel('framing'), active: panel === 'framing' },
      ...(isVideo
        ? [
            {
              id: 'detach',
              label: 'Séparer le son',
              icon: <AudioLines size={22} />,
              run: () => {
                const m = ed().media.get((clip as { mediaId: string }).mediaId);
                if (!m?.hasAudio) return ed().showToast("Cette vidéo n'a pas de son.");
                const r = detachAudio(ed().project!, selection.id);
                if (!r) return ed().showToast('Le son de ce clip est déjà séparé.');
                ed().commit(r.project);
                ed().select({ type: 'audio', id: r.id });
                ed().showToast('Le son est maintenant sur sa propre piste.');
              },
            },
          ]
        : []),
      { id: 'dup', label: 'Dupliquer', icon: <Copy size={22} />, run: () => duplicate(selection) },
      { id: 'del', label: 'Supprimer', icon: <Trash2 size={22} />, run: () => remove(selection), danger: true },
    ];
  } else if (selection.type === 'audio') {
    tools = [
      { id: 'split', label: 'Diviser', icon: <Scissors size={22} />, run: doSplit },
      { id: 'volume', label: 'Volume', icon: <Volume2 size={22} />, run: () => openPanel('volume'), active: panel === 'volume' },
      { id: 'speed', label: 'Vitesse', icon: <Gauge size={22} />, run: () => openPanel('speed'), active: panel === 'speed' },
      { id: 'dup', label: 'Dupliquer', icon: <Copy size={22} />, run: () => duplicate(selection) },
      { id: 'del', label: 'Supprimer', icon: <Trash2 size={22} />, run: () => remove(selection), danger: true },
    ];
  } else {
    tools = [
      {
        id: 'edit',
        label: 'Modifier',
        icon: <Pencil size={22} />,
        run: () => {
          primeKeyboard();
          ed().setPanel('text');
        },
        active: panel === 'text',
      },
      { id: 'split', label: 'Diviser', icon: <Scissors size={22} />, run: doSplit },
      { id: 'dup', label: 'Dupliquer', icon: <Copy size={22} />, run: () => duplicate(selection) },
      { id: 'del', label: 'Supprimer', icon: <Trash2 size={22} />, run: () => remove(selection), danger: true },
    ];
  }

  return (
    <nav className="toolbar">
      {selection && (
        <button className="tool close" onClick={() => ed().select(null)} aria-label="Désélectionner">
          <span className="tool-icon">
            <X size={22} />
          </span>
          <span className="tool-label">Fermer</span>
        </button>
      )}
      <div className="tools">
        {tools.map((t) => (
          <button key={t.id} className={`tool${t.danger ? ' danger' : ''}${t.active ? ' active' : ''}`} onClick={t.run}>
            <span className="tool-icon">{t.icon}</span>
            <span className="tool-label">{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function ImportOverlay() {
  const importing = useEditor((s) => s.importing);
  if (!importing) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal import-modal">
        <h2>Importation{importing.total > 1 ? ` ${importing.index + 1}/${importing.total}` : ''}</h2>
        <p className="muted ellipsis">{importing.name}</p>
        <ProgressBar value={importing.progress} />
        <p className="hint">{importing.label}…</p>
      </div>
    </div>
  );
}

export function Editor() {
  const project = useEditor((s) => s.project);
  const panel = useEditor((s) => s.panel);
  const [exporting, setExporting] = useState(false);
  useVisualViewport();

  // Keyboard shortcuts (iPad with keyboard, or computer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      const ed = useEditor.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) ed.redo();
        else ed.undo();
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && ed.selection) {
        ed.commit(deleteSelection(ed.project!, ed.selection));
        ed.select(null);
      } else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        doSplit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!project) return null;
  return (
    <div className={`editor${panel ? ` panel-${panel}` : ''}`}>
      <TopBar onExport={() => setExporting(true)} />
      <Preview />
      <Transport />
      <div className="bottom">
        <Timeline />
        <Toolbar />
        <PanelHost />
      </div>
      <textarea id="kb-proxy" className="kb-proxy" tabIndex={-1} aria-hidden defaultValue="" />
      <ImportOverlay />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      <ToastHost />
    </div>
  );
}
