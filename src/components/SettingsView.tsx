import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CliLoginHint from "./CliLoginHint";
import { aiBackend, getAiSettings, MODEL_OPTIONS, PROVIDERS, setLlmApiKey, setModel, setProvider } from "../lib/api";
import type { AiProvider, AiSettings } from "../lib/types";
import {
  applyEditorFont,
  FONT_OPTIONS,
  loadEditorFont,
  MAX_SIZE,
  MIN_SIZE,
  saveEditorFont,
  stackFor,
} from "../lib/editorFont";

interface Props {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: Props) {
  const qc = useQueryClient();
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Typography is a pure display preference, so it lives in localStorage and is
  // applied immediately as the user changes it.
  const [font, setFont] = useState(() => loadEditorFont());
  const updateFont = (family: string, size: number) => {
    setFont({ family, size });
    saveEditorFont(family, size);
    applyEditorFont(family, size);
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
        className="content-pane rise w-full max-w-lg rounded-2xl p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-tertiary)] transition-colors hover:bg-black/10 hover:text-[var(--text-primary)]"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <section className="card mt-5 p-5">
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
        </section>

        <section className="card mt-4 p-5">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">AI agent</h3>

          <div className="mt-3">
            <label className="text-[12px] font-medium text-[var(--text-secondary)]">Provider</label>
            <div className="mt-1.5 flex gap-0.5 rounded-lg bg-black/[0.06] p-0.5">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => provider !== p.id && saveProvider.mutate(p.id)}
                  disabled={saveProvider.isPending}
                  className={`flex-1 rounded-[6px] px-2 py-1 text-[12px] transition-colors ${
                    provider === p.id
                      ? "bg-white/80 font-medium text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-secondary)] hover:bg-white/40"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
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
      </div>
    </div>
  );
}
