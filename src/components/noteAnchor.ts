/**
 * Opening a note at a heading, from anywhere — a Content Index entry, a link
 * clicked in a note. The note may not be open yet (the read is async and the
 * editor remounts per note), so the heading is parked here and claimed by
 * whichever editor mounts for that path.
 */
import { EditorView } from "@codemirror/view";

let pendingAnchor: { path: string; anchor: string } | null = null;

/** Open `path` (App owns the tabs and listens), landing on `anchor` if given. */
export function openNoteAt(path: string, anchor: string | null) {
  pendingAnchor = anchor ? { path, anchor } : null;
  window.dispatchEvent(new CustomEvent("reevik:open-note", { detail: path }));
}

/** The heading parked for `notePath`, taken so it's only used once. */
export function claimPendingAnchor(notePath: string): string | null {
  if (pendingAnchor?.path !== notePath) return null;
  const { anchor } = pendingAnchor;
  pendingAnchor = null;
  return anchor;
}

/** Put the cursor on the heading `anchor` names, and scroll it into view. */
export function scrollToAnchor(view: EditorView, anchor: string) {
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.text);
    if (!heading) continue;
    if (slugify(heading[2].trim().replace(/#+$/, "").trim()) !== anchor) continue;
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }),
    });
    return;
  }
}

/** Mirrors the slug the Rust side builds, so anchors match on both ends. */
export function slugify(title: string): string {
  let out = "";
  for (const ch of title) {
    if (/[\p{L}\p{N}_]/u.test(ch)) out += ch.toLowerCase();
    else if ((ch === " " || ch === "-") && out !== "" && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "");
}
