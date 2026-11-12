import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Share } from 'lucide-react';
import { projectDuration } from '../../lib/timeline';
import { formatBytes, formatTime } from '../../lib/util';
import { player } from '../../lib/engine/player';
import { downloadFile, estimateSize, exportProject, shareFile, type ExportProgress, type ExportSettings } from '../../lib/engine/exporter';
import { FORMATS } from '../../lib/formats';
import { deletePath } from '../../lib/storage/opfs';
import { useEditor } from '../../state/editor';
import { Modal, ProgressBar, Segmented } from '../ui';

type State =
  | { phase: 'setup' }
  | { phase: 'running'; progress: ExportProgress }
  | { phase: 'done'; file: File; url: string }
  | { phase: 'error'; message: string };

export function ExportDialog({ onClose }: { onClose(): void }) {
  const project = useEditor((s) => s.project)!;
  const media = useEditor((s) => s.media);
  const [settings, setSettings] = useState<ExportSettings>({ resolution: '1080', fps: 30 });
  const [state, setState] = useState<State>({ phase: 'setup' });
  const abort = useRef<AbortController | null>(null);
  const duration = projectDuration(project);

  useEffect(
    () => () => {
      abort.current?.abort();
      // The exported file is only kept while the dialog is open.
      void deletePath('exports');
    },
    [],
  );
  useEffect(() => {
    if (state.phase === 'done') return () => URL.revokeObjectURL(state.url);
  }, [state]);

  const start = async () => {
    player.pause();
    const ac = new AbortController();
    abort.current = ac;
    setState({ phase: 'running', progress: { phase: 'prepare', progress: 0 } });
    try {
      const file = await exportProject(project, media, settings, (progress) => setState({ phase: 'running', progress }), ac.signal);
      setState({ phase: 'done', file, url: URL.createObjectURL(file) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') setState({ phase: 'setup' });
      else {
        console.error(e);
        setState({ phase: 'error', message: (e as Error).message || "L'export a échoué." });
      }
    } finally {
      abort.current = null;
    }
  };

  const running = state.phase === 'running';
  return (
    <Modal onClose={running ? undefined : onClose} className="export-dialog">
      {state.phase === 'setup' && (
        <>
          <h2>Exporter la vidéo</h2>
          <p className="muted">
            {FORMATS[project.format].label} · {formatTime(duration)}
          </p>
          <div className="export-field">
            <span className="field-label">Qualité</span>
            <Segmented
              value={settings.resolution}
              onChange={(resolution) => setSettings((s) => ({ ...s, resolution }))}
              options={[
                { value: '1080', label: '1080p · recommandé' },
                { value: '4k', label: '4K · qualité max' },
              ]}
            />
          </div>
          <div className="export-field">
            <span className="field-label">Images par seconde</span>
            <Segmented
              value={String(settings.fps) as '30' | '60'}
              onChange={(v) => setSettings((s) => ({ ...s, fps: v === '60' ? 60 : 30 }))}
              options={[
                { value: '30', label: '30 i/s' },
                { value: '60', label: '60 i/s · plus fluide' },
              ]}
            />
          </div>
          <p className="hint">Taille estimée : environ {formatBytes(estimateSize(duration, settings))}.</p>
          <button className="btn-primary big full" onClick={() => void start()} disabled={duration <= 0}>
            Exporter
          </button>
        </>
      )}

      {state.phase === 'running' && (
        <div className="export-running">
          <h2>Export en cours…</h2>
          <div className="export-percent">{Math.round(state.progress.phase === 'video' ? state.progress.progress * 100 : state.progress.phase === 'finalize' ? 100 : 0)} %</div>
          <ProgressBar value={state.progress.phase === 'video' ? state.progress.progress : state.progress.phase === 'finalize' ? 1 : 0.02} />
          <p className="muted">
            {state.progress.phase === 'prepare' && 'Préparation…'}
            {state.progress.phase === 'audio' && 'Mixage du son…'}
            {state.progress.phase === 'video' && (state.progress.eta !== undefined ? `Encore environ ${formatTime(state.progress.eta)}` : 'Calcul des images…')}
            {state.progress.phase === 'finalize' && 'Finalisation…'}
          </p>
          <p className="hint">Garde l'app ouverte et l'écran allumé pendant l'export.</p>
          <button className="btn-secondary" onClick={() => abort.current?.abort()}>
            Annuler
          </button>
        </div>
      )}

      {state.phase === 'done' && (
        <div className="export-done">
          <div className="done-head">
            <CheckCircle2 size={26} />
            <h2>Ta vidéo est prête</h2>
          </div>
          <video className={`done-video ${FORMATS[project.format].vertical ? 'v' : 'h'}`} src={state.url} controls playsInline />
          <p className="muted">
            {state.file.name} · {formatBytes(state.file.size)}
          </p>
          <button className="btn-primary big full" onClick={() => void shareFile(state.file)}>
            <Share size={18} /> Enregistrer ou partager
          </button>
          <p className="hint">Choisis « Enregistrer la vidéo » pour l'ajouter à Photos, ou envoie-la directement à TikTok ou Instagram.</p>
          <div className="button-row">
            <button className="btn-secondary" onClick={() => downloadFile(state.file)}>
              <Download size={16} /> Télécharger
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Terminé
            </button>
          </div>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="export-error">
          <h2>L'export n'a pas abouti</h2>
          <p>{state.message}</p>
          <div className="button-row">
            <button className="btn-primary" onClick={() => setState({ phase: 'setup' })}>
              Réessayer
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
