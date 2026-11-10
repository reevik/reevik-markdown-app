/**
 * Editor typography preference. Applied as CSS variables on the document root,
 * which the CodeMirror theme reads — so a change takes effect immediately, with
 * no editor remount and no loss of cursor position or undo history.
 */

export interface FontOption {
  id: string;
  label: string;
  stack: string;
  kind: "sans" | "serif" | "mono";
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "system",
    label: "System",
    kind: "sans",
    stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  },
  { id: "helvetica", label: "Helvetica Neue", kind: "sans", stack: '"Helvetica Neue", Helvetica, sans-serif' },
  { id: "newyork", label: "New York", kind: "serif", stack: '"New York", ui-serif, Georgia, serif' },
  { id: "georgia", label: "Georgia", kind: "serif", stack: 'Georgia, "Times New Roman", serif' },
  { id: "iowan", label: "Iowan Old Style", kind: "serif", stack: '"Iowan Old Style", Palatino, serif' },
  { id: "sfmono", label: "SF Mono", kind: "mono", stack: '"SF Mono", ui-monospace, Menlo, monospace' },
  { id: "menlo", label: "Menlo", kind: "mono", stack: 'Menlo, ui-monospace, monospace' },
];

export const DEFAULT_FONT = "system";
export const DEFAULT_SIZE = 15;
export const MIN_SIZE = 11;
export const MAX_SIZE = 26;

const FAMILY_KEY = "editor.fontFamily";
const SIZE_KEY = "editor.fontSize";

export function stackFor(id: string): string {
  return (FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0]).stack;
}

export function loadEditorFont(): { family: string; size: number } {
  const family = localStorage.getItem(FAMILY_KEY) ?? DEFAULT_FONT;
  const raw = Number(localStorage.getItem(SIZE_KEY));
  const size = Number.isFinite(raw) && raw >= MIN_SIZE && raw <= MAX_SIZE ? raw : DEFAULT_SIZE;
  return { family: FONT_OPTIONS.some((f) => f.id === family) ? family : DEFAULT_FONT, size };
}

export function saveEditorFont(family: string, size: number): void {
  localStorage.setItem(FAMILY_KEY, family);
  localStorage.setItem(SIZE_KEY, String(size));
}

export function applyEditorFont(family: string, size: number): void {
  const root = document.documentElement;
  root.style.setProperty("--editor-font-family", stackFor(family));
  root.style.setProperty("--editor-font-size", `${size}px`);
}

// --- AI panels -----------------------------------------------------------------
//
// The panels (Editorial, Analyze, References) have their own font and size.
// Their text sizes are spread across many small labels, so rather than one
// base font-size the panel content is scaled as a whole — text, spacing and
// icons together, like zoom — which keeps its proportions at any size.

/** The size the panels were designed at; the scale is relative to it. */
export const PANEL_BASE_SIZE = 12;
export const PANEL_MIN_SIZE = 11;
export const PANEL_MAX_SIZE = 17;

const PANEL_FAMILY_KEY = "panel.fontFamily";
const PANEL_SIZE_KEY = "panel.fontSize";

export function loadPanelFont(): { family: string; size: number } {
  const family = localStorage.getItem(PANEL_FAMILY_KEY) ?? DEFAULT_FONT;
  const raw = Number(localStorage.getItem(PANEL_SIZE_KEY));
  const size = Number.isFinite(raw) && raw >= PANEL_MIN_SIZE && raw <= PANEL_MAX_SIZE ? raw : PANEL_BASE_SIZE;
  return { family: FONT_OPTIONS.some((f) => f.id === family) ? family : DEFAULT_FONT, size };
}

export function savePanelFont(family: string, size: number): void {
  localStorage.setItem(PANEL_FAMILY_KEY, family);
  localStorage.setItem(PANEL_SIZE_KEY, String(size));
}

export function applyPanelFont(family: string, size: number): void {
  const root = document.documentElement;
  root.style.setProperty("--panel-font-family", stackFor(family));
  root.style.setProperty("--panel-zoom", String(size / PANEL_BASE_SIZE));
}
