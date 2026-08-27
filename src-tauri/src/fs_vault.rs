use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// A node in a vault's document tree: either a Markdown file or a folder.
/// Folders carry their (recursively built) `children`; files carry `None`.
#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: &'static str, // "file" | "dir"
    pub children: Option<Vec<TreeNode>>,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// Recursively builds the tree of folders and Markdown files under `root`.
/// Hidden entries (dotfiles) and macOS app bundles are skipped. Folders sort
/// before files; both are sorted case-insensitively by name. Empty folders that
/// contain no Markdown anywhere below them are pruned so the tree stays tidy.
pub fn read_tree(root: &Path) -> Result<Vec<TreeNode>> {
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }
    Ok(collect(root, 0))
}

fn collect(dir: &Path, depth: usize) -> Vec<TreeNode> {
    if depth > 32 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut dirs: Vec<TreeNode> = Vec::new();
    let mut files: Vec<TreeNode> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if name.starts_with('.') || name.ends_with(".app") {
            continue;
        }
        if path.is_dir() {
            // Show every folder (including empty ones the user just created).
            dirs.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "dir",
                children: Some(collect(&path, depth + 1)),
            });
        } else if is_markdown(&path) {
            files.push(TreeNode {
                name,
                path: path.to_string_lossy().to_string(),
                kind: "file",
                children: None,
            });
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.into_iter().chain(files).collect()
}

/// One row of a Content Index: a Markdown note, a folder that holds one, or a
/// heading inside a note. `depth` is the indent level — folder nesting for files
/// and folders, plus the heading's own `#` count for headings — so the frontend
/// can indent a flat list instead of walking a nested structure.
///
/// `anchor` is the heading's slug, empty for everything else; `path` is always
/// the note (or folder) the row points at.
#[derive(Serialize)]
pub struct IndexEntry {
    pub title: String,
    pub path: String,
    pub kind: &'static str, // "file" | "dir" | "heading"
    pub depth: usize,
    pub anchor: String,
}

/// Builds the flattened contents listing for `root` and everything below it.
///
/// `max_depth` caps how many folder levels are included (0 = no limit),
/// `include_headers` pulls each note's own headings in down to that `#` level
/// (0 = none), and `exclude` drops one file — the note hosting the index, which
/// has no business linking to itself.
pub fn read_index(
    root: &Path,
    max_depth: usize,
    include_headers: usize,
    exclude: Option<&Path>,
) -> Result<Vec<IndexEntry>> {
    if !root.is_dir() {
        bail!("{} is not a directory", root.display());
    }
    let mut out = Vec::new();
    collect_index(root, 0, max_depth, include_headers, exclude, &mut out);
    Ok(out)
}

fn collect_index(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    include_headers: usize,
    exclude: Option<&Path>,
    out: &mut Vec<IndexEntry>,
) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name.ends_with(".app") {
            continue;
        }
        if path.is_dir() {
            dirs.push(path);
        } else if is_markdown(&path) && exclude != Some(path.as_path()) {
            files.push(path);
        }
    }

    let by_name = |a: &PathBuf, b: &PathBuf| {
        let key = |p: &PathBuf| {
            p.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        key(a).cmp(&key(b))
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);

    // A folder's own pages come before its sub-sections. This inverts the
    // sidebar's folders-first order on purpose: a contents list reads as "the
    // pages here, then the sections below", the way Confluence lays one out.
    for file in &files {
        let path = file.to_string_lossy().to_string();
        out.push(IndexEntry {
            title: note_title(file),
            path: path.clone(),
            kind: "file",
            depth,
            anchor: String::new(),
        });
        // A heading sits under its note, indented by its own `#` count, so the
        // document's shape carries over into the index.
        for (level, title) in read_headings(file, include_headers) {
            out.push(IndexEntry {
                anchor: slugify(&title),
                title,
                path: path.clone(),
                kind: "heading",
                depth: depth + level,
            });
        }
    }

    if max_depth > 0 && depth + 1 >= max_depth {
        return;
    }
    for sub in &dirs {
        let mut nested = Vec::new();
        collect_index(sub, depth + 1, max_depth, include_headers, exclude, &mut nested);
        // A folder with no Markdown anywhere below it is noise in a contents list.
        if nested.is_empty() {
            continue;
        }
        out.push(IndexEntry {
            title: sub
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Untitled")
                .to_string(),
            path: sub.to_string_lossy().to_string(),
            kind: "dir",
            depth,
            anchor: String::new(),
        });
        out.append(&mut nested);
    }
}

