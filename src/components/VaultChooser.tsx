import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { addVault, createVault, listVaults, removeVault } from "../lib/api";
import type { Vault } from "../lib/types";

interface Props {
  onOpen: (vault: Vault) => void;
}

/** The Obsidian-style launcher shown before entering the workspace: pick a known
 *  vault, open an existing folder as a vault, or create a brand-new one. */
export default function VaultChooser({ onOpen }: Props) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: vaults } = useQuery({ queryKey: ["vaults"], queryFn: listVaults });

  async function openExistingFolder() {
    setError(null);
    try {
      const dir = await open({ directory: true, multiple: false, title: "Open a folder as a vault" });
      if (typeof dir !== "string") return;
      const updated = await addVault(dir);
      qc.setQueryData(["vaults"], updated);
      const vault = updated.find((v) => v.path === dir);
      if (vault) onOpen(vault);
    } catch (e) {
      setError(String(e));
    }
  }

  async function createNewVault() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    setBusy(true);
    try {
      const parent = await open({ directory: true, multiple: false, title: "Choose where to create the vault" });
      if (typeof parent !== "string") {
        setBusy(false);
        return;
      }
      const path = await createVault(parent, name);
      qc.invalidateQueries({ queryKey: ["vaults"] });
      onOpen({ path, name });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function forget(vault: Vault, e: React.MouseEvent) {
    e.stopPropagation();
    const updated = await removeVault(vault.path);
    qc.setQueryData(["vaults"], updated);
  }

  return (
    <div className="relative flex h-screen flex-col" data-tauri-drag-region>
      {/* Soft aurora in the app's indigo/violet, so the launcher isn't flat grey. */}
      <div className="vault-aurora" aria-hidden>
        <span className="vault-aurora-accent" />
      </div>

      {/* draggable region incl. space for traffic lights */}
      <div className="h-14 w-full shrink-0" data-tauri-drag-region />

      {/* Centred, and sized to its content — the list must not stretch to fill. */}
      <div className="relative flex flex-1 items-center justify-center px-8 pb-16" data-tauri-drag-region>
        <div className="rise w-full max-w-sm">
          <div className="mb-6 text-center">
            <AppLogo />
            <p className="mt-3 text-[13px] text-[var(--text-secondary)]">Open a vault to start writing.</p>
          </div>

          {/* Known vaults */}
          <div className="card vault-card max-h-[42vh] overflow-auto p-2">
          {vaults && vaults.length > 0 ? (
            vaults.map((v) => (
              <button
                key={v.path}
                onClick={() => onOpen(v)}
                className="group nav-row flex w-full items-center gap-3 px-3 py-2.5 text-left"
              >
                <VaultIcon />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">{v.name}</span>
                  <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{v.path}</span>
                </span>
                <span
                  onClick={(e) => forget(v, e)}
                  title="Remove from list (files stay on disk)"
                  className="hidden shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:bg-red-500/25 hover:text-red-600 group-hover:block"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </span>
              </button>
            ))
          ) : (
            <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-[var(--text-tertiary)]">
              No vaults yet. Open a folder of Markdown files, or create a new vault below.
            </p>
          )}
        </div>

          {/* Create new vault */}
          {creating ? (
            <div className="mt-4 flex flex-col gap-2">
              <input
                autoFocus
                value={newName}
                placeholder="New vault name"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createNewVault();
                  if (e.key === "Escape") setCreating(false);
                }}
                className="field w-full px-3 py-2 text-[13px]"
              />
              <div className="flex gap-2">
                <button onClick={() => setCreating(false)} className="btn-bezel flex-1 py-2 text-[13px]">
                  Cancel
                </button>
                <button
                  onClick={createNewVault}
                  disabled={!newName.trim() || busy}
                  className="btn-accent flex-1 py-2 text-[13px]"
                >
                  {busy ? "Creating…" : "Choose location & create"}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex gap-2">
              <button onClick={openExistingFolder} className="btn-bezel flex-1 py-2 text-[13px]">
                Open folder…
              </button>
              <button onClick={() => setCreating(true)} className="btn-accent flex-1 py-2 text-[13px]">
                Create new vault
              </button>
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The transparent owl. The Dock uses the same artwork on a tile
 *  (src-tauri/app-icon.png); on the launcher's own background the bare owl
 *  reads better than a tile within a page. */
function AppLogo() {
  return <img src="/app-logo.png" width={88} height={88} alt="Reevik" className="mx-auto" draggable={false} />;
}

function VaultIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}
