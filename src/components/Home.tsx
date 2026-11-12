import { useEffect, useRef, useState } from 'react';
import { Clapperboard, MoreHorizontal, Plus, Share, Smartphone, MonitorPlay, X } from 'lucide-react';
import type { FormatId, Project } from '../lib/types';
import { FORMAT_LIST, FORMATS } from '../lib/formats';
import { deleteProject, listProjects, saveProject } from '../lib/storage/db';
import { storageEstimate } from '../lib/storage/opfs';
import { projectDuration } from '../lib/timeline';
import { formatBytes, formatTime, isIOS, isStandalone, relativeDate } from '../lib/util';
import { useCover, useThumbs } from '../lib/assets';
import { newProject, openProject, importVisual } from '../state/actions';
import { pickFiles } from './files';
import { Modal } from './ui';

export function FormatIcon({ format, size = 22 }: { format: FormatId; size?: number }) {
  const f = FORMATS[format];
  const w = f.vertical ? size * 0.62 : size;
  const h = f.vertical ? size : size * 0.62;
  return (
    <span className="format-icon" style={{ width: size, height: size }}>
      <span style={{ width: w, height: h }} />
    </span>
  );
}

function ThumbCanvas({ projectId, mediaId }: { projectId: string; mediaId?: string }) {
  const thumbs = useThumbs(mediaId);
  const cover = useCover(projectId);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || cover || !thumbs) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { size } = thumbs.sheet;
    const ta = c.width / c.height;
    const sw = ta > 1 ? size : size * ta;
    const sh = ta > 1 ? size / ta : size;
    ctx.drawImage(thumbs.img, (size - sw) / 2, (size - sh) / 2, sw, sh, 0, 0, c.width, c.height);
  }, [thumbs, cover]);
  if (cover) return <img className="cover-img" src={cover} alt="" />;
  if (!mediaId) return (
    <div className="cover-empty">
      <Clapperboard size={28} />
    </div>
  );
  return <canvas ref={ref} className="cover-img" />;
}

function ProjectCover({ project }: { project: Project }) {
  const vertical = FORMATS[project.format].vertical;
  return (
    <div className={`cover ${vertical ? 'v' : 'h'}`}>
      <ThumbCanvas projectId={project.id} mediaId={project.video[0]?.mediaId} />
      <span className="cover-duration">{formatTime(projectDuration(project))}</span>
    </div>
  );
}

function ProjectMenu({ project, onClose, onChanged }: { project: Project; onClose(): void; onChanged(): void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Modal onClose={onClose} className="sheet-menu">
      <div className="menu-title">{project.name}</div>
      {!confirm ? (
        <>
          <button
            className="menu-item"
            onClick={async () => {
              const name = window.prompt('Nouveau nom du projet', project.name)?.trim();
              if (name) {
                await saveProject({ ...project, name, updatedAt: Date.now() });
                onChanged();
              }
              onClose();
            }}
          >
            Renommer
          </button>
          <button className="menu-item danger" onClick={() => setConfirm(true)}>
            Supprimer le projet
          </button>
        </>
      ) : (
        <>
          <p className="menu-text">Le projet et les vidéos importées dedans seront supprimés de l'app. Les vidéos restent dans ta galerie Photos.</p>
          <button
            className="menu-item danger"
            onClick={async () => {
              await deleteProject(project.id);
              onChanged();
              onClose();
            }}
          >
            Supprimer définitivement
          </button>
          <button className="menu-item" onClick={() => setConfirm(false)}>
            Annuler
          </button>
        </>
      )}
    </Modal>
  );
}

function InstallHint() {
  const key = 'clap.installHint.dismissed';
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (hidden || isStandalone() || !isIOS()) return null;
  return (
    <div className="install-hint">
      <Smartphone size={22} />
      <div>
        <strong>Installe Clap sur ton écran d'accueil</strong>
        <span>
          Touche <Share size={14} className="inline-icon" /> Partager, puis « Sur l'écran d'accueil ». Clap s'ouvrira en plein écran, comme une app, et tes projets seront mieux protégés.
        </span>
      </div>
      <button
        aria-label="Masquer"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(key, '1');
          } catch {
            /* ignore */
          }
        }}
      >
        <X size={18} />
      </button>
    </div>
  );
}

export function FormatPicker({ onPick, onClose }: { onPick(f: FormatId): void; onClose(): void }) {
  return (
    <Modal onClose={onClose} className="format-picker">
      <h2>Pour quelle plateforme ?</h2>
      <p className="muted">Tu pourras changer de format à tout moment.</p>
      <div className="format-cards">
        {FORMAT_LIST.map((f) => (
          <button key={f.id} className="format-card" onClick={() => onPick(f.id)}>
            <span className={`format-shape ${f.vertical ? 'v' : 'h'}`}>{f.vertical ? <Smartphone size={26} /> : <MonitorPlay size={26} />}</span>
            <strong>{f.label}</strong>
            <span>{f.hint}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<Project | null>(null);
  const [usage, setUsage] = useState<number | null>(null);

  const refresh = () => {
    void listProjects().then(setProjects);
    void storageEstimate().then((e) => setUsage(e?.usage ?? null));
  };
  useEffect(refresh, []);

  const create = (format: FormatId) => {
    setPicking(false);
    let ready: Promise<unknown> = Promise.resolve();
    // Open the picker within the tap, then create the project while she chooses.
    pickFiles('visual', (files) => void ready.then(() => importVisual(files)));
    ready = newProject(format);
  };

  return (
    <div className="home">
      <header className="home-head">
        <div className="brand">
          <span className="brand-mark">
            <Clapperboard size={20} strokeWidth={2.4} />
          </span>
          <span className="brand-name">Clap</span>
        </div>
        {usage !== null && usage > 0 && <span className="home-usage">{formatBytes(usage)} utilisés</span>}
      </header>

      <main className="home-main">
        <section className="hero">
          <h1>Tes vidéos, montées en quelques gestes.</h1>
          <button className="new-project" onClick={() => setPicking(true)}>
            <span className="new-plus">
              <Plus size={28} strokeWidth={2.6} />
            </span>
            <span>
              <strong>Nouveau projet</strong>
              <span>TikTok, Reel Instagram ou YouTube</span>
            </span>
          </button>
        </section>

        <InstallHint />

        <section className="projects">
          <h2>Mes projets</h2>
          {projects === null ? null : projects.length === 0 ? (
            <p className="empty-projects">Tes projets apparaîtront ici. Ils sont enregistrés automatiquement sur cet appareil.</p>
          ) : (
            <div className="project-grid">
              {projects.map((p) => (
                <div key={p.id} className="project-card" onClick={() => void openProject(p.id)}>
                  <ProjectCover project={p} />
                  <div className="project-meta">
                    <div className="project-text">
                      <strong>{p.name}</strong>
                      <span>
                        <FormatIcon format={p.format} size={13} /> {FORMATS[p.format].label} · {relativeDate(p.updatedAt)}
                      </span>
                    </div>
                    <button
                      className="project-more"
                      aria-label="Options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(p);
                      }}
                    >
                      <MoreHorizontal size={20} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {picking && <FormatPicker onPick={create} onClose={() => setPicking(false)} />}
      {menu && <ProjectMenu project={menu} onClose={() => setMenu(null)} onChanged={refresh} />}
    </div>
  );
}