/// A note's ATX headings down to `max_level`, as `(level, text)` in document
/// order. Returns nothing when `max_level` is 0, which is the default — reading
/// whole files is only worth it when an index actually asked for headings.
///
/// Fenced code is skipped, so a `# comment` in a shell snippet stays a comment,
/// as is YAML frontmatter, whose `---` fences would otherwise confuse nothing but
/// whose body could contain a `#` line.
fn read_headings(path: &Path, max_level: usize) -> Vec<(usize, String)> {
    if max_level == 0 {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut fence: Option<char> = None;
    let mut lines = text.lines().peekable();

    // Frontmatter, when the very first line opens it.
    if lines.peek().is_some_and(|l| l.trim_end() == "---") {
        lines.next();
        for line in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
        }
    }

    for line in lines {
        let trimmed = line.trim_start();
        // ``` or ~~~ toggles a code fence; only the matching marker closes it.
        if let Some(marker) = trimmed.chars().next().filter(|c| *c == '`' || *c == '~') {
            if trimmed.starts_with(&marker.to_string().repeat(3)) {
                match fence {
                    Some(open) if open == marker => fence = None,
                    None => fence = Some(marker),
                    _ => {}
                }
                continue;
            }
        }
        if fence.is_some() || !trimmed.starts_with('#') {
            continue;
        }

        let level = trimmed.chars().take_while(|c| *c == '#').count();
        // `#hashtag` is not a heading — ATX needs a space after the run.
        let rest = &trimmed[level..];
        if level > max_level || level > 6 || !rest.starts_with(' ') {
            continue;
        }
        // Drop any closing `###` run.
        let title = rest.trim().trim_end_matches('#').trim();
        if !title.is_empty() {
            out.push((level, title.to_string()));
        }
    }
    out
}

/// A GitHub-style anchor slug: lowercased, spaces to dashes, punctuation gone.
fn slugify(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            out.extend(ch.to_lowercase());
        } else if ch == ' ' || ch == '-' {
            // Never two dashes in a row, and never a leading one.
            if !out.ends_with('-') && !out.is_empty() {
                out.push('-');
            }
        }
    }
    out.trim_end_matches('-').to_string()
}

/// A note's display title: the `title:` key of its YAML frontmatter when it has
/// one, otherwise the file name without its extension.
fn note_title(path: &Path) -> String {
    frontmatter_title(path).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    })
}

