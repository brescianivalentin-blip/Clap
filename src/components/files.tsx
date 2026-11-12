import { useRef } from 'react';

type Kind = 'visual' | 'audio';
type Handler = (files: File[]) => void;

const inputs: Partial<Record<Kind, HTMLInputElement>> = {};
const handlers: Partial<Record<Kind, Handler>> = {};

/**
 * Opens the iPad file picker (Photos, Fichiers…). Must be called directly from a tap handler.
 * The inputs live at the app root so that a picker opened from the home screen keeps working
 * after we switch to the editor.
 */
export function pickFiles(kind: Kind, onFiles: Handler) {
  const el = inputs[kind];
  if (!el) return;
  handlers[kind] = onFiles;
  el.value = '';
  el.click();
}

export function FilePickers() {
  const visual = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLInputElement>(null);
  const bind = (kind: Kind) => (el: HTMLInputElement | null) => {
    if (el) inputs[kind] = el;
  };
  const onChange = (kind: Kind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const h = handlers[kind];
    handlers[kind] = undefined;
    if (files.length && h) h(files);
  };
  return (
    <div className="file-pickers" aria-hidden>
      <input
        ref={(el) => {
          (visual as React.MutableRefObject<HTMLInputElement | null>).current = el;
          bind('visual')(el);
        }}
        type="file"
        accept="video/*,image/*"
        multiple
        onChange={onChange('visual')}
        tabIndex={-1}
      />
      <input
        ref={(el) => {
          (audio as React.MutableRefObject<HTMLInputElement | null>).current = el;
          bind('audio')(el);
        }}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.aac,.caf,.aif,.aiff,.flac,.ogg"
        multiple
        onChange={onChange('audio')}
        tabIndex={-1}
      />
    </div>
  );
}
