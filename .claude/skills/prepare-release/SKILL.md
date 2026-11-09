---
name: prepare-release
description: Cut a new Reevik release — ask for the version number, bump it everywhere (manifests, lockfiles, README badge, the About panel), write the changelog entry, and build the signed .dmg. Use this whenever the user talks about releasing, shipping, cutting a version, bumping the version, "prepare a release", "make a new build", "ship 1.0.2", or asks for a .dmg — even if they only mention one part of it, since the parts are easy to leave half-done.
---

# Prepare a release

This repo is a Tauri 2 + React app (product name **Reevik**, crate
`markdown-editor`). A release means: one version number, agreed with the user,
appearing consistently in six files and in the app's About panel, a changelog
entry that reflects what actually changed, and a `.dmg` built from that state.

The failure mode this skill exists to prevent is a *partial* bump — the app
reporting 1.0.0 while the README badge says 1.0.2 — so treat the checklist as a
unit and verify at the end rather than trusting each edit.

## 1. Agree on the version

Read the current version from `src-tauri/tauri.conf.json` and show it, then ask
what the new one should be. Don't guess a bump level: patch vs minor is a
judgement about the changes, and the user may also be moving channels (e.g.
`1.0.1.beta` → `1.1.0`, dropping the pre-release label).

Two things to settle before editing anything:

- **The number itself**, e.g. `1.0.2`.
- **The channel suffix.** The manifests must hold plain semver (`1.0.2`) because
  Cargo and Tauri reject `1.0.2.beta`. The `.beta` label is display-only and is
  appended in Rust — see step 3. If the user is going stable, that suffix has to
  come out, and the README badge and git tag change shape too.

Also check the working tree is clean enough (`git status --short`). Uncommitted
work is fine — it will be *in* the release — but the user should know what's
about to be baked into the build.

## 2. Bump the version everywhere

Six places hold the number. The first three are what the build actually reads;
the lockfiles keep tooling quiet; the badge is what people see on GitHub.

| File | What to change |
| --- | --- |
| `package.json` | top-level `"version"` |
| `package-lock.json` | `"version"` at the root **and** in `packages[""]` — both |
| `src-tauri/tauri.conf.json` | `"version"` — this becomes the bundle's `CFBundleShortVersionString` and the `.dmg` filename |
| `src-tauri/Cargo.toml` | `version` under `[package]` (not any dependency's) |
| `src-tauri/Cargo.lock` | the `version` line directly under `name = "markdown-editor"` |
| `README.md` | the shields.io version badge URL, which *does* carry the `.beta` suffix |

Precision matters more than cleverness here: `1.0.0` appears in unrelated
dependency entries in both lockfiles, so anchor edits to the surrounding
`name = "markdown-editor"` / `"name": "markdown-editor"` context rather than
replacing the string globally.

Verify with a single sweep before moving on:

```bash
grep -n '"version"' package.json src-tauri/tauri.conf.json
grep -n -A1 'name = "markdown-editor"' src-tauri/Cargo.lock
sed -n '1,10p' package-lock.json
grep -n 'badge/version' README.md
cargo metadata --no-deps --manifest-path src-tauri/Cargo.toml --format-version 1 | python3 -c "import json,sys; print([(p['name'],p['version']) for p in json.load(sys.stdin)['packages']])"
```

The last command is the real check on the Rust side — it fails loudly if
`Cargo.toml` and `Cargo.lock` disagree.

## 3. The UI version

The About panel (**Reevik ▸ About Reevik**) is built in
`src-tauri/src/lib.rs`, and its version string is derived, not hardcoded:

```rust
.version(Some(concat!(env!("CARGO_PKG_VERSION"), ".beta")))
```

So bumping `Cargo.toml` updates the UI automatically — **no code change is
needed for a normal bump**, and the user should be told that rather than left
wondering whether the UI was missed.

The one case that does need an edit is a channel change: going stable means
dropping `concat!(…, ".beta")` down to `env!("CARGO_PKG_VERSION")`, and going to
a different label (`.rc1`) means changing the suffix. Grep for `CARGO_PKG_VERSION`
to confirm the line hasn't moved before editing it.

## 4. Changelog

`CHANGELOG.md` lives at the repo root, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Create it if
absent; otherwise insert the new version section directly under the top-level
intro paragraph, above the previous version — newest first.

```markdown
## [1.0.2] — 2026-08-14

### Added
- …

### Fixed
- …
```

Use the real date (`date +%Y-%m-%d`), or `— unreleased` if the user is staging
the notes before shipping.

**Work out what changed, don't assume.** The scope is everything since the last
released version, which is more than this session's work:

```bash
git describe --tags --abbrev=0        # last release tag, e.g. 1.0.0.beta
git log --oneline <last-tag>..HEAD
git status --short                    # uncommitted work also ships
```

Commit messages in this repo are often terse ("Major fixes."), so read the diff
for anything you can't describe confidently — `git show --stat <sha>`, then the
hunks that touch `src/` and `src-tauri/src/`. A changelog entry invented from a
commit subject is worse than no entry, because it looks authoritative.

Write entries from the user's point of view: what they can now do, or what no
longer misbehaves, not which component was refactored. Verify any keyboard
shortcut you mention actually exists (`grep` the accelerator in
`src-tauri/src/lib.rs`) — shortcuts are the detail most likely to be wrong.

If the release warrants full notes as well, the repo's convention is a separate
`RELEASE-NOTES-<version>.md` with feature descriptions, downloads and known
limitations; the changelog entry then stays short and links to it. Ask rather
than producing both unprompted.

## 5. Build the .dmg

**Releases are built by GitHub Actions**, not locally:
`.github/workflows/release.yml` runs on any pushed tag matching `v*` and
publishes a GitHub release with a universal (Intel + Apple Silicon) `.dmg`.
Pushing the tag *is* the build.

So the local job is to make sure the tag will build, cheaply:

```bash
npx tsc --noEmit        # the CI build runs `tsc && vite build` first
```

and that step 2 really is complete — the release's `.dmg` is named from
`tauri.conf.json`, and 1.0.2 shipped as `Reevik_1.0.1_universal.dmg` because
it wasn't.

Build locally (`npm run tauri build`, → `src-tauri/target/release/bundle/dmg/`)
only when the user wants a copy without going through a release; that build is
Apple Silicon only and ad-hoc signed, unlike the CI one.

## 6. Commit, tag, push — when asked

Committing, tagging and pushing are the user's call — ask, don't assume.

The tag **must start with `v`**, or the release workflow never runs (this
happened with `1.0.2`). Form: `v<version>` for a stable release, and
`v<version>-beta` for a beta — the workflow marks a tag containing `-` as a
GitHub prerelease. The tag goes on `main`.

After pushing it, the published release can be checked without `gh`:

```bash
curl -s 'https://api.github.com/repos/reevik/reevik-markdown-app/releases?per_page=3'
```

A short summary at the end helps: the version, the files touched, the changelog
headline, the tag, and where the release will appear.
