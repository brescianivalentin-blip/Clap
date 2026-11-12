import '@fontsource/tiktok-sans/latin-700.css';
import '@fontsource/montserrat/latin-800.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/playfair-display/latin-700-italic.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/fredoka/latin-600.css';
import '@fontsource/special-elite/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/righteous/latin-400.css';

export interface FontDef {
  id: string;
  label: string;
  family: string;
  weight: number;
  italic?: boolean;
  /** Optical adjustment so all fonts look about the same size. */
  scale: number;
}

export const FONTS: FontDef[] = [
  { id: 'classique', label: 'Classique', family: 'TikTok Sans', weight: 700, scale: 1 },
  { id: 'moderne', label: 'Moderne', family: 'Montserrat', weight: 800, scale: 0.92 },
  { id: 'impact', label: 'Impact', family: 'Anton', weight: 400, scale: 1.08 },
  { id: 'elegant', label: 'Élégant', family: 'Playfair Display', weight: 700, italic: true, scale: 1 },
  { id: 'manuscrit', label: 'Manuscrit', family: 'Caveat', weight: 700, scale: 1.3 },
  { id: 'retro', label: 'Rétro', family: 'Pacifico', weight: 400, scale: 0.92 },
  { id: 'arrondi', label: 'Arrondi', family: 'Fredoka', weight: 600, scale: 1.04 },
  { id: 'machine', label: 'Machine', family: 'Special Elite', weight: 400, scale: 1 },
  { id: 'marqueur', label: 'Marqueur', family: 'Permanent Marker', weight: 400, scale: 0.98 },
  { id: 'futur', label: 'Futuriste', family: 'Righteous', weight: 400, scale: 1 },
];

const byId = new Map(FONTS.map((f) => [f.id, f]));

export function getFont(id: string): FontDef {
  return byId.get(id) ?? FONTS[0];
}

export function fontCss(f: FontDef, px: number): string {
  return `${f.italic ? 'italic ' : ''}${f.weight} ${px}px "${f.family}"`;
}

let loaded: Promise<void> | null = null;

/** Canvas text only renders with a font once it has been loaded. */
export function ensureFonts(): Promise<void> {
  if (!loaded) {
    loaded = Promise.all(FONTS.map((f) => document.fonts.load(fontCss(f, 48), 'AaÉéçà').catch(() => [])))
      .then(() => undefined);
  }
  return loaded;
}

export interface ColorDef {
  id: string;
  label: string;
  hex: string;
}

export const COLORS: ColorDef[] = [
  { id: 'white', label: 'Blanc', hex: '#FFFFFF' },
  { id: 'black', label: 'Noir', hex: '#111114' },
  { id: 'red', label: 'Rouge', hex: '#FF3B30' },
  { id: 'pink', label: 'Rose', hex: '#FF5FA8' },
  { id: 'purple', label: 'Violet', hex: '#A259FF' },
  { id: 'blue', label: 'Bleu', hex: '#2F7BFF' },
  { id: 'green', label: 'Vert', hex: '#2BD467' },
  { id: 'yellow', label: 'Jaune', hex: '#FFD60A' },
];

const colorById = new Map(COLORS.map((c) => [c.id, c]));

export function colorHex(id: string): string {
  return colorById.get(id)?.hex ?? '#FFFFFF';
}

/** Black or white, whichever reads best on top of `hex`. */
export function contrastOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? '#111114' : '#FFFFFF';
}
