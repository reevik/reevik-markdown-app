#!/usr/bin/env node
/**
 * Writes src/generated/licenses.json: every third-party package that ships
 * inside Reevik, with its licence and the licence text from its own files,
 * for the About page.
 *
 * - npm: production packages from package-lock.json (build-only `dev`
 *   packages never reach the app).
 * - Rust: the runtime dependency graph from `cargo metadata`, for both
 *   Apple Silicon and Intel since the release .dmg is universal. Dev and
 *   build-script dependencies are left out: they never end up in the binary.
 *
 * Texts come from each package's own LICENSE files, because MIT and BSD
 * require shipping the actual copyright notice, not just the licence name.
 * Identical texts are stored once.
 *
 * Runs as part of `npm run build`. If cargo can't be queried, the previous
 * file is kept rather than failing the build.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/generated/licenses.json");

const texts = new Map(); // hash -> text
const packages = [];

/** Licence files in a package folder: LICENSE, LICENSE-MIT, LICENCE.md, COPYING… */
function licenseText(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|unlicense)([.\-_].*)?$/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
  if (files.length === 0) return null;
  const body = files
    .map((f) => (files.length > 1 ? `--- ${f} ---\n` : "") + readFileSync(join(dir, f), "utf8").trim())
    .join("\n\n");
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 12);
  texts.set(hash, body);
  return hash;
}

function repoUrl(v) {
  let u = typeof v === "string" ? v : v?.url;
  if (!u) return null;
  u = u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://");
  u = u.replace(/^git@github\.com:/, "https://github.com/");
  if (/^github:/.test(u)) u = `https://github.com/${u.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`;
  return /^https?:\/\//.test(u) ? u : null;
}

/** For a package that declares no licence: read it off its licence file's title. */
function detectLicense(hash) {
  const head = (texts.get(hash) ?? "").slice(0, 400);
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(head)) return "MIT";
  if (/Apache License,?\s+Version 2\.0/i.test(head)) return "Apache-2.0";
  if (/\bISC License\b/i.test(head)) return "ISC";
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(head)) return "BSD-3-Clause";
  return "UNKNOWN";
}

// --- npm ----------------------------------------------------------------------
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === "" || entry.dev || entry.link) continue;
  const dir = join(root, path);
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {}
  const name = entry.name ?? meta.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
  const text = licenseText(dir);
  const declared = entry.license ?? (typeof meta.license === "string" ? meta.license : meta.license?.type);
  packages.push({
    name,
    version: entry.version ?? meta.version ?? "",
    ecosystem: "npm",
    license: declared ?? (text ? detectLicense(text) : "UNKNOWN"),
    url: repoUrl(meta.repository) ?? (meta.homepage || null),
    text,
  });
}

// --- Rust ---------------------------------------------------------------------
let rustOk = true;
try {
  const seen = new Map();
  for (const platform of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const meta = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--format-version", "1", "--manifest-path", join(root, "src-tauri/Cargo.toml"), "--filter-platform", platform],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const rootId = meta.resolve.root;
    // Follow only normal (runtime) edges; dev and build-script deps never
    // reach the shipped binary.
    const stack = [rootId];
    const visited = new Set([rootId]);
    while (stack.length) {
      const node = nodes.get(stack.pop());
      for (const dep of node?.deps ?? []) {
        if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
        if (visited.has(dep.pkg)) continue;
        visited.add(dep.pkg);
        stack.push(dep.pkg);
      }
    }
    visited.delete(rootId);
    for (const id of visited) {
      const p = byId.get(id);
      if (!p || seen.has(`${p.name}@${p.version}`)) continue;
      seen.set(`${p.name}@${p.version}`, true);
      packages.push({
        name: p.name,
        version: p.version,
        ecosystem: "rust",
        license: p.license ?? (p.license_file ? `See ${p.license_file}` : "UNKNOWN"),
        url: repoUrl(p.repository) ?? p.homepage ?? null,
        text: licenseText(dirname(p.manifest_path)),
      });
    }
  }
} catch (e) {
  rustOk = false;
  console.warn(`generate-licenses: cargo metadata failed (${e.message.split("\n")[0]}).`);
}

if (!rustOk && existsSync(OUT)) {
  console.warn("generate-licenses: keeping the existing licenses.json rather than writing an incomplete one.");
  process.exit(0);
}

packages.sort((a, b) => a.name.localeCompare(b.name) || a.ecosystem.localeCompare(b.ecosystem));
// Only keep texts that a listed package still refers to.
const used = new Set(packages.map((p) => p.text).filter(Boolean));
const out = {
  packages,
  texts: Object.fromEntries([...texts].filter(([h]) => used.has(h)).sort()),
};
writeFileSync(OUT, JSON.stringify(out) + "\n");

const counts = {};
for (const p of packages) counts[p.license] = (counts[p.license] ?? 0) + 1;
const withoutText = packages.filter((p) => !p.text);
console.log(
  `generate-licenses: ${packages.length} packages (${packages.filter((p) => p.ecosystem === "npm").length} npm, ` +
    `${packages.filter((p) => p.ecosystem === "rust").length} Rust), ${used.size} distinct texts, ` +
    `${(JSON.stringify(out).length / 1024).toFixed(0)} KB; ${withoutText.length} without a licence file.`,
);
