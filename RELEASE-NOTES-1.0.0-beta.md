# Reevik 1.0.0.beta

A glossy Markdown editor for macOS with Obsidian-style vaults and a built-in Claude
writing agent. First public beta.

**Download:** `Reevik_1.0.0_aarch64.dmg` (Apple Silicon)

---

## Vaults & files

- **Obsidian-style vaults** — a vault is just a folder of `.md` files on disk. No
  database, no lock-in; your notes stay plain Markdown you can edit anywhere.
- **Vault launcher** on startup: open any folder as a vault, create a new one, or
  pick from your recent vaults. Switch any time with `⌘⇧O`.
- **File tree** with live filtering, A–Z / Z–A sorting, and expand/collapse all.
- **Drag & drop** notes and folders to reorganise — drop onto a folder to nest, or
  onto empty space to move to the vault root. Open tabs follow the move.
- Create, rename and delete notes and folders inline.

## Editor

- **Live Preview** in the spirit of Obsidian and Typora: Markdown renders as you
  write, and the raw syntax reveals itself only on the line you're editing.
- **Source mode** (`⌘/`) when you want to see the raw Markdown.
- **Tabs** for multiple open notes, each with its own buffer, so unsaved edits
  survive tab switches.
- **Autosave** to disk, debounced per note.
- **Status bar** showing file type, size, last-edited time and save state.
- **Typography settings** — choose the editor font (System, Helvetica Neue, New
  York, Georgia, Iowan Old Style, SF Mono, Menlo) and size; applies instantly.

## Rich content

- **Charts** — embed [Vega-Lite](https://vega.github.io/vega-lite/) specs in a
  ` ```vega-lite ` block and get a live chart, with drag-to-resize and left/centre/right
  alignment.
- **Diagrams** — [Mermaid](https://mermaid.js.org) blocks, including UML class,
  sequence, state and ER diagrams. Same resize and alignment controls.
- **Math** — LaTeX via KaTeX, inline (`$…$`) and display (`$$…$$`).
- **Images** — drag & drop or paste straight into a note; resize and align them.
  Files are copied into the vault and linked relatively.
- **Code blocks** with syntax highlighting, plus tables, task lists, quotes and
  dividers.
- **YAML frontmatter** collapses into a tidy *Document Metadata* pill instead of
  cluttering the top of the note.

## Insert toolbar

- A floating toolbar with 16 insert actions — headings, emphasis, links, lists,
  checklists, quotes, code blocks, tables, dividers, images, charts, diagrams and math.
- **Drag it anywhere** in the window; its position is remembered.
- Toggle with `⌘⌥3` or View ▸ Toolbar.

## Command palette

- `⌘K` (or `⌘⇧P`) opens a searchable palette of every action in the app, with
  fuzzy matching and the keyboard shortcut shown alongside each entry.

## AI writing agent

Powered by Claude, through either the local **`claude` CLI** (no API key needed) or
your own **Anthropic API key**, stored in the macOS Keychain.

- **Editorial review** — runs automatically when you open a note. Gives a
  **quality score** (stars, percentage, and per-dimension ratings for clarity,
  structure, grammar and tone), a one-line assessment, and a list of concrete edits.
- **Click-to-apply suggestions** — every suggestion is a self-contained
  original → replacement edit you can accept individually. The agent proposes
  *local* changes only; it never rewrites your document wholesale.
- **Rephrase selection** (`⌘⇧R`) — Google-Docs-style collaboration, marking where
  you are and where the agent is working.
- **Find references** (`⌘⇧F`) — genuinely searches the web for papers,
  documentation and articles on your note's topic, then lists them with a summary
  and why each is relevant. Open in your browser, or insert as a Markdown citation
  (individually or as a whole `## References` section).
- **Streaming results** — the score, summary and suggestions appear progressively
  as they're generated rather than after a long silence, with a live elapsed timer.
  Reference search shows each query as it runs.
- **Model selection** in Settings: Opus 4.8, Sonnet 5, Haiku 4.5, or your backend's
  default. Haiku is noticeably quicker for reviews.

## Export

- **Export as PDF** (`⌘P`) via the native macOS print panel. Charts, diagrams, math
  and images are all pre-rendered into the output, with proper page breaks and
  A4 margins — the printed document is a clean article, not a screenshot of the editor.

## Look & feel

- Translucent, vibrant macOS window with an overlay title bar.
- Three panes — file tree, editor, AI agent — each resizable and collapsible, with
  your layout remembered between launches.
- Native menu bar with full keyboard shortcuts throughout.

## Keyboard shortcuts

| | |
|---|---|
| `⌘N` / `⌘⇧N` | New note / new folder |
| `⌘W` / `⌘⇧W` | Close tab / close window |
| `⌘P` | Export as PDF |
| `⌘K` / `⌘⇧P` | Command palette |
| `⌘/` | Toggle Markdown source |
| `⌘⌥1` `⌘⌥2` `⌘⌥3` | Toggle sidebar / AI panel / toolbar |
| `⌘⇧A` | Editorial review |
| `⌘⇧F` | Find references |
| `⌘⇧R` | Rephrase selection |
| `⌘⇧O` | Open vault |
| `⌘,` | Settings |
| `⌘B` `⌘I` `⌘E` `⌘⇧K` | Bold / italic / inline code / link |
| `⌘⇧X` `⌘⇧C` `⌘⇧L` `⌘⇧T` | Strikethrough / code block / list / checklist |

---

## Known limitations

- **Apple Silicon only.** This build is `aarch64`; Intel Macs are not supported yet.
- **Not notarised.** The app is ad-hoc signed, so macOS will warn on first launch.
  Right-click → Open, or run
  `xattr -dr com.apple.quarantine /Applications/Reevik.app`.
- **AI features need a backend** — either the `claude` CLI on your `PATH` or an
  Anthropic API key added in Settings. Without one, the editor works fully; only
  the agent panel is inactive.
- **Find references needs internet access**, and takes 20–60 seconds since it runs
  several real web searches.
- **Streaming applies to the CLI backend**; the API-key path returns its result in
  one go.
- Quality scores are a language model's judgement, not a measurement — expect them
  to vary a little between runs on the same text.
