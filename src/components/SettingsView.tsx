import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CliLoginHint from "./CliLoginHint";
import Segmented from "./Segmented";
import { aiBackend, getAiSettings, MODEL_OPTIONS, PROVIDERS, setLlmApiKey, setModel, setProvider } from "../lib/api";
import type { AiProvider, AiSettings } from "../lib/types";
import {
  applyEditorFont,
  applyPanelFont,
  FONT_OPTIONS,
  loadEditorFont,
  loadPanelFont,
  MAX_SIZE,
  MIN_SIZE,
  PANEL_MAX_SIZE,
  PANEL_MIN_SIZE,
  saveEditorFont,
  savePanelFont,
  stackFor,
} from "../lib/editorFont";

interface Props {
  onClose: () => void;
}

type Tab = "editor" | "ai";
const TAB_KEY = "settings.tab";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  // Kept as "editor" so a remembered tab still opens here.
  { id: "editor", label: "Fonts", icon: <EditorIcon /> },
  { id: "ai", label: "AI", icon: <SparkIcon /> },
];

export default function SettingsModal({ onClose }: Props) {
  const qc = useQueryClient();
  // Reopen on the tab used last.
  const [tab, setTabState] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      return saved === "ai" || saved === "editor" ? saved : "editor";
    } catch {
      return "editor";
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* the tab just won't be remembered */
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Typography is a pure display preference, so it lives in localStorage and is
  // applied immediately as the user changes it.
  const [font, setFont] = useState(() => loadEditorFont());
  const updateFont = (family: string, size: number) => {
    setFont({ family, size });
    saveEditorFont(family, size);
    applyEditorFont(family, size);
  };

  // The AI panels' own font, applied live the same way.
  const [panel, setPanel] = useState(() => loadPanelFont());
  const updatePanel = (family: string, size: number) => {
    setPanel({ family, size });
    savePanelFont(family, size);
    applyPanelFont(family, size);
  };

  const { data: backend } = useQuery({ queryKey: ["ai-backend"], queryFn: aiBackend });
  const { data: ai } = useQuery({ queryKey: ["ai-settings"], queryFn: getAiSettings });
  const provider: AiProvider = ai?.provider ?? "claude";
  const model = ai ? (provider === "claude" ? ai.claude_model : ai.copilot_model) : "";

  // Both return the saved settings; seed the cache with them rather than
  // waiting on a refetch, then re-ask which backend now answers.
  const onSaved = (next: AiSettings) => {
    qc.setQueryData(["ai-settings"], next);
    qc.invalidateQueries({ queryKey: ["ai-backend"] });
  };
  const saveProvider = useMutation({ mutationFn: (p: AiProvider) => setProvider(p), onSuccess: onSaved });
  const saveModel = useMutation({ mutationFn: (id: string) => setModel(provider, id), onSuccess: onSaved });

  const saveKey = useMutation({
    mutationFn: (key: string) => setLlmApiKey(key),
    onSuccess: () => {
      setApiKeyInput("");
      qc.invalidateQueries({ queryKey: ["ai-backend"] });
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="dialog-surface rise relative flex h-[min(620px,86vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-black/[0.06] hover:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        {/* Preferences-style tab bar: icon above label, centred. */}
        <header className="shrink-0 border-b border-black/[0.07] px-6 pb-2 pt-4">
          <h2 className="text-center text-[13px] font-semibold text-[var(--text-primary)]">Settings</h2>
          <div className="mt-2.5 flex justify-center gap-1" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex w-20 flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] transition-colors ${
                  tab === t.id
                    ? "bg-black/[0.07] text-[var(--accent-strong)]"
                    : "text-[var(--text-secondary)] hover:bg-black/[0.04]"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {tab === "editor" && (
            <section>
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">Editor</h3>

              <div className="mt-3 flex items-center gap-3">
                <label className="w-20 shrink-0 text-[12px] font-medium text-[var(--text-secondary)]">Font</label>
                <select
                  value={font.family}
                  onChange={(e) => updateFont(e.target.value, font.size)}
                  className="field min-w-0 flex-1 px-2 py-1.5 text-[13px]"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({f.kind})
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2.5 flex items-center gap-3">
                <label className="w-20 shrink-0 text-[12px] font-medium text-[var(--text-secondary)]">Size</label>
                <input
                  type="range"
                  min={MIN_SIZE}
                  max={MAX_SIZE}
                  step={1}
                  value={font.size}
                  onChange={(e) => updateFont(font.family, Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                />
                <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-[var(--text-secondary)]">
                  {font.size}px
                </span>
              </div>

              <p
                className="mt-3 rounded-lg border border-black/8 bg-black/[0.03] p-3 leading-relaxed text-[var(--text-primary)]"
                style={{ fontFamily: stackFor(font.family), fontSize: `${font.size}px` }}
              >
                The quick brown fox jumps over the lazy dog.
              </p>

              <h3 className="mt-7 text-[13px] font-semibold text-[var(--text-primary)]">AI panels</h3>
              <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">Editorial, Analyze and References.</p>

              <div className="mt-3 flex items-center gap-3">
                <label className="w-20 shrink-0 text-[12px] font-medium text-[var(--text-secondary)]">Font</label>
                <select
                  value={panel.family}
                  onChange={(e) => updatePanel(e.target.value, panel.size)}
                  className="field min-w-0 flex-1 px-2 py-1.5 text-[13px]"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label} ({f.kind})
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2.5 flex items-center gap-3">
                <label className="w-20 shrink-0 text-[12px] font-medium text-[var(--text-secondary)]">Size</label>
                <input
                  type="range"
                  min={PANEL_MIN_SIZE}
                  max={PANEL_MAX_SIZE}
                  step={1}
                  value={panel.size}
                  onChange={(e) => updatePanel(panel.family, Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent)]"
                />
                <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-[var(--text-secondary)]">
                  {panel.size}px
                </span>
              </div>

              <p
                className="mt-3 rounded-lg border border-black/8 bg-black/[0.03] p-3 leading-relaxed text-[var(--text-primary)]"
                style={{ fontFamily: stackFor(panel.family), fontSize: `${panel.size}px` }}
              >
                I tightened the opening paragraph and moved the summary to the end.
              </p>
            </section>
          )}

          {tab === "ai" && (
            <section>
              <div>
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Provider</label>
                <Segmented
                  className="mt-1.5"
                  size="md"
                  options={PROVIDERS}
                  value={provider}
                  onChange={(p) => saveProvider.mutate(p)}
                  disabled={saveProvider.isPending}
                />
              </div>

              <div className="mt-3 flex items-start gap-2.5">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    backend === "none" || backend === "copilot-missing"
                      ? "bg-red-400"
                      : backend === "cli-logged-out"
                        ? "bg-yellow-400"
                        : "bg-green-400"
                  }`}
                />
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {backend === "cli" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">Local Claude CLI detected.</span> Reviews
                      run through the <code className="rounded bg-black/10 px-1.5 py-0.5">claude</code> CLI on your
                      machine — no API key required.
                    </>
                  )}
                  {backend === "api" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">Using your stored API key.</span> The
                      Claude CLI was not found; reviews use the Anthropic API.
                    </>
                  )}
                  {backend === "none" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">No AI backend available.</span> Install the
                      Claude CLI, or add an Anthropic API key below.
                    </>
                  )}
                  {backend === "cli-logged-out" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">Claude CLI found, but not logged in.</span>{" "}
                      Sign in to use it, or add an Anthropic API key below.
                    </>
                  )}
                  {backend === "copilot" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">GitHub Copilot CLI detected.</span> Requests
                      run through <code className="rounded bg-black/10 px-1.5 py-0.5">copilot</code> on your machine, billed
                      to your Copilot plan. Reference search stays with Claude.
                    </>
                  )}
                  {backend === "copilot-missing" && (
                    <>
                      <span className="font-medium text-[var(--text-primary)]">GitHub Copilot CLI not found.</span> Install
                      it with <code className="rounded bg-black/10 px-1.5 py-0.5">npm install -g @github/copilot</code>, then
                      run <code className="rounded bg-black/10 px-1.5 py-0.5">copilot login</code>.
                    </>
                  )}
                </p>
              </div>
              {backend === "cli-logged-out" && <CliLoginHint className="mt-3" />}

              <div className="mt-4">
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Model</label>
                <div className="mt-1.5 flex flex-col gap-1">
                  {MODEL_OPTIONS[provider].map((m) => {
                    const active = (model ?? "") === m.id;
                    return (
                      <button
                        key={m.id || "default"}
                        onClick={() => saveModel.mutate(m.id)}
                        disabled={saveModel.isPending}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                          active ? "bg-[var(--accent-soft)]" : "hover:bg-black/5"
                        }`}
                      >
                        <span
                          className={`h-3 w-3 shrink-0 rounded-full border ${
                            active ? "border-[5px] border-[var(--accent)]" : "border-black/25"
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block text-[12.5px] font-medium ${
                              active ? "text-[var(--accent-strong)]" : "text-[var(--text-primary)]"
                            }`}
                          >
                            {m.label}
                          </span>
                          <span className="block text-[11px] text-[var(--text-tertiary)]">{m.note}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                  {provider === "claude"
                    ? "Applies to the Editorial chat, document analysis, rephrasing and reference search. Haiku is markedly faster for reviews; reference search benefits from a stronger model."
                    : "Applies to the Editorial chat, document analysis and rephrasing. More Copilot models will be listed once they're confirmed against the installed CLI."}
                </p>
              </div>

              {/* An Anthropic key only matters to the Claude provider. */}
              {provider === "claude" && (
                <>
                <div className="mt-4 flex items-center gap-2">
                  <label className="text-[12px] font-medium text-[var(--text-secondary)]">API key</label>
                  {backend === "api" && (
                    <span className="rounded-md bg-green-400/15 px-2 py-0.5 text-[11px] font-medium text-green-700">
                      configured
                    </span>
                  )}
                  {backend === "cli" && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">optional — CLI is active</span>
                  )}
                </div>
                <div className="mt-1.5 flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="sk-ant-…"
                    className="field flex-1 px-2.5 py-1.5 text-[13px]"
                  />
                  <button
                    onClick={() => saveKey.mutate(apiKeyInput)}
                    disabled={!apiKeyInput || saveKey.isPending}
                    className="btn-accent px-3.5 py-1.5 text-[13px]"
                  >
                    {saveKey.isSuccess ? "Saved ✓" : "Save"}
                  </button>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                  The key is stored in the macOS Keychain, never in the vault or app files.
                </p>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function EditorIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19l5-14h1l5 14M6.2 13h7.6" />
      <path d="M17 10.5c.6-.4 1.3-.6 2-.6 1.3 0 2 .7 2 2V19m0-4.2c-.6-.5-1.4-.8-2.3-.8-1.3 0-2.2.7-2.2 1.9s.9 2 2.1 2c1 0 1.8-.5 2.4-1.2" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6z" />
    </svg>
  );
}