/// Reads only the head of the file. Frontmatter is always at the top and a vault
/// can hold thousands of notes, so an index must never pull whole files off disk
/// just to learn their titles.
fn frontmatter_title(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};

    let mut reader = BufReader::new(std::fs::File::open(path).ok()?);
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    if first.trim() != "---" {
        return None;
    }
    for line in reader.lines().take(64).map_while(Result::ok) {
        if line.trim() == "---" {
            return None; // frontmatter ended without a title
        }
        // Un-indented only: a `title:` nested under some other key isn't the
        // document's title.
        let Some(rest) = line.strip_prefix("title:") else {
            continue;
        };
        let value = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

/// Moves a file or folder into `dir`, keeping its name. Fails on name clashes or
/// when moving a folder into itself or one of its descendants.
pub fn move_into(from: &Path, dir: &Path) -> Result<PathBuf> {
    if !dir.is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    let name = from.file_name().context("path has no name")?;
    let target = dir.join(name);
    if target == from {
        return Ok(target); // already there — no-op
    }
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    if from.is_dir() && dir.starts_with(from) {
        bail!("cannot move a folder into itself");
    }
    std::fs::rename(from, &target)
        .with_context(|| format!("moving {} to {}", from.display(), target.display()))?;
    Ok(target)
}

pub fn read_note(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

pub fn write_note(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents).with_context(|| format!("writing {}", path.display()))
}

/// Creates a new empty Markdown note called `name` inside `dir`. Appends a `.md`
/// extension when the caller didn't supply one. Fails if the file exists.
pub fn create_note(dir: &Path, name: &str) -> Result<PathBuf> {
    let mut file_name = sanitize_name(name)?;
    if !is_markdown(Path::new(&file_name)) {
        file_name.push_str(".md");
    }
    let target = dir.join(&file_name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::write(&target, "").with_context(|| format!("creating {}", target.display()))?;
    Ok(target)
}

/// Creates a new sub-folder called `name` inside `dir`. Fails if it exists.
pub fn create_folder(dir: &Path, name: &str) -> Result<PathBuf> {
    let folder_name = sanitize_name(name)?;
    let target = dir.join(folder_name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::create_dir(&target).with_context(|| format!("creating {}", target.display()))?;
    Ok(target)
}

/// Renames a file or folder. `to` is a bare name in the same parent directory.
pub fn rename_path(from: &Path, to_name: &str) -> Result<PathBuf> {
    let mut name = sanitize_name(to_name)?;
    // Preserve the Markdown extension for files when the user drops it.
    if from.is_file() && is_markdown(from) && !is_markdown(Path::new(&name)) {
        name.push_str(".md");
    }
    let parent = from.parent().context("path has no parent")?;
    let target = parent.join(name);
    if target.exists() {
        bail!("{} already exists", target.display());
    }
    std::fs::rename(from, &target)
        .with_context(|| format!("renaming {} to {}", from.display(), target.display()))?;
    Ok(target)
}

/// Deletes a file, or a folder and everything inside it.
pub fn delete_path(path: &Path) -> Result<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .with_context(|| format!("deleting {}", path.display()))
}

/// Rejects names that would escape the current directory or are empty.
/// Copies an external file into `dir` without ever overwriting: a clashing name
/// gains a " 2", " 3" … suffix. Plain-text imports are renamed to `.md` so they
/// show up in the vault tree. Returns the path of the new file.
pub fn import_into(src: &Path, dir: &Path) -> Result<PathBuf> {
    if !src.is_file() {
        bail!("{} is not a file", src.display());
    }
    if !dir.is_dir() {
        bail!("{} is not a directory", dir.display());
    }

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Untitled");
    let stem = sanitize_name(stem)?;

    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_lowercase();
    let ext = if ext == "markdown" { "markdown" } else if ext == "md" { "md" } else { "md" };

    let mut target = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{stem} {n}.{ext}"));
        n += 1;
    }

    std::fs::copy(src, &target)
        .with_context(|| format!("copying {} into {}", src.display(), dir.display()))?;
    Ok(target)
}

fn sanitize_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("name cannot be empty");
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        bail!("invalid name: {trimmed}");
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway vault on disk, removed when the test ends.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("reevik-index-test-{name}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Fixture(root)
        }
        fn file(&self, rel: &str, body: &str) -> &Self {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
            self
        }
        fn dir(&self, rel: &str) -> &Self {
            std::fs::create_dir_all(self.0.join(rel)).unwrap();
            self
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn rows(entries: &[IndexEntry]) -> Vec<(String, &'static str, usize)> {
        entries
            .iter()
            .map(|e| (e.title.clone(), e.kind, e.depth))
            .collect()
    }

    #[test]
    fn headings_are_off_unless_asked_for() {
        let f = Fixture::new("headings-off");
        f.file("a.md", "# One\n\n## Two\n");
        assert_eq!(rows(&read_index(&f.0, 0, 0, None).unwrap()), vec![("a".to_string(), "file", 0)]);
    }

    #[test]
    fn headings_nest_by_their_hash_count_and_stop_at_the_limit() {
        let f = Fixture::new("headings-depth");
        f.file(
            "guide.md",
            "---\ntitle: Guide\n---\n\n# Top\n\nprose\n\n## Middle\n\n### Deep\n",
        );

        assert_eq!(
            rows(&read_index(&f.0, 0, 2, None).unwrap()),
            vec![
                ("Guide".to_string(), "file", 0),
                ("Top".to_string(), "heading", 1),
                ("Middle".to_string(), "heading", 2),
            ]
        );
        assert_eq!(
            rows(&read_index(&f.0, 0, 3, None).unwrap()).last().unwrap().clone(),
            ("Deep".to_string(), "heading", 3)
        );
    }

    #[test]
    fn headings_ignore_code_fences_frontmatter_and_hashtags() {
        let f = Fixture::new("headings-noise");
        f.file(
            "n.md",
            "---\ntitle: N\n# not a heading, this is frontmatter\n---\n\n\
             # Real\n\n\
             ```sh\n# just a shell comment\n```\n\n\
             #hashtag\n\n\
             ~~~\n# tilde-fenced comment\n~~~\n\n\
             ## Closing run ##\n",
        );

        assert_eq!(
            rows(&read_index(&f.0, 0, 6, None).unwrap()),
            vec![
                ("N".to_string(), "file", 0),
                ("Real".to_string(), "heading", 1),
                ("Closing run".to_string(), "heading", 2),
            ]
        );
    }

    #[test]
    fn anchors_are_github_style_slugs() {
        assert_eq!(slugify("Rate Limiting"), "rate-limiting");
        assert_eq!(slugify("What's *new*?"), "whats-new");
        assert_eq!(slugify("  Leading — and trailing  "), "leading-and-trailing");
        assert_eq!(slugify("snake_case and dash-ed"), "snake_case-and-dash-ed");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn titles_come_from_frontmatter_then_the_file_name() {
        let f = Fixture::new("titles");
        f.file("a.md", "---\ntitle: A Proper Title\n---\n\n# ignored\n")
            .file("b.md", "# Just a heading\n")
            .file("c.md", "---\nauthor: nobody\n---\n\nbody\n")
            .file("d.md", "---\ntitle: \"Quoted\"\n---\n")
            .file("e.md", "---\nbook:\n  title: nested\n---\n");

        let index = read_index(&f.0, 0, 0, None).unwrap();
        assert_eq!(
            rows(&index),
            vec![
                ("A Proper Title".to_string(), "file", 0),
                ("b".to_string(), "file", 0),
                ("c".to_string(), "file", 0),
                ("Quoted".to_string(), "file", 0),
                // An indented `title:` belongs to another key, not the document.
                ("e".to_string(), "file", 0),
            ]
        );
    }

    #[test]
    fn pages_precede_sections_and_nest_by_depth() {
        let f = Fixture::new("order");
        f.file("zebra.md", "")
            .file("apple.md", "")
            .file("Specs/one.md", "---\ntitle: Spec One\n---\n")
            .file("Specs/Deep/two.md", "");

        let index = read_index(&f.0, 0, 0, None).unwrap();
        assert_eq!(
            rows(&index),
            vec![
                ("apple".to_string(), "file", 0),
                ("zebra".to_string(), "file", 0),
                ("Specs".to_string(), "dir", 0),
                ("Spec One".to_string(), "file", 1),
                ("Deep".to_string(), "dir", 1),
                ("two".to_string(), "file", 2),
            ]
        );
    }

    #[test]
    fn max_depth_caps_the_levels_walked() {
        let f = Fixture::new("depth");
        f.file("top.md", "").file("Sub/inner.md", "").file("Sub/Deeper/x.md", "");

        assert_eq!(
            rows(&read_index(&f.0, 1, 0, None).unwrap()),
            vec![("top".to_string(), "file", 0)]
        );
        assert_eq!(
            rows(&read_index(&f.0, 2, 0, None).unwrap()),
            vec![
                ("top".to_string(), "file", 0),
                ("Sub".to_string(), "dir", 0),
                ("inner".to_string(), "file", 1),
            ]
        );
    }

    #[test]
    fn skips_the_host_note_hidden_entries_and_barren_folders() {
        let f = Fixture::new("skips");
        f.file("index.md", "")
            .file("other.md", "")
            .file("notes.txt", "not markdown")
            .file(".hidden.md", "")
            .dir("Empty")
            .file("Pictures/photo.png", "")
            .file("Archive/old.md", "");

        let host = f.0.join("index.md");
        let index = read_index(&f.0, 0, 0, Some(&host)).unwrap();
        assert_eq!(
            rows(&index),
            vec![
                ("other".to_string(), "file", 0),
                ("Archive".to_string(), "dir", 0),
                ("old".to_string(), "file", 1),
            ]
        );
    }
}
