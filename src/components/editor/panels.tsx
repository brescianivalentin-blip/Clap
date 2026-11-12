import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Check, Maximize, Minimize, MonitorPlay, Music, Pause, Play, Plus, RotateCw, Smartphone, Undo2, Upload } from 'lucide-react';
import type { AudioClip, TextAlign, TextClip, TextStyle, VideoClip } from '../../lib/types';
import { FORMAT_LIST } from '../../lib/formats';
import { MAX_SPEED, MIN_SPEED, clipDuration, findClip, updateAudioClip, updateTextClip, updateVideoClip } from '../../lib/timeline';
import { formatDuration, formatTime } from '../../lib/util';
import { COLORS, FONTS, colorHex, contrastOn, fontCss, getFont } from '../../lib/engine/fonts';
import { useEditor } from '../../state/editor';
import { addLibraryTrack, importAudio, type LibraryTrack } from '../../state/actions';
import { pickFiles } from '../files';
import { PanelSheet, Segmented, Slider, Spinner } from '../ui';

/** Focus a hidden field within the tap so that iPadOS opens the keyboard. */
export function primeKeyboard() {
  const el = document.getElementById('kb-proxy') as HTMLTextAreaElement | null;
  el?.focus({ preventScroll: true });
}

const fmtSpeed = (s: number) => s.toFixed(2).replace(/\.?0+$/, '').replace('.', ',');

function useSelectedClip() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  if (!project || !selection) return null;
  const clip = findClip(project, selection);
  return clip ? { selection, clip } : null;
}

function patchSelected(patch: Partial<VideoClip> & Partial<AudioClip> & Partial<TextClip>, mode: 'gesture' | 'commit') {
  const ed = useEditor.getState();
  const sel = ed.selection;
  if (!sel) return;
  const fn =
    sel.type === 'video'
      ? (p: Parameters<typeof updateVideoClip>[0]) => updateVideoClip(p, sel.id, patch)
      : sel.type === 'audio'
        ? (p: Parameters<typeof updateAudioClip>[0]) => updateAudioClip(p, sel.id, patch)
        : (p: Parameters<typeof updateTextClip>[0]) => updateTextClip(p, sel.id, patch);
  if (mode === 'gesture') ed.gesture(fn);
  else ed.edit(fn);
}

const gestureHandlers = {
  onStart: () => useEditor.getState().beginGesture(),
  onEnd: () => useEditor.getState().endGesture(),
};

// ---------------- Speed ----------------

function SpeedPanel() {
  const s = useSelectedClip();
  if (!s || s.selection.type === 'text') return null;
  const clip = s.clip as VideoClip | AudioClip;
  if ('kind' in clip && clip.kind === 'image') return <p className="hint">La vitesse s'applique aux vidéos et aux sons.</p>;
  const original = clip.out - clip.in;
  return (
    <div className="speed-panel">
      <div className="big-value">{fmtSpeed(clip.speed)}×</div>
      <Slider
        log
        min={MIN_SPEED}
        max={MAX_SPEED}
        value={clip.speed}
        detents={[0.5, 1, 2]}
        label="Vitesse"
        onChange={(v) => patchSelected({ speed: Math.round(v * 100) / 100 }, 'gesture')}
        {...gestureHandlers}
      />
      <div className="slider-scale">
        <span>Ralenti</span>
        <span style={{ left: `${(Math.log(1 / MIN_SPEED) / Math.log(MAX_SPEED / MIN_SPEED)) * 100}%` }}>Normal</span>
        <span>Accéléré</span>
      </div>
      <div className="chips">
        {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5].map((v) => (
          <button key={v} className={`chip${Math.abs(clip.speed - v) < 0.001 ? ' on' : ''}`} onClick={() => patchSelected({ speed: v }, 'commit')}>
            {fmtSpeed(v)}×
          </button>
        ))}
      </div>
      <p className="hint">
        Durée : {formatDuration(original)} → <strong>{formatDuration(clipDuration(clip))}</strong>. La voix garde un son naturel.
      </p>
    </div>
  );
}

// ---------------- Volume ----------------

