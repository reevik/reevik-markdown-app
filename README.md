<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Reevik icon">
</p>

<h1 align="center">Reevik</h1>

<p align="center">
  A glossy Markdown editor for macOS — Obsidian-style vaults, live preview,<br>
  embedded charts and diagrams, and a built-in Claude writing agent.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0.beta-6d5ff2" alt="version">
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-111" alt="platform">
  <img src="https://img.shields.io/badge/licence-Apache%202.0-1baf7a" alt="licence">
</p>

---

## Features

### Vaults & files

- **Obsidian-style vaults** — a vault is just a folder of `.md` files on disk. No
  database, no lock-in; your notes stay plain Markdown you can edit anywhere.
- **Vault launcher** on startup: open any folder as a vault, create a new one, or
  pick from your recent vaults.
- **File tree** with live filtering, sorting and expand/collapse all.
- **Drag & drop** notes and folders to reorganise — open tabs follow the move.
- Create, rename and delete notes and folders inline.

### Editor

- **Live Preview** — Markdown renders as you write, and the raw syntax reveals
  itself only on the line you're editing. A source mode (`⌘/`) is a keystroke away.
- **Tabs** for multiple open notes, each with its own buffer, so unsaved edits
  survive tab switches.
- **Autosave** to disk, debounced per note.
- **Status bar** with file type, size, last-edited time and save state.
- **Typography settings** — pick the editor font and size; applies instantly.

### Rich content

- **Charts** — [Vega-Lite](https://vega.github.io/vega-lite/) specs in a
  ` ```vega-lite ` block become live charts, with drag-to-resize and alignment.
- **Diagrams** — [Mermaid](https://mermaid.js.org) blocks, including UML class,
  sequence, state and ER diagrams.
- **Math** — LaTeX via KaTeX, inline (`$…$`) and display (`$$…$$`).
- **Images** — drag, drop or paste straight into a note; resize and align them.
- **Code blocks** with syntax highlighting, plus tables, task lists and quotes.
- **YAML frontmatter** collapses into a tidy *Document Metadata* pill.

### AI writing agent

Powered by Claude, through either the local **`claude` CLI** (no API key needed) or
your own **Anthropic API key**, stored in the macOS Keychain.

- **Editorial review** runs automatically when you open a note: a **quality score**
  (stars, percentage and per-dimension ratings for clarity, structure, grammar and
  tone), a one-line assessment, and a list of concrete edits.
- **Click-to-apply suggestions** — each is a self-contained original → replacement
  edit you accept individually. The agent proposes *local* changes only; it never
  rewrites your document wholesale.
- **Rephrase selection** (`⌘⇧R`) with Google-Docs-style collaboration markers.
- **Find references** (`⌘⇧F`) genuinely searches the web for papers, documentation
  and articles on your topic, then lists them with a summary and why each is
  relevant — open in your browser, or insert as Markdown citations.
- **Streaming results** appear progressively with a live elapsed timer, rather than
  after a long silence.
- **Model selection** — Opus 4.8, Sonnet 5, Haiku 4.5, or your backend's default.

### Writing tools

- **Command palette** (`⌘K`) — fuzzy search across every action, with shortcuts shown.
- **Floating insert toolbar** with 16 insert actions; drag it anywhere and it stays put.
- **Export as PDF** (`⌘P`) — charts, diagrams, math and images are pre-rendered into
  a clean printed article with proper page breaks.
- Three resizable, collapsible panes; your layout is remembered between launches.

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

## Getting started

Download `Reevik_1.0.0_aarch64.dmg` from the releases page and drag Reevik to your
Applications folder.

The build is ad-hoc signed rather than notarised, so macOS warns on first launch —
right-click → **Open**, or:

```sh
xattr -dr com.apple.quarantine /Applications/Reevik.app
```

### Building from source

Requires [Rust](https://rustup.rs) and [Node.js](https://nodejs.org).

```sh
npm install
npm run tauri dev     # run in development
npm run tauri build   # produce a .app and .dmg
```

## Built with

[Tauri 2](https://tauri.app) · [React 19](https://react.dev) ·
[TypeScript](https://www.typescriptlang.org) · [Vite](https://vite.dev) ·
[Tailwind CSS](https://tailwindcss.com) · [CodeMirror 6](https://codemirror.net) ·
[Vega-Lite](https://vega.github.io/vega-lite/) · [Mermaid](https://mermaid.js.org) ·
[KaTeX](https://katex.org)

## Licence

Licensed under the Apache License, Version 2.0.

You may obtain a copy of the licence at
<http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed
under the Licence is distributed on an **"AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND**, either express or implied. See the Licence for the
specific language governing permissions and limitations under it.

© 2026 Erhan Bağdemir
