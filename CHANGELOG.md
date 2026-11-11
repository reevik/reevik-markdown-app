# Changelog

All notable changes to Reevik are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-11-11

The first stable release: everything from the 1.x betas, no longer marked beta.

### Changed

- **Reevik is out of beta.** About shows `1.7.0`, and this release is GitHub's
  latest rather than a pre-release.

### Fixed

- About and the `.dmg` name show the release's real version again — the 1.5.0 and
  1.6.0 betas reported themselves as 1.4.0.

## [1.6.0.beta] — 2026-11-11

### Added

- **Hidden notes** — hide a note for privacy from its row (the crossed-out eye) or
  for a whole selection. Hidden notes leave the tree, label counts, `[[`
  suggestions and Content Index lists, and Clean Up and Reorganize never send them
  to the AI. The eye button in the sidebar toolbar shows them, faded, until it's
  switched off again; every launch starts with them hidden. Stored in the vault's
  `.reevik/hidden.json`, so they stay hidden on every Mac. This is hiding, not
  protection: the files themselves are untouched.

### Changed

- The README now outlines Reevik's distinctive features only.

### Known issues

- This build reports itself as **1.4.0** in About and in its `.dmg` name. Fixed in
  1.7.0.

## [1.5.0.beta] — 2026-11-11

### Added

- **Links open on click** — web links in your browser, notes in Reevik (at the
  heading for `#section` links), other files revealed in Finder. In Live Preview a
  click on a shown link opens it; `⌘`-click always does.
- **`[[Wikilinks]]`**, as Obsidian writes them: `[[Note]]` finds a note by name
  anywhere in the vault, `[[Folder/Note]]` by path; `#Heading` and `|alias` work.
  A link to a note that doesn't exist is drawn faded.
- **Link autocompletion** — type `[[` for notes (inserting the shortest name that's
  unique, so links survive moves) or `](` for relative paths.
- **Reorganize** keeps `[[Folder/Note]]` links working when it moves notes.

### Changed

- Several selected notes draw as a single block, like a Finder selection.
- A bare `[text]` is shown as plain text rather than as a link that goes nowhere.

### Known issues

- This build reports itself as **1.4.0** in About and in its `.dmg` name. Fixed in
  1.7.0.

## [1.4.0.beta] — 2026-11-10

### Added

- **Clean up the vault** — the broom button (or **Vault ▸ Clean Up Vault…**)
  rates every note for completeness in the background and marks the ones that
  look safe to delete. **Show them** narrows the tree to just those. It asks
  before sending anything, flags empty notes without asking the AI at all, and
  on later runs only rates notes that changed.
- **Reorganize the vault** — the grid button (or **Vault ▸ Reorganize
  Vault…**) proposes a folder for every note and shows the structure before and
  after; untick any note to keep it where it is. Approved moves keep every
  image and note link working, folders left empty are removed, and **Undo**
  puts everything back.
- **Labels** — coloured labels on notes, stored as the note's frontmatter
  `tags:` so they travel with it and show up in Obsidian too. Assign them from a
  note's tag button, by right-clicking it, or with **File ▸ Labels…**; filter
  the tree with the label chips under the search box.
- **Select several notes** — shift-click for a range, `⌘`-click to add or
  remove one. Label them together, drag them onto a folder, or delete them.
- **Restore diacritics** (`⌘⇧D`) — puts the accents back into text typed
  without them, in any language. It only ever adds accents: a result that
  changes anything else is not applied.
- **Translate** (`⌘⇧T`) — translates the selection into a language picked from a
  list, with your recent choices first. Markdown, code, URLs and names are kept.
- **Fonts for the AI panels** — Settings ▸ Fonts now sets the font and size of
  the Editorial, Analyze and References panels as well as the editor's.
- A short explanation of what **Analyze** and **References** do, above their
  buttons.

### Changed

- **Settings is a tabbed window** — Fonts and AI — on a solid background.
- The checklist shortcut moved from `⌘⇧T` to `⌘⇧U`, as `⌘⇧T` is now Translate.

### Fixed

- Shift-clicking in the file tree selected the file names as text.
- **Rephrase failed silently** — with a logged-out Claude CLI it did nothing and
  showed nothing. Failures now appear as a short message at the selection, and
  spaces around the selection are kept.

