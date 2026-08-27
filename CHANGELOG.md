# Changelog

All notable changes to Reevik are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1.beta] — unreleased

### Added

- **Content Index** — a ` ```content-index ` block renders an ordinary bulleted
  list of every note in the current folder and below it, linked and ready to
  click. The block stores nothing: the list is read from the vault on
  every draw and refreshes whenever the hierarchy changes (new note, rename,
  move, delete, or an edit made outside the app), so it can't drift out of date.
  Entries are titled from each note's frontmatter `title:`, falling back to the
  file name. Fence tokens configure it: a bare number caps the folder depth
  (` ```content-index|2 `), and `include-headers=N` pulls each note's own
  headings in down to that `#` level, indented by their level and linking
  straight to that heading. Clicking the
  block shows the Markdown the list stands for (`- [Title](path.md)`) instead of
  the directive; both that view and the block itself are read-only, and a block
  can only be removed whole. Its settings are changed from a hover bar on the
  block rather than by typing — the one edit it accepts. It prints with the note
  as a plain outline.

- **Import files into a vault** — a toolbar button (`⌘⇧I`) copies existing files
  from anywhere on disk into the current vault. Clashing names gain a ` 2`, ` 3`
  suffix rather than overwriting, and plain-text imports are renamed to `.md` so
  they appear in the tree.
- **Tables render in Live Preview** — GFM pipe tables display as real tables,
  honouring per-column alignment, with inline Markdown inside cells rendered
  rather than shown as raw syntax.
- **Horizontal rules render in Live Preview**, without disturbing the `---`
  fences of YAML frontmatter.
- **Inline HTML blocks render in Live Preview**, sanitised, with vault-relative
  `<img>` sources loaded through the same cache as Markdown images.
- **Tab context menu** — right-click a tab for **Close**, **Close Others** and
  **Close All**. Unsaved buffers are flushed before closing, so no edits are lost.

### Fixed

- **Tab bar overflow** — with enough tabs open to fill the bar, the scrollbar
  track made the tab strip taller than its row, pushing the mode toggle and panel
  buttons out of the bar. The strip is now pinned to one tab's height and scrolls
  without a scrollbar; the active tab is scrolled into view when it changes.
- **Right-clicking a tab no longer selects the filename text.**
- List bullets and numbers are tinted on their own, instead of the accent colour
  bleeding across the whole list item's text.

### Changed

- Version reported by the app is now `1.0.1.beta` (About Reevik).

## [1.0.0.beta] — 2026-07-19

First public beta: Obsidian-style vaults, Live Preview, charts, diagrams, math,
PDF export and the Claude writing agent.

See [RELEASE-NOTES-1.0.0-beta.md](RELEASE-NOTES-1.0.0-beta.md) for the full
feature list, known limitations and keyboard shortcuts.
