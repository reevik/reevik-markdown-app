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

// Abstract curled fox-tail glyph (shared by the dock icon in src-tauri/app-icon.svg).
const FOX_TAIL =
  "M 519.0 637.4 L 517.2 633.3 L 515.4 629.2 L 513.8 625.1 L 512.3 621.0 L 510.9 617.0 L 509.6 613.0 L 508.3 609.0 L 507.2 605.0 L 506.2 601.0 L 505.3 597.1 L 504.5 593.2 L 503.8 589.4 L 503.1 585.6 L 502.6 581.8 L 502.1 578.1 L 501.7 574.4 L 501.3 570.7 L 501.1 567.1 L 500.9 563.5 L 500.8 560.0 L 500.7 556.5 L 500.7 553.1 L 500.8 549.7 L 500.9 546.3 L 501.1 543.0 L 501.3 539.8 L 501.6 536.6 L 501.9 533.4 L 502.3 530.3 L 502.7 527.2 L 503.2 524.2 L 503.7 521.2 L 504.2 518.2 L 504.8 515.3 L 505.4 512.4 L 506.1 509.6 L 506.7 506.8 L 507.4 504.1 L 508.2 501.4 L 508.9 498.7 L 509.7 496.1 L 510.5 493.5 L 511.4 490.9 L 512.2 488.4 L 513.1 485.9 L 514.0 483.4 L 514.9 481.0 L 515.9 478.6 L 516.8 476.2 L 517.8 473.9 L 518.8 471.5 L 519.9 469.3 L 520.9 467.0 L 522.0 464.7 L 523.0 462.5 L 524.2 460.3 L 525.3 458.1 L 526.4 456.0 L 527.6 453.8 L 528.8 451.7 L 530.0 449.6 L 531.2 447.5 L 532.5 445.5 L 533.7 443.4 L 535.0 441.4 L 536.4 439.4 L 537.7 437.4 L 539.1 435.5 L 540.5 433.5 L 541.9 431.6 L 543.4 429.7 L 544.8 427.8 L 546.3 425.9 L 547.9 424.0 L 549.4 422.2 L 551.0 420.4 L 552.7 418.6 L 554.3 416.8 L 556.0 415.1 L 557.8 413.3 L 559.5 411.6 L 561.3 410.0 L 563.1 408.3 L 565.0 406.7 L 566.9 405.1 L 568.8 403.5 L 570.8 402.0 L 572.8 400.5 L 574.8 399.0 L 576.9 397.6 L 579.0 396.2 L 581.1 394.9 L 583.3 393.5 L 585.5 392.3 L 587.7 391.0 L 590.0 389.8 L 592.3 388.7 L 594.6 387.6 L 597.0 386.6 L 599.4 385.5 L 601.9 384.6 L 604.3 383.7 L 606.8 382.9 L 609.3 382.1 L 611.8 381.3 L 614.4 380.7 L 617.0 380.0 L 619.6 379.5 L 622.2 379.0 L 624.9 378.6 L 627.5 378.2 L 630.2 377.9 L 632.9 377.7 L 635.6 377.5 L 638.3 377.4 L 641.1 377.4 L 643.8 377.4 L 646.5 377.5 L 649.3 377.7 L 652.0 377.9 L 654.7 378.3 L 657.5 378.7 L 660.2 379.1 L 662.9 379.7 L 665.6 380.3 L 668.3 381.0 L 671.0 381.8 L 673.6 382.6 L 676.3 383.5 L 678.9 384.5 L 681.5 385.5 L 684.0 386.7 L 686.6 387.9 L 689.1 389.1 L 691.6 390.5 L 694.0 391.9 L 696.1 393.6 L 698.1 395.3 L 700.1 397.1 L 702.1 398.9 L 704.0 400.8 L 706.0 402.7 L 707.8 404.6 L 709.6 406.6 L 711.4 408.6 L 713.2 410.7 L 714.9 412.7 L 716.6 414.9 L 718.2 417.0 L 719.8 419.2 L 721.3 421.5 L 722.8 423.7 L 724.3 426.0 L 725.8 428.4 L 727.1 430.7 L 728.5 433.1 L 729.8 435.6 L 731.1 438.0 L 732.4 440.5 L 733.6 443.1 L 734.8 445.6 L 735.9 448.2 L 737.1 450.8 L 738.2 453.5 L 739.3 456.2 L 740.4 458.9 L 741.6 461.7 L 742.8 464.5 L 744.1 467.4 L 746.3 470.5 L 746.3 470.5 L 749.3 468.1 L 751.2 465.4 L 752.9 462.5 L 754.4 459.6 L 755.8 456.7 L 757.0 453.6 L 758.1 450.5 L 759.0 447.3 L 759.9 444.0 L 760.6 440.7 L 761.3 437.4 L 761.8 433.9 L 762.2 430.5 L 762.6 427.0 L 762.8 423.5 L 762.9 419.9 L 762.9 416.3 L 762.8 412.7 L 762.6 409.0 L 762.3 405.3 L 761.9 401.6 L 761.4 397.9 L 760.7 394.2 L 760.0 390.4 L 759.2 386.7 L 758.2 382.9 L 757.1 379.1 L 756.0 375.4 L 754.7 371.6 L 753.3 367.8 L 751.8 364.1 L 750.2 360.3 L 748.5 356.6 L 746.7 352.9 L 745.1 348.9 L 743.3 345.0 L 741.5 341.0 L 739.5 337.1 L 737.5 333.2 L 735.3 329.2 L 733.0 325.3 L 730.6 321.4 L 728.1 317.5 L 725.5 313.7 L 722.7 309.9 L 719.8 306.1 L 716.9 302.3 L 713.7 298.6 L 710.5 294.9 L 707.2 291.2 L 703.7 287.6 L 700.1 284.1 L 696.4 280.6 L 692.6 277.2 L 688.6 273.8 L 684.6 270.5 L 680.4 267.3 L 676.1 264.2 L 671.7 261.1 L 667.1 258.1 L 662.5 255.2 L 657.7 252.4 L 652.8 249.7 L 647.9 247.1 L 642.8 244.6 L 637.6 242.2 L 632.3 239.9 L 626.9 237.8 L 621.4 235.7 L 615.8 233.8 L 610.2 232.1 L 604.4 230.4 L 598.5 228.9 L 592.6 227.5 L 586.6 226.3 L 580.5 225.2 L 574.3 224.3 L 568.1 223.5 L 561.8 222.9 L 555.5 222.4 L 549.0 222.1 L 542.6 222.0 L 536.1 222.0 L 529.5 222.3 L 522.9 222.6 L 516.3 223.2 L 509.7 223.9 L 503.0 224.9 L 496.3 226.0 L 489.6 227.3 L 482.9 228.7 L 476.2 230.4 L 469.5 232.2 L 462.8 234.3 L 456.1 236.5 L 449.5 238.9 L 442.8 241.5 L 436.2 244.3 L 429.7 247.3 L 423.2 250.5 L 416.7 253.9 L 410.3 257.4 L 403.9 261.2 L 397.7 265.1 L 391.5 269.2 L 385.3 273.6 L 379.3 278.1 L 373.3 282.7 L 367.5 287.6 L 361.7 292.7 L 356.1 297.9 L 350.6 303.3 L 345.2 308.8 L 339.9 314.6 L 334.7 320.5 L 329.7 326.5 L 324.8 332.7 L 320.1 339.1 L 315.5 345.6 L 311.1 352.3 L 306.8 359.1 L 302.7 366.1 L 298.8 373.2 L 295.1 380.4 L 291.5 387.8 L 288.1 395.2 L 284.9 402.8 L 281.8 410.5 L 279.0 418.3 L 276.4 426.2 L 273.9 434.2 L 271.7 442.3 L 269.7 450.5 L 267.9 458.8 L 266.3 467.1 L 264.9 475.5 L 263.7 483.9 L 262.7 492.4 L 262.0 501.0 L 261.5 509.6 L 261.2 518.3 L 261.1 526.9 L 261.2 535.6 L 261.6 544.3 L 262.2 553.1 L 263.0 561.8 L 264.1 570.5 L 265.4 579.3 L 266.9 588.0 L 268.6 596.7 L 270.6 605.4 L 272.7 614.0 L 275.1 622.6 L 277.8 631.2 L 280.6 639.7 L 283.7 648.2 L 286.9 656.6 L 290.4 664.9 L 294.2 673.2 L 298.1 681.4 L 302.2 689.5 L 306.6 697.5 L 311.1 705.4 L 315.9 713.3 L 320.8 721.0 L 326.0 728.6 L 331.3 736.1 L 336.9 743.5 L 342.6 750.8 L 348.5 758.0 L 358.0 769.5 L 369.0 779.6 L 381.3 787.9 L 394.6 794.5 L 408.8 799.1 L 423.5 801.6 L 438.4 802.0 L 453.2 800.3 L 467.6 796.5 L 481.3 790.7 L 494.1 782.9 L 505.6 773.5 L 515.6 762.5 L 524.0 750.2 L 530.6 736.8 L 535.2 722.6 L 537.7 708.0 L 538.1 693.1 L 536.4 678.3 L 532.6 663.9 L 526.7 650.1 Z";

/** The app icon (flat squircle + curled fox tail), matching the macOS dock icon. */
function AppLogo() {
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      className="mx-auto"
    >
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c84f8" />
          <stop offset="0.55" stopColor="#6d5ff2" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <filter id="logo-shadow" x="-12%" y="-12%" width="124%" height="124%" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="12" stdDeviation="12.5" floodColor="#0b0620" floodOpacity="0.30" />
        </filter>
        <clipPath id="logo-sq">
          <rect x="104" y="104" width="816" height="816" rx="188" />
        </clipPath>
      </defs>
      <g filter="url(#logo-shadow)">
      <g clipPath="url(#logo-sq)">
        <rect x="104" y="104" width="816" height="816" fill="url(#logo-bg)" />
      </g>
      <rect x="114" y="114" width="796" height="796" rx="180" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="8" />
      <path d={FOX_TAIL} fill="#20124f" opacity="0.18" transform="translate(0 11)" />
      <path d={FOX_TAIL} fill="#ffffff" />
      </g>
    </svg>
  );
}

function VaultIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-secondary)]">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}