function VolumePanel() {
  const s = useSelectedClip();
  const media = useEditor((st) => st.media);
  if (!s || s.selection.type === 'text') return null;
  const clip = s.clip as VideoClip | AudioClip;
  if ('kind' in clip) {
    if (clip.kind === 'image' || !media.get(clip.mediaId)?.hasAudio) return <p className="hint">Ce clip n'a pas de son.</p>;
    if (clip.audioDetached) return <p className="hint">Le son de ce clip a été séparé : touche-le sur sa piste audio pour le régler.</p>;
  }
  const dur = clipDuration(clip);
  const maxFade = Math.max(0.1, Math.min(5, dur / 2));
  return (
    <div className="volume-panel">
      <div className="row-between">
        <span className="field-label">Volume</span>
        <span className="field-value">{clip.muted ? 'Coupé' : `${Math.round(clip.volume * 100)} %`}</span>
      </div>
      <Slider min={0} max={2} value={clip.muted ? 0 : clip.volume} detents={[1]} label="Volume" onChange={(v) => patchSelected({ volume: Math.round(v * 100) / 100, muted: false }, 'gesture')} {...gestureHandlers} />
      <button className={`toggle${clip.muted ? ' on' : ''}`} onClick={() => patchSelected({ muted: !clip.muted }, 'commit')}>
        {clip.muted ? 'Rétablir le son' : 'Couper le son'}
      </button>
      <div className="two-cols">
        <div>
          <div className="row-between">
            <span className="field-label">Fondu d'entrée</span>
            <span className="field-value">{clip.fadeIn.toFixed(1).replace('.', ',')} s</span>
          </div>
          <Slider min={0} max={maxFade} value={Math.min(clip.fadeIn, maxFade)} step={0.1} label="Fondu d'entrée" onChange={(v) => patchSelected({ fadeIn: v }, 'gesture')} {...gestureHandlers} />
        </div>
        <div>
          <div className="row-between">
            <span className="field-label">Fondu de sortie</span>
            <span className="field-value">{clip.fadeOut.toFixed(1).replace('.', ',')} s</span>
          </div>
          <Slider min={0} max={maxFade} value={Math.min(clip.fadeOut, maxFade)} step={0.1} label="Fondu de sortie" onChange={(v) => patchSelected({ fadeOut: v }, 'gesture')} {...gestureHandlers} />
        </div>
      </div>
    </div>
  );
}

// ---------------- Framing ----------------

function FramingPanel() {
  const s = useSelectedClip();
  if (!s || s.selection.type !== 'video') return null;
  const clip = s.clip as VideoClip;
  const f = clip.framing;
  const setF = (patch: Partial<VideoClip['framing']>, mode: 'gesture' | 'commit') => patchSelected({ framing: { ...f, ...patch } }, mode);
  return (
    <div className="framing-panel">
      <Segmented
        value={f.mode}
        onChange={(mode) => setF({ mode, scale: 1, x: 0, y: 0 }, 'commit')}
        options={[
          { value: 'fill', label: 'Remplir', icon: <Maximize size={16} /> },
          { value: 'fit', label: 'Ajuster', icon: <Minimize size={16} /> },
        ]}
      />
      <div className="row-between">
        <span className="field-label">Zoom</span>
        <span className="field-value">{Math.round(f.scale * 100)} %</span>
      </div>
      <Slider min={0.5} max={4} value={f.scale} detents={[1]} label="Zoom" onChange={(v) => setF({ scale: Math.round(v * 100) / 100 }, 'gesture')} {...gestureHandlers} />
      <div className="button-row">
        <button className="btn-secondary" onClick={() => setF({ rotation: (f.rotation + 90) % 360 }, 'commit')}>
          <RotateCw size={16} /> Pivoter
        </button>
        <button className="btn-secondary" onClick={() => setF({ scale: 1, x: 0, y: 0, rotation: 0 }, 'commit')}>
          <Undo2 size={16} /> Réinitialiser
        </button>
      </div>
      <p className="hint">Astuce : dans l'aperçu, déplace l'image avec un doigt et zoome en pinçant.</p>
    </div>
  );
}

// ---------------- Format ----------------

function FormatPanel() {
  const project = useEditor((s) => s.project)!;
  return (
    <div className="format-panel">
      <div className="format-cards compact">
        {FORMAT_LIST.map((f) => (
          <button key={f.id} className={`format-card${project.format === f.id ? ' on' : ''}`} onClick={() => useEditor.getState().edit((p) => ({ ...p, format: f.id }))}>
            <span className={`format-shape ${f.vertical ? 'v' : 'h'}`}>{f.vertical ? <Smartphone size={22} /> : <MonitorPlay size={22} />}</span>
            <strong>{f.label}</strong>
            <span>{f.hint}</span>
            {project.format === f.id && <Check className="format-check" size={16} strokeWidth={3} />}
          </button>
        ))}
      </div>
      <p className="hint">Après un changement de format, ajuste le cadrage de chaque clip avec l'outil Cadrage.</p>
    </div>
  );
}

// ---------------- Text ----------------

