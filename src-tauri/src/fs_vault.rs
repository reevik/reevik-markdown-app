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
