/**
 * Links between notes: what `[[Note]]` and `[text](path.md)` point at, and
 * what to insert when completing one.
 *
 * Wikilinks follow Obsidian: `[[Name]]` finds a note by name anywhere in the
 * vault (preferring one beside the current note), `[[Folder/Name]]` by its
 * path from the vault root, `#Heading` and `|alias` may follow. Markdown links
 * are relative to the note they're in. Completion inserts the shortest name
 * that's unique, as Obsidian does, so links survive notes being moved.
 */

// --- The vault's notes, kept current by the sidebar ---------------------------

let index: { root: string; notes: string[] } = { root: "", notes: [] };

export function setVaultIndex(root: string, notes: string[]) {
  index = { root, notes };
}

export function vaultIndex() {
  return index;
}

// --- Paths --------------------------------------------------------------------

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

const stripExt = (p: string) => p.replace(/\.(md|markdown)$/i, "");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** `to` relative to the folder `fromDir`, with `/` separators. */
export function relative(fromDir: string, to: string): string {
  const a = normalize(fromDir).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

// --- Resolution ---------------------------------------------------------------

export type LinkTarget =
  | { kind: "web"; url: string }
  | { kind: "note"; path: string; heading: string | null }
  | { kind: "file"; path: string }
  | { kind: "missing"; label: string };

/** `Note#Heading|Alias` → its parts. */
export function parseWiki(inner: string): { target: string; heading: string | null; alias: string | null } {
  const bar = inner.indexOf("|");
  const alias = bar === -1 ? null : inner.slice(bar + 1).trim() || null;
  const ref = bar === -1 ? inner : inner.slice(0, bar);
  const hash = ref.indexOf("#");
  return {
    target: (hash === -1 ? ref : ref.slice(0, hash)).trim(),
    heading: hash === -1 ? null : ref.slice(hash + 1).trim() || null,
    alias,
  };
}

export function resolveWiki(inner: string, fromNote: string, root: string, notes: string[]): LinkTarget {
  const { target, heading } = parseWiki(inner);
  if (!target) return { kind: "note", path: fromNote, heading };
  const want = stripExt(target).toLowerCase();

  if (want.includes("/")) {
    // From the vault root first, as Obsidian writes them; then from this note.
    for (const base of [root, dirname(fromNote)]) {
      const full = stripExt(normalize(`${base}/${target}`)).toLowerCase();
      const hit = notes.find((n) => stripExt(n).toLowerCase() === full);
      if (hit) return { kind: "note", path: hit, heading };
    }
    return { kind: "missing", label: target };
  }

  const named = notes.filter((n) => stripExt(basename(n)).toLowerCase() === want);
  if (named.length === 0) return { kind: "missing", label: target };
  const here = named.find((n) => dirname(n) === dirname(fromNote));
  const best = here ?? [...named].sort((x, y) => x.length - y.length)[0];
  return { kind: "note", path: best, heading };
}

export function resolveHref(href: string, fromNote: string, root: string, notes: string[]): LinkTarget {
  const raw = href.trim().replace(/^<|>$/g, "");
  if (/^(https?:|mailto:)/i.test(raw)) return { kind: "web", url: raw };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: "missing", label: raw }; // other schemes: not ours to open
  const hash = raw.indexOf("#");
  const pathPart = hash === -1 ? raw : raw.slice(0, hash);
  const heading = hash === -1 ? null : decode(raw.slice(hash + 1)) || null;
  if (!pathPart) return { kind: "note", path: fromNote, heading };

  const decoded = decode(pathPart);
  const full = normalize(decoded.startsWith("/") ? `${root}${decoded}` : `${dirname(fromNote)}/${decoded}`);
  const exact = notes.find((n) => n === full);
  if (exact) return { kind: "note", path: exact, heading };
  // `[x](Projects/Hue)` without the extension, as Obsidian also writes them.
  if (!/\.[a-z0-9]+$/i.test(full)) {
    const withExt = notes.find((n) => stripExt(n) === full);
    if (withExt) return { kind: "note", path: withExt, heading };
  }
  if (/\.(md|markdown)$/i.test(full) || !/\.[a-z0-9]+$/i.test(full)) return { kind: "missing", label: decoded };
  return { kind: "file", path: full };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// --- Completion ---------------------------------------------------------------

/** The name `[[…]]` should use: just the note's name when no other note in
 *  the vault shares it, otherwise its path from the vault root. */
export function wikiName(path: string, root: string, notes: string[]): string {
  const name = stripExt(basename(path));
  const clash = notes.filter((n) => stripExt(basename(n)).toLowerCase() === name.toLowerCase()).length > 1;
  return clash ? stripExt(relative(root, path)) : name;
}

/** A Markdown link target from one note to another, safe inside `(…)`. */
export function markdownHref(fromNote: string, to: string): string {
  return relative(dirname(fromNote), to).replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}