## [1.3.0.beta] — 2026-11-10

### Changed

- **Analyze no longer runs on its own.** Opening a note used to start a review
  after a short pause; it now runs only when you press `⌘⇧A`, pick **Analyze
  document** in the palette, or click **Analyze document** in the panel.

### Fixed

- Opening notes in an iCloud vault could freeze the whole window for seconds.
  macOS keeps rarely used iCloud files in the cloud, and reading one waits for
  the download; the read ran on the main thread, so the app stopped responding
  until it finished. Vault file access now happens in the background, and a
  note that takes a moment to open shows a spinner, both in its tab and in the
  editor.
- An Analyze run abandoned by switching notes no longer shows its results in
  the next note's panel.

## [1.2.0.beta] — 2026-11-10

### Added

- **About page** — **Reevik ▸ About Reevik** now opens an in-app page with the
  version, a link to the Apache License 2.0, and **Open-source libraries used in
  the editor**. That opens a scrollable window listing all 526 npm packages and
  Rust crates bundled in Reevik; select one to read its licence text or open its
  source, or filter by name or licence.

### Changed

- **Reevik is licensed under the Apache License 2.0**, now stated in a
  `LICENSE` file, a `NOTICE`, and the app's own metadata, not only the README.
- The list of open-source licences is regenerated with every build, so each
  release lists exactly the libraries it ships.

## [1.1.0.beta] — 2026-11-09

### Added

- **Editorial chat** — a new tab in the AI panel (`⌘⇧E`) for talking the note
  through with the agent: ask for a tighter opening, a counter-argument, a
  summary. Replies stream in and render as Markdown, and can be copied or
  inserted at the cursor. The conversation is kept per vault, survives
  restarts, and is only wiped by **Clear**. The open note travels with every
  message, so the agent always answers against its current text.
- **The agent edits the note directly** — ask it to add, change or remove
  something and it makes the change itself. All of a reply's edits apply as one
  step, saved like typing and undone with a single `⌘Z`. A line under the reply
  says what was applied; an edit whose target text has since changed is
  reported rather than guessed at.
- **GitHub Copilot as a second AI provider** — choose **Claude** or **GitHub
  Copilot** in Settings. Copilot runs through the `copilot` CLI on your
  Copilot plan, and each provider keeps its own model choice. Reference search
  stays with Claude, since it needs live web search to cite real sources.
- **Login detection** — if the Claude CLI isn't logged in, the AI panel and
  Settings say so up front and show the command to fix it
  (`claude auth login`), instead of failing silently.

### Changed

- The automatic review is now the **Analyze** tab (`⌘⇧A`), alongside
  **Editorial** and **References** (`⌘⇧F`).
- Reference summaries and the Analyze verdict render inline Markdown.
- The model picker offers **Opus 5.5**, **Sonnet 5.5** and **Haiku 5.5**. With
  an API key and no model chosen, Reevik now uses Opus 5.5, replacing the
  deprecated Sonnet 4.5.
- **New app icon**: the owl, in the Dock, on the opening screen and in About.

### Fixed

- AI errors appeared as an **empty red box**; they now show what went wrong.
- With a logged-out Claude CLI, **Rephrase could paste the CLI's
  "Failed to authenticate" message into the note** as if it were the
  rephrased text. It is now treated as an error.
- In segmented controls (the AI tabs, the Settings provider switch), the
  selected tab overflowed the corners of its track.
- The version shown in About and in the `.dmg` name matches the release again
  (1.0.2 reported itself as 1.0.1).

## [1.0.2] — 2026-09-05

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
- The insert toolbar has a **Content index** button.

### Changed

- **The file tree remembers which folders you collapsed**, per vault, and
  restores them on launch instead of expanding everything. A renamed or moved
  folder keeps its state.
- A new flat app icon.
- Releases are built by GitHub Actions as a **universal `.dmg`** that runs on
  both Intel and Apple Silicon Macs.

### Known issues

- This build reports itself as **1.0.1** in About and in its `.dmg` name: the
  version wasn't bumped before release. Fixed in 1.1.0.beta.

## [1.0.1.beta] — 2026-08-14

### Added

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