const STYLES: { id: TextStyle; label: string }[] = [
  { id: 'plain', label: 'Simple' },
  { id: 'outline', label: 'Contour' },
  { id: 'background', label: 'Fond' },
  { id: 'shadow', label: 'Ombre' },
];

function stylePreview(style: TextStyle, colorId: string): React.CSSProperties {
  const c = colorHex(colorId);
  const k = contrastOn(c);
  if (style === 'background') return { background: c, color: k };
  if (style === 'outline') return { color: c, WebkitTextStroke: `1.5px ${k}`, paintOrder: 'stroke fill' } as React.CSSProperties;
  if (style === 'shadow') return { color: c, textShadow: '0 2px 6px rgba(0,0,0,0.8)' };
  return { color: c };
}

function TextPanel() {
  const s = useSelectedClip();
  const [tab, setTab] = useState<'font' | 'color' | 'style'>('font');
  const ta = useRef<HTMLTextAreaElement>(null);
  const clip = s?.selection.type === 'text' ? (s.clip as TextClip) : null;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (el.value === 'Ton texte') el.select();
    // Only when the panel opens for a clip.
  }, [clip?.id]);

  if (!clip) return null;
  const font = getFont(clip.font);
  return (
    <div className="text-panel">
      <div className="text-input-row">
        <textarea
          ref={ta}
          value={clip.text}
          rows={Math.min(3, clip.text.split('\n').length)}
          placeholder="Écris ton texte"
          onFocus={() => useEditor.getState().beginGesture()}
          onBlur={() => useEditor.getState().endGesture()}
          onChange={(e) => {
            const v = e.target.value;
            const ed = useEditor.getState();
            if (!ed.gestureBase) ed.beginGesture();
            ed.gesture((p) => updateTextClip(p, clip.id, { text: v }));
          }}
          style={{ fontFamily: `"${font.family}"`, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : 'normal' }}
          enterKeyHint="done"
        />
        <button
          className="btn-primary"
          onClick={() => {
            ta.current?.blur();
            useEditor.getState().setPanel(null);
          }}
        >
          OK
        </button>
      </div>
      <div className="tabs">
        <button className={tab === 'font' ? 'on' : ''} onClick={() => setTab('font')}>
          Police
        </button>
        <button className={tab === 'color' ? 'on' : ''} onClick={() => setTab('color')}>
          Couleur
        </button>
        <button className={tab === 'style' ? 'on' : ''} onClick={() => setTab('style')}>
          Style
        </button>
      </div>
      {tab === 'font' && (
        <div className="font-grid">
          {FONTS.map((f) => (
            <button key={f.id} className={`font-tile${clip.font === f.id ? ' on' : ''}`} onClick={() => patchSelected({ font: f.id }, 'commit')}>
              <span style={{ font: fontCss(f, 22 * f.scale) }}>Aa</span>
              <small>{f.label}</small>
            </button>
          ))}
        </div>
      )}
      {tab === 'color' && (
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c.id}
              className={`swatch${clip.color === c.id ? ' on' : ''}`}
              style={{ background: c.hex }}
              aria-label={c.label}
              onClick={() => patchSelected({ color: c.id }, 'commit')}
            >
              {clip.color === c.id && <Check size={18} strokeWidth={3} color={contrastOn(c.hex)} />}
            </button>
          ))}
        </div>
      )}
      {tab === 'style' && (
        <div className="style-tab">
          <div className="style-options">
            {STYLES.map((st) => (
              <button key={st.id} className={`style-tile${clip.style === st.id ? ' on' : ''}`} onClick={() => patchSelected({ style: st.id }, 'commit')}>
                <span className="style-sample" style={{ ...stylePreview(st.id, clip.color), font: fontCss(font, 18 * font.scale) }}>
                  Aa
                </span>
                <small>{st.label}</small>
              </button>
            ))}
          </div>
          <div className="style-row">
            <span className="field-label">Taille</span>
            <div className="grow">
              <Slider min={0.025} max={0.25} value={clip.size} label="Taille" onChange={(v) => patchSelected({ size: v }, 'gesture')} {...gestureHandlers} />
            </div>
            <div className="align-buttons">
              {(['left', 'center', 'right'] as TextAlign[]).map((a) => {
                const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
                return (
                  <button key={a} className={clip.align === a ? 'on' : ''} onClick={() => patchSelected({ align: a }, 'commit')} aria-label={`Aligner ${a}`}>
                    <Icon size={18} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Audio menu & music library ----------------

function AudioMenu() {
  return (
    <div className="audio-menu">
      <button className="big-choice" onClick={() => useEditor.getState().setPanel('music')}>
        <span className="choice-icon music">
          <Music size={22} />
        </span>
        <span>
          <strong>Musiques libres de droits</strong>
          <span>Gratuites et sans risque pour ses comptes</span>
        </span>
      </button>
      <button className="big-choice" onClick={() => pickFiles('audio', (f) => void importAudio(f))}>
        <span className="choice-icon import">
          <Upload size={22} />
        </span>
        <span>
          <strong>Importer un son</strong>
          <span>Voix off, musique… depuis Fichiers (MP3, M4A, WAV)</span>
        </span>
      </button>
      <p className="hint">Les sons tendance s'ajoutent directement dans TikTok ou Instagram, au moment de publier.</p>
    </div>
  );
}

let previewAudio: HTMLAudioElement | null = null;

function MusicPanel() {
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [mood, setMood] = useState<string>('Tout');
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}music/catalog.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { tracks: LibraryTrack[] }) => setTracks(d.tracks ?? []))
      .catch(() => {
        setFailed(true);
        setTracks([]);
      });
    return () => {
      previewAudio?.pause();
    };
  }, []);

  const toggle = (t: LibraryTrack) => {
    if (!previewAudio) {
      previewAudio = new Audio();
      previewAudio.preload = 'none';
    }
    const a = previewAudio;
    if (playing === t.id) {
      a.pause();
      setPlaying(null);
      return;
    }
    a.src = `${import.meta.env.BASE_URL}music/${t.file}`;
    a.onended = () => setPlaying(null);
    void a.play().then(
      () => setPlaying(t.id),
      () => setPlaying(null),
    );
  };

  if (tracks === null) {
    return (
      <div className="center-pad">
        <Spinner />
      </div>
    );
  }
  if (!tracks.length) {
    return (
      <div className="music-empty">
        <p>{failed ? 'La bibliothèque musicale n’est pas disponible pour le moment.' : 'La bibliothèque musicale arrive bientôt.'}</p>
        <p className="hint">En attendant, tu peux importer tes propres fichiers audio.</p>
        <button className="btn-secondary" onClick={() => pickFiles('audio', (f) => void importAudio(f))}>
          <Upload size={16} /> Importer un son
        </button>
      </div>
    );
  }
  const moods = ['Tout', ...Array.from(new Set(tracks.map((t) => t.mood)))];
  const list = mood === 'Tout' ? tracks : tracks.filter((t) => t.mood === mood);
  return (
    <div className="music-panel">
      <div className="chips scroll">
        {moods.map((m) => (
          <button key={m} className={`chip${m === mood ? ' on' : ''}`} onClick={() => setMood(m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="track-list">
        {list.map((t) => (
          <div key={t.id} className="track">
            <button className={`track-play${playing === t.id ? ' on' : ''}`} onClick={() => toggle(t)} aria-label={playing === t.id ? 'Pause' : 'Écouter'}>
              {playing === t.id ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="track-info">
              <strong>{t.title}</strong>
              <span>
                {t.mood} · {formatTime(t.duration)}
              </span>
            </div>
            <button
              className="track-add"
              onClick={() => {
                previewAudio?.pause();
                setPlaying(null);
                void addLibraryTrack(t);
              }}
            >
              <Plus size={18} /> Ajouter
            </button>
          </div>
        ))}
      </div>
      <p className="hint small">Musiques du domaine public (licence CC0) : utilisables gratuitement, même pour des vidéos monétisées.</p>
    </div>
  );
}

// ---------------- Host ----------------

const TITLES: Record<string, string> = {
  speed: 'Vitesse',
  volume: 'Volume',
  framing: 'Cadrage',
  text: 'Texte',
  format: 'Format',
  audio: 'Ajouter du son',
  music: 'Musiques',
};

export function PanelHost() {
  const panel = useEditor((s) => s.panel);
  if (!panel || panel === 'export') return null;
  const close = () => useEditor.getState().setPanel(null);
  const body =
    panel === 'speed' ? (
      <SpeedPanel />
    ) : panel === 'volume' ? (
      <VolumePanel />
    ) : panel === 'framing' ? (
      <FramingPanel />
    ) : panel === 'format' ? (
      <FormatPanel />
    ) : panel === 'text' ? (
      <TextPanel />
    ) : panel === 'audio' ? (
      <AudioMenu />
    ) : (
      <MusicPanel />
    );
  return (
    <PanelSheet title={TITLES[panel]} onClose={close} wide={panel === 'music' || panel === 'text'}>
      {body}
    </PanelSheet>
  );
}
