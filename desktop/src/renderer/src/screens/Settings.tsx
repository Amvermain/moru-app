/**
 * Settings screen.
 * Side-tab layout: Models/API keys, General, Account, About. API keys are
 * stored in the OS keychain via moru.secrets ("apikey:<providerId>").
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { moru } from "@/lib/bridge";
import { formatInt } from "@/lib/format";
import { CLI_PROVIDERS, isKeylessProvider, modelDisplayName } from "@/lib/models";
import { WEB_URL, WebApiError, web } from "@/lib/web";
import { useAccount } from "@/stores/account";
import { useRouter } from "@/stores/router";
import { useSettings } from "@/stores/settings";
import type { UpdateState } from "../../../shared/bridge";
import type { Provider } from "../../../shared/engine";

type TabId = "models" | "general" | "account" | "about";

const TAB_IDS: readonly TabId[] = ["models", "general", "account", "about"];

/** Design decoration per known provider id (logo tile + key placeholder hint). */
const PROVIDER_DECOR: Record<string, { bg: string; ink?: string; initial?: string; keyPrefix?: string }> = {
  anthropic: { bg: "#C9704D", keyPrefix: "sk-ant-..." },
  openai: { bg: "#10A37F", keyPrefix: "sk-..." },
  google: { bg: "#4285F4", keyPrefix: "AIza..." },
  gemini: { bg: "#4285F4", keyPrefix: "AIza..." },
  openrouter: { bg: "#6366F1", keyPrefix: "sk-or-..." },
  ollama: { bg: "#A78BFA", ink: "#0A100D", initial: "L" },
  "openai-compatible": { bg: "#38BDF8", ink: "#0A100D", initial: "C" },
  "claude-code": { bg: "#C9704D", initial: "C" },
  codex: { bg: "#10A37F", initial: "X" },
  "gemini-cli": { bg: "#4285F4", initial: "G" },
};

function providerDecor(provider: Provider): { bg: string; ink: string; initial: string; keyPrefix?: string } {
  const decor = PROVIDER_DECOR[provider.id];
  return {
    bg: decor?.bg ?? "#1F8A5B",
    ink: decor?.ink ?? "#FFF",
    initial: decor?.initial ?? (provider.name.charAt(0).toUpperCase() || "?"),
    keyPrefix: decor?.keyPrefix,
  };
}

function maskKey(key: string): string {
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 12)}${"•".repeat(20)}${key.slice(-4)}`;
}

function TabIcon({ tab, active }: { tab: TabId; active: boolean }) {
  const stroke = active ? "#3DDC84" : "currentColor";
  switch (tab) {
    case "models":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.5">
          <rect x="2" y="4" width="10" height="7" />
          <path d="M5 4 V2 H9 V4" />
          <circle cx="7" cy="8" r="1.5" />
        </svg>
      );
    case "general":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.5">
          <circle cx="7" cy="7" r="5" />
          <path d="M2 7 H12 M7 2 A5 8 0 0 1 7 12 M7 2 A5 8 0 0 0 7 12" />
        </svg>
      );
    case "account":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.5">
          <circle cx="7" cy="5" r="2.5" />
          <path d="M2 12 A5 4 0 0 1 12 12" />
        </svg>
      );
    case "about":
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.5">
          <circle cx="7" cy="7" r="5" />
          <path d="M7 4 V7 M7 10 V10.01" />
        </svg>
      );
  }
}

/** Tab header: mono breadcrumb label + title + description. */
function TabHeader({ label, title, desc }: { label: string; title: string; desc: string }) {
  return (
    <>
      <div className="mb-2 flex items-center gap-[10px] font-mono text-[11px] font-semibold tracking-[0.08em] text-text3 uppercase">
        <span className="text-accent">▍</span>
        <span>{label}</span>
      </div>
      <h1 className="mb-[6px] text-2xl font-bold tracking-[-0.02em] text-text">{title}</h1>
      <p className="mb-7 text-[13px] text-text2">{desc}</p>
    </>
  );
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

/** Bottom status strip of a provider card. */
function TestStatusLine({ status }: { status: TestStatus }) {
  const { t } = useTranslation();
  if (status.kind === "idle") return null;
  const dot =
    status.kind === "testing" ? (
      <div className="h-[6px] w-[6px] animate-pxpulse bg-text3" />
    ) : status.kind === "ok" ? (
      <div className="h-[6px] w-[6px] bg-accent" />
    ) : (
      <div className="h-[6px] w-[6px] bg-red" />
    );
  const text =
    status.kind === "testing"
      ? t("settings.models.testing")
      : status.kind === "ok"
        ? t("settings.models.testOk")
        : t("settings.models.testFail", { message: status.message });
  const color = status.kind === "testing" ? "text-text2" : status.kind === "ok" ? "text-accent" : "text-red";
  return (
    <div className="flex items-center gap-[10px] border-t border-line2 px-5 py-3">
      {dot}
      <span className={`font-mono text-[11px] ${color}`}>{text}</span>
    </div>
  );
}

function testStatusOf(mutation: {
  isPending: boolean;
  error: Error | null;
  data?: { ok: boolean; error: string | null };
}): TestStatus {
  if (mutation.isPending) return { kind: "testing" };
  if (mutation.error) return { kind: "fail", message: mutation.error.message };
  if (mutation.data) {
    return mutation.data.ok ? { kind: "ok" } : { kind: "fail", message: mutation.data.error ?? "unknown" };
  }
  return { kind: "idle" };
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  return connected ? (
    <span className="flex items-center gap-1 bg-[rgba(61,220,132,0.08)] px-[5px] py-[2px] font-mono text-[10px] text-accent">
      <div className="h-[5px] w-[5px] bg-accent" />
      {t("settings.models.connected")}
    </span>
  ) : (
    <span className="flex items-center gap-1 bg-bar px-[5px] py-[2px] font-mono text-[10px] text-text3">
      <div className="h-[5px] w-[5px] bg-text4" />
      {t("settings.models.noKey")}
    </span>
  );
}

function ProviderCard({
  provider,
  savedKey,
  onSavedKeyChange,
}: {
  provider: Provider;
  savedKey: string | null;
  onSavedKeyChange: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const decor = providerDecor(provider);
  const [input, setInput] = useState("");
  const [reveal, setReveal] = useState(false);

  const queryClient = useQueryClient();
  /* W3 reads keys through react-query; refresh its caches on every write */
  const invalidateKeyCaches = async () => {
    await queryClient.invalidateQueries({ queryKey: ["secret", provider.id] });
    await queryClient.invalidateQueries({ queryKey: ["secrets"] });
    await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
  };

  const test = useMutation({
    mutationFn: (apiKey?: string) => api.testProvider(provider.id, apiKey),
  });

  const connected = (typeof savedKey === "string" && savedKey.length > 0) || provider.has_key;
  /* live model list once a key is usable; static catalog line otherwise */
  const liveModels = useQuery({
    queryKey: ["provider-models", provider.id, savedKey !== null ? "key" : "nokey", ""],
    enabled: connected || provider.id === "openrouter",
    queryFn: () => api.providerModels(provider.id, savedKey ?? undefined),
  });
  const models =
    liveModels.data !== undefined && liveModels.data.models.length > 0
      ? liveModels.data.models
      : provider.models;
  const modelsLine = models.slice(0, 6).map(modelDisplayName).join(", ");

  const save = async () => {
    const key = input.trim();
    if (key.length === 0) return;
    await moru.secrets.set(`apikey:${provider.id}`, key);
    onSavedKeyChange(key);
    setInput("");
    setReveal(false);
    await invalidateKeyCaches();
  };

  const remove = async () => {
    await moru.secrets.delete(`apikey:${provider.id}`);
    onSavedKeyChange(null);
    setReveal(false);
    test.reset();
    await invalidateKeyCaches();
  };

  return (
    <div className="mb-3 border border-line2 bg-raised">
      <div className="flex items-center gap-[14px] border-b border-line2 px-5 py-4">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center font-mono text-sm font-bold"
          style={{ background: decor.bg, color: decor.ink }}
        >
          {decor.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-[2px] flex items-center gap-2">
            <span className="text-sm font-bold text-text">{provider.name}</span>
            <ConnectionBadge connected={connected} />
          </div>
          <div className="truncate font-mono text-[11px] text-text3">{modelsLine}</div>
        </div>
      </div>

      <div className="grid grid-cols-[90px_1fr_auto] items-center gap-[10px] px-5 py-4">
        <div className="text-xs font-semibold text-text2">{t("settings.models.keyLabel")}</div>

        {savedKey !== null ? (
          <div className="flex min-w-0 items-center justify-between border border-edge bg-card px-3 py-2 font-mono text-xs text-text">
            <span className="truncate">{reveal ? savedKey : maskKey(savedKey)}</span>
            <button
              className="ml-2 shrink-0 text-[11px] text-text3 hover:text-text"
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? t("settings.models.hide") : t("settings.models.show")}
            </button>
          </div>
        ) : (
          <input
            type="password"
            value={input}
            spellCheck={false}
            autoComplete="off"
            placeholder={
              decor.keyPrefix !== undefined
                ? t("settings.models.keyPlaceholderPrefixed", { prefix: decor.keyPrefix })
                : t("settings.models.keyPlaceholder")
            }
            onChange={(e) => setInput(e.target.value)}
            className="min-w-0 border border-edge bg-card px-3 py-2 font-mono text-xs text-text placeholder:text-text4 focus:border-edge2"
          />
        )}

        <div className="flex gap-[6px]">
          <button
            className="border border-accent bg-transparent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={test.isPending || (savedKey === null && input.trim().length === 0 && !provider.has_key)}
            onClick={() => {
              test.mutate(savedKey ?? (input.trim().length > 0 ? input.trim() : undefined));
            }}
          >
            {t("settings.models.test")}
          </button>
          {savedKey !== null ? (
            <button
              className="border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 hover:border-red hover:text-red"
              onClick={() => void remove()}
            >
              {t("settings.models.remove")}
            </button>
          ) : (
            <button
              className="border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              disabled={input.trim().length === 0}
              onClick={() => void save()}
            >
              {t("settings.models.save")}
            </button>
          )}
        </div>

        {savedKey === null && provider.has_key && (
          <div className="col-span-2 col-start-2 font-mono text-[10px] text-text3">
            {t("settings.models.envKeyHint")}
          </div>
        )}
      </div>

      <TestStatusLine status={testStatusOf(test)} />
    </div>
  );
}

/**
 * Coding-CLI subscription card (Claude Code, Codex, Gemini CLI). There is
 * no key field: the engine rides the OAuth grant the CLI already stores,
 * so the card reports whether that grant is readable and names the command
 * that fixes it when it is not.
 */
function CliProviderCard({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const decor = providerDecor(provider);
  const connected = provider.connected ?? provider.has_key;

  const test = useMutation({
    mutationFn: () => api.testProvider(provider.id, undefined, provider.models[0]),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });

  return (
    <div className="relative mb-3 overflow-hidden border border-line2 bg-raised">
      <div className="flex items-center gap-[14px] border-b border-line2 px-5 py-4">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center font-mono text-sm font-bold"
          style={{ background: decor.bg, color: decor.ink }}
        >
          {decor.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-[2px] flex items-center gap-2">
            <span className="text-sm font-bold text-text">{provider.name}</span>
            <span className="bg-[rgba(61,220,132,0.08)] px-[5px] py-[2px] font-mono text-[10px] text-accent">
              {t("settings.models.cliSubscription")}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-text3">
            {provider.models.map(modelDisplayName).join(", ")}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`font-mono text-xs font-bold ${connected ? "text-accent" : "text-text3"}`}
          >
            {connected ? t("settings.models.cliConnected") : t("settings.models.cliDisconnected")}
          </div>
          {connected && provider.account !== null && provider.account !== undefined && (
            <div className="font-mono text-[10px] text-text3">{provider.account}</div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-[10px] px-5 py-4">
        <div className="min-w-0 flex-1 font-mono text-[11px] text-text3">
          {connected
            ? t("settings.models.cliReady")
            : t("settings.models.cliLoginHint", { cmd: provider.login_hint ?? "" })}
        </div>
        <button
          className="shrink-0 border border-accent bg-transparent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {t("settings.models.test")}
        </button>
      </div>

      <TestStatusLine status={testStatusOf(test)} />
    </div>
  );
}

/** Ollama card: purple accent, dot-pattern decoration, base URL instead of a key. */
function OllamaCard({ provider }: { provider: Provider | undefined }) {
  const { t } = useTranslation();
  const ollamaBaseUrl = useSettings((s) => s.ollamaBaseUrl);
  const set = useSettings((s) => s.set);

  const liveModels = useQuery({
    queryKey: ["provider-models", "ollama", "nokey", ollamaBaseUrl],
    queryFn: () => api.providerModels("ollama", undefined, ollamaBaseUrl),
  });
  const models =
    liveModels.data?.source === "live" ? liveModels.data.models : (provider?.models ?? []);
  const modelsLine =
    models.length > 0
      ? models.map(modelDisplayName).join(", ")
      : t("settings.models.ollamaModelsUnknown");

  const test = useMutation({
    mutationFn: () => api.testProvider("ollama", undefined, models[0], ollamaBaseUrl),
  });

  return (
    <div className="relative mb-3 overflow-hidden border border-purple bg-raised">
      <div
        className="absolute -top-2 -right-2 h-[60px] w-[60px] opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle at 2px 2px, #A78BFA 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      />
      <div className="flex items-center gap-[14px] border-b border-line2 px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-purple font-mono text-sm font-bold text-[#0A100D]">
          L
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-[2px] flex items-center gap-2">
            <span className="text-sm font-bold text-text">{t("settings.models.ollamaTitle")}</span>
            <span className="bg-[rgba(167,139,250,0.08)] px-[5px] py-[2px] font-mono text-[10px] text-purple">
              {t("settings.models.ollamaFree")}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-text3">{modelsLine}</div>
        </div>
        <div className="shrink-0 text-right">
          {models.length > 0 && (
            <div className="font-mono text-xs font-bold text-purple">
              {t("settings.models.ollamaModelCount", { n: models.length })}
            </div>
          )}
          <div className="font-mono text-[10px] text-text3">{ollamaBaseUrl}</div>
        </div>
      </div>

      <div className="grid grid-cols-[90px_1fr_auto] items-center gap-[10px] px-5 py-4">
        <div className="text-xs font-semibold text-text2">{t("settings.models.baseUrlLabel")}</div>
        <input
          type="text"
          value={ollamaBaseUrl}
          spellCheck={false}
          onChange={(e) => set({ ollamaBaseUrl: e.target.value })}
          className="min-w-0 border border-edge bg-card px-3 py-2 font-mono text-xs text-text placeholder:text-text4 focus:border-edge2"
        />
        <button
          className="border border-accent bg-transparent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {t("settings.models.test")}
        </button>
      </div>

      <TestStatusLine status={testStatusOf(test)} />
    </div>
  );
}

/**
 * OpenAI-compatible server card (LM Studio, llama.cpp, vLLM, ...): base
 * URL + optional API key. Models come live from the server; the test call
 * uses the first one since there is no static catalog.
 */
function CompatCard({
  savedKey,
  onSavedKeyChange,
}: {
  savedKey: string | null;
  onSavedKeyChange: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const baseUrl = useSettings((s) => s.openaiCompatBaseUrl);
  const set = useSettings((s) => s.set);
  const [keyInput, setKeyInput] = useState("");

  const queryClient = useQueryClient();
  const invalidateKeyCaches = async () => {
    await queryClient.invalidateQueries({ queryKey: ["secret", "openai-compatible"] });
    await queryClient.invalidateQueries({ queryKey: ["secrets"] });
    await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
  };

  const liveModels = useQuery({
    queryKey: ["provider-models", "openai-compatible", savedKey !== null ? "key" : "nokey", baseUrl],
    queryFn: () => api.providerModels("openai-compatible", savedKey ?? undefined, baseUrl),
  });
  const models = liveModels.data?.source === "live" ? liveModels.data.models : [];
  const modelsLine =
    models.length > 0
      ? models.map(modelDisplayName).join(", ")
      : t("settings.models.compatModelsUnknown");

  const test = useMutation({
    mutationFn: () =>
      api.testProvider(
        "openai-compatible",
        savedKey ?? (keyInput.trim().length > 0 ? keyInput.trim() : undefined),
        models[0],
        baseUrl,
      ),
  });

  const saveKey = async () => {
    const key = keyInput.trim();
    if (key.length === 0) return;
    await moru.secrets.set("apikey:openai-compatible", key);
    onSavedKeyChange(key);
    setKeyInput("");
    await invalidateKeyCaches();
  };

  const removeKey = async () => {
    await moru.secrets.delete("apikey:openai-compatible");
    onSavedKeyChange(null);
    test.reset();
    await invalidateKeyCaches();
  };

  return (
    <div className="relative mb-3 overflow-hidden border border-[#38BDF8] bg-raised">
      <div
        className="absolute -top-2 -right-2 h-[60px] w-[60px] opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle at 2px 2px, #38BDF8 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      />
      <div className="flex items-center gap-[14px] border-b border-line2 px-5 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#38BDF8] font-mono text-sm font-bold text-[#0A100D]">
          C
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-[2px] flex items-center gap-2">
            <span className="text-sm font-bold text-text">
              {t("settings.models.compatTitle")}
            </span>
            <span className="bg-[rgba(56,189,248,0.08)] px-[5px] py-[2px] font-mono text-[10px] text-[#38BDF8]">
              {t("settings.models.compatChip")}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-text3">{modelsLine}</div>
        </div>
        <div className="shrink-0 text-right">
          {models.length > 0 && (
            <div className="font-mono text-xs font-bold text-[#38BDF8]">
              {t("settings.models.ollamaModelCount", { n: models.length })}
            </div>
          )}
          <div className="font-mono text-[10px] text-text3">{baseUrl}</div>
        </div>
      </div>

      <div className="grid grid-cols-[90px_1fr_auto] items-center gap-[10px] px-5 py-4">
        <div className="text-xs font-semibold text-text2">{t("settings.models.baseUrlLabel")}</div>
        <input
          type="text"
          value={baseUrl}
          spellCheck={false}
          placeholder="http://localhost:1234/v1"
          onChange={(e) => set({ openaiCompatBaseUrl: e.target.value })}
          className="min-w-0 border border-edge bg-card px-3 py-2 font-mono text-xs text-text placeholder:text-text4 focus:border-edge2"
        />
        <button
          className="border border-accent bg-transparent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={test.isPending || models.length === 0}
          onClick={() => test.mutate()}
        >
          {t("settings.models.test")}
        </button>

        <div className="text-xs font-semibold text-text2">{t("settings.models.keyLabel")}</div>
        {savedKey !== null ? (
          <div className="flex min-w-0 items-center justify-between border border-edge bg-card px-3 py-2 font-mono text-xs text-text">
            <span className="truncate">{maskKey(savedKey)}</span>
          </div>
        ) : (
          <input
            type="password"
            value={keyInput}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("settings.models.compatKeyPlaceholder")}
            onChange={(e) => setKeyInput(e.target.value)}
            className="min-w-0 border border-edge bg-card px-3 py-2 font-mono text-xs text-text placeholder:text-text4 focus:border-edge2"
          />
        )}
        {savedKey !== null ? (
          <button
            className="border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 hover:border-red hover:text-red"
            onClick={() => void removeKey()}
          >
            {t("settings.models.remove")}
          </button>
        ) : (
          <button
            className="border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
            disabled={keyInput.trim().length === 0}
            onClick={() => void saveKey()}
          >
            {t("settings.models.save")}
          </button>
        )}
      </div>

      <TestStatusLine status={testStatusOf(test)} />
    </div>
  );
}

function ModelsTab() {
  const { t } = useTranslation();
  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: () => api.providers() });
  const [savedKeys, setSavedKeys] = useState<Record<string, string | null>>({});

  const providers = providersQuery.data;

  useEffect(() => {
    if (providers === undefined) return;
    let cancelled = false;
    void Promise.all(
      providers.map(async (p) => [p.id, await moru.secrets.get(`apikey:${p.id}`)] as const),
    ).then((pairs) => {
      if (!cancelled) setSavedKeys(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [providers]);

  return (
    <>
      <TabHeader
        label={t("settings.tabs.models")}
        title={t("settings.models.title")}
        desc={t("settings.models.desc")}
      />

      {providersQuery.isPending && (
        <div className="flex items-center gap-[10px] border border-line2 bg-raised px-5 py-4">
          <div className="h-[6px] w-[6px] animate-pxpulse bg-accent" />
          <span className="font-mono text-[11px] text-text2">{t("settings.models.loading")}</span>
        </div>
      )}

      {providersQuery.isError && (
        <div className="border border-line2 bg-raised px-5 py-4">
          <div className="flex items-center gap-[10px]">
            <div className="h-[6px] w-[6px] bg-red" />
            <span className="font-mono text-[11px] text-red">{t("settings.models.loadError")}</span>
            <span className="truncate font-mono text-[10px] text-text3">
              {providersQuery.error.message}
            </span>
          </div>
          <button
            className="mt-3 border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text"
            onClick={() => void providersQuery.refetch()}
          >
            {t("common.action.retry")}
          </button>
        </div>
      )}

      {providers !== undefined && (
        <>
          {providers.length === 0 && (
            <div
              className="mb-3 border border-line2 px-5 py-6 text-center font-mono text-[11px] text-text3"
              style={{
                backgroundImage: "radial-gradient(circle at 2px 2px, #1F2B25 1px, transparent 1px)",
                backgroundSize: "8px 8px",
              }}
            >
              {t("settings.models.empty")}
            </div>
          )}
          {providers
            .filter((p) => !isKeylessProvider(p.id))
            .map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                savedKey={savedKeys[p.id] ?? null}
                onSavedKeyChange={(key) => setSavedKeys((prev) => ({ ...prev, [p.id]: key }))}
              />
            ))}
          {providers
            .filter((p) => CLI_PROVIDERS[p.id] === true)
            .map((p) => (
              <CliProviderCard key={p.id} provider={p} />
            ))}
          <OllamaCard provider={providers.find((p) => p.id === "ollama")} />
          <CompatCard
            savedKey={savedKeys["openai-compatible"] ?? null}
            onSavedKeyChange={(key) =>
              setSavedKeys((prev) => ({ ...prev, "openai-compatible": key }))
            }
          />
        </>
      )}
    </>
  );
}

/** One settings row - title/description on the left, control on the right. */
function SettingRow({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center border border-line2 bg-raised px-4 py-3">
      <div className="min-w-0 flex-1 pr-4">
        <div className="text-[13px] font-semibold text-text">{title}</div>
        <div className="mt-[2px] font-mono text-[11px] text-text3">{desc}</div>
      </div>
      {children}
    </div>
  );
}

/** Native select styled as a value chip (custom chevron). */
function SelectChip({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none border border-edge bg-card py-[6px] pr-7 pl-[10px] font-mono text-[11px] text-text"
      >
        {children}
      </select>
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="#6A7C74"
        strokeWidth="1.5"
        className="pointer-events-none absolute top-1/2 right-[10px] -translate-y-1/2"
      >
        <path d="M2 3 L5 6 L8 3" />
      </svg>
    </div>
  );
}

function GeneralTab() {
  const { t } = useTranslation();
  const uiLanguage = useSettings((s) => s.uiLanguage);
  const theme = useSettings((s) => s.theme);
  const outputDir = useSettings((s) => s.outputDir);
  const set = useSettings((s) => s.set);
  const replayOnboarding = useRouter((s) => s.replayOnboarding);

  const pickOutputDir = async () => {
    const path = await moru.pickFolder();
    if (path !== null) set({ outputDir: path });
  };

  return (
    <>
      <TabHeader
        label={t("settings.tabs.general")}
        title={t("settings.general.title")}
        desc={t("settings.general.desc")}
      />
      <div className="flex flex-col gap-[2px]">
        <SettingRow title={t("settings.general.language")} desc={t("settings.general.languageDesc")}>
          <SelectChip value={uiLanguage} onChange={(v) => set({ uiLanguage: v as "ko" | "en" })}>
            <option value="ko">{t("settings.general.korean")}</option>
            <option value="en">{t("settings.general.english")}</option>
          </SelectChip>
        </SettingRow>

        <SettingRow title={t("settings.general.theme")} desc={t("settings.general.themeDesc")}>
          <SelectChip value={theme} onChange={() => set({ theme: "dark" })}>
            <option value="dark">{t("settings.general.themeDark")}</option>
            <option value="light" disabled>
              {t("settings.general.themeLightSoon")}
            </option>
          </SelectChip>
        </SettingRow>

        <SettingRow title={t("settings.general.outputDir")} desc={t("settings.general.outputDirDesc")}>
          <div className="flex min-w-0 items-center gap-[6px]">
            <div
              className={`max-w-[280px] truncate border border-edge bg-card px-[10px] py-[6px] font-mono text-[11px] ${outputDir !== null ? "text-text" : "text-text3"}`}
              title={outputDir ?? undefined}
            >
              {outputDir ?? t("settings.general.outputDirDefault")}
            </div>
            <button
              className="shrink-0 border border-edge bg-transparent px-3 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text"
              onClick={() => void pickOutputDir()}
            >
              {t("settings.general.browse")}
            </button>
            <button
              className="shrink-0 border border-edge bg-transparent px-3 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              disabled={outputDir === null}
              onClick={() => set({ outputDir: null })}
            >
              {t("settings.general.resetDefault")}
            </button>
          </div>
        </SettingRow>

        <SettingRow title={t("settings.general.tutorial")} desc={t("settings.general.tutorialDesc")}>
          <button
            className="shrink-0 border border-edge bg-transparent px-3 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text"
            onClick={() => replayOnboarding()}
          >
            {t("settings.general.tutorialReplay")}
          </button>
        </SettingRow>
      </div>
    </>
  );
}

function AccountTab() {
  const { t } = useTranslation();
  const account = useAccount();
  /* set when a 401 auto-logout kicked the user back to the guest view */
  const [sessionExpired, setSessionExpired] = useState(false);

  const profileQuery = useQuery({
    queryKey: ["web-me", account.token],
    enabled: account.token !== null,
    retry: false,
    queryFn: () => web.me(account.token ?? ""),
  });

  /* expired token: drop the dead session instead of a permanent error box */
  const unauthorized =
    profileQuery.error instanceof WebApiError && profileQuery.error.status === 401;
  useEffect(() => {
    if (!unauthorized) return;
    setSessionExpired(true);
    void useAccount.getState().logout();
  }, [unauthorized]);
  useEffect(() => {
    if (account.status === "connected") setSessionExpired(false);
  }, [account.status]);

  const header = (
    <TabHeader
      label={t("settings.tabs.account")}
      title={t("settings.account.title")}
      desc={t("settings.account.desc")}
    />
  );

  if (account.status !== "connected") {
    return (
      <>
        {header}
        {sessionExpired && (
          <div className="mb-3 flex max-w-[520px] items-center gap-[10px] border border-amber/30 bg-amber/5 px-4 py-3">
            <div className="h-[6px] w-[6px] shrink-0 bg-amber" />
            <span className="font-mono text-[11px] text-text2">
              {t("settings.account.sessionExpired")}
            </span>
          </div>
        )}
        <div className="flex max-w-[520px] flex-col items-center border border-line2 bg-raised px-10 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center border border-edge bg-card">
            <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="#6A7C74" strokeWidth="1.5">
              <circle cx="7" cy="5" r="2.5" />
              <path d="M2 12 A5 4 0 0 1 12 12" />
            </svg>
          </div>
          <div className="mt-4 text-sm font-bold text-text">{t("settings.account.guest")}</div>
          <p className="mt-2 max-w-[360px] text-xs leading-relaxed text-text2">
            {t("settings.account.guestDesc")}
          </p>
          <button
            onClick={() => void account.login()}
            disabled={account.pending}
            className="mt-5 bg-discord px-4 py-[10px] text-xs font-bold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("settings.account.discordLogin")}
          </button>
          {account.pending && (
            <div className="mt-3 flex items-center gap-[6px] font-mono text-[10px] text-amber">
              <div className="h-1 w-1 animate-pxpulse bg-amber" />
              {t("settings.account.waitingBrowser")}
            </div>
          )}
        </div>
      </>
    );
  }

  const profile = profileQuery.data;
  return (
    <>
      {header}
      <div className="max-w-[520px] border border-line2 bg-raised p-6">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center text-[15px] font-bold text-bar"
            style={{ background: "linear-gradient(135deg, #3DDC84, #1F8A5B)" }}
          >
            {(account.name ?? "").slice(0, 2).toUpperCase() || "?"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-text">{account.name}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-text3">
              <div className="h-1 w-1 bg-discord" />
              {t("common.account.connected")}
            </div>
          </div>
          {profile !== undefined && (
            <span className="bg-[rgba(167,139,250,0.08)] px-[6px] py-[3px] font-mono text-[10px] text-purple">
              {t("settings.account.score", { score: formatInt(profile.contributionScore) })}
            </span>
          )}
        </div>
        {profileQuery.isError && !unauthorized && (
          <div className="mt-3 border border-amber/30 bg-amber/5 px-3 py-2 text-[11px] leading-[1.5] text-text2">
            {t("settings.account.profileError")}
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            onClick={() =>
              void moru.openExternal(`${WEB_URL}/ko/u/${encodeURIComponent(account.name ?? "")}`)
            }
            className="border border-edge px-3.5 py-2 text-xs font-semibold text-text2 hover:border-edge2 hover:text-text"
          >
            {t("settings.account.viewProfile")} ↗
          </button>
          <button
            onClick={() => void account.logout()}
            className="border border-red/30 px-3.5 py-2 text-xs font-semibold text-red hover:bg-red/10"
          >
            {t("settings.account.logout")}
          </button>
        </div>
      </div>
    </>
  );
}

function UpdateStatusLine({ state }: { state: UpdateState }) {
  const { t } = useTranslation();
  switch (state.status) {
    case "idle":
      return null;
    case "checking":
      return (
        <div className="mt-[6px] flex items-center gap-[6px] font-mono text-[11px] text-text2">
          <div className="h-1 w-1 animate-pxpulse bg-text3" />
          {t("settings.about.checking")}
        </div>
      );
    case "none":
      return <div className="mt-[6px] font-mono text-[11px] text-text3">{t("settings.about.upToDate")}</div>;
    case "available":
      return (
        <div className="mt-[6px] flex items-center gap-[6px] font-mono text-[11px] text-amber">
          <div className="h-1 w-1 animate-pxpulse bg-amber" />
          {t("settings.about.available", { version: state.version })}
        </div>
      );
    case "downloading":
      return (
        <div className="mt-[6px] flex items-center gap-[6px] font-mono text-[11px] text-amber">
          <div className="h-1 w-1 animate-pxpulse bg-amber" />
          {t("settings.about.downloading", { version: state.version, percent: Math.round(state.percent) })}
        </div>
      );
    case "ready":
      return (
        <div className="mt-[6px] flex items-center gap-[6px] font-mono text-[11px] text-accent">
          <div className="h-1 w-1 bg-accent" />
          {t("settings.about.ready", { version: state.version })}
        </div>
      );
    case "error":
      return (
        <div className="mt-[6px] font-mono text-[11px] text-red">
          {t("settings.about.updateError", { message: state.message })}
        </div>
      );
  }
}

function AboutTab({
  updateState,
  onCheck,
}: {
  updateState: UpdateState;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const busy = updateState.status === "checking" || updateState.status === "downloading";

  return (
    <>
      <TabHeader
        label={t("settings.tabs.about")}
        title={t("settings.about.title")}
        desc={t("settings.about.desc")}
      />
      <div className="flex flex-col gap-[2px]">
        <div className="flex items-center border border-line2 bg-raised px-4 py-3">
          <div className="min-w-0 flex-1 pr-4">
            <div className="text-[13px] font-semibold text-text">{t("settings.about.appName")}</div>
            <div className="mt-[2px] font-mono text-[11px] text-text3">
              {t("settings.about.versionLine", {
                app: moru.versions.app,
                electron: moru.versions.electron,
              })}
            </div>
            <UpdateStatusLine state={updateState} />
          </div>
          {updateState.status === "ready" ? (
            <button
              className="shrink-0 bg-accent px-3 py-2 text-[11px] font-bold text-sel-ink hover:bg-accent-hi"
              onClick={() => moru.updates.install()}
            >
              {t("settings.about.installRestart")}
            </button>
          ) : (
            <button
              className="shrink-0 border border-accent bg-transparent px-3 py-2 text-[11px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={onCheck}
            >
              {t("settings.about.checkUpdate")}
            </button>
          )}
        </div>

        <SettingRow title={t("settings.about.licenses")} desc={t("settings.about.licensesDesc")}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-text3">{t("settings.about.preparing")}</span>
            <button
              disabled
              className="cursor-not-allowed border border-edge bg-transparent px-3 py-2 text-[11px] font-semibold text-text2 opacity-40"
            >
              {t("settings.about.view")}
            </button>
          </div>
        </SettingRow>
      </div>
    </>
  );
}

export function SettingsScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>("models");
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "idle" });

  useEffect(() => {
    let mounted = true;
    void moru.updates.getState().then((state) => {
      if (mounted) setUpdateState(state);
    });
    const off = moru.updates.onState(setUpdateState);
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const checkUpdates = () => {
    setUpdateState({ status: "checking" });
    void moru.updates.check();
  };

  const updateVersion =
    updateState.status === "available" || updateState.status === "downloading" || updateState.status === "ready"
      ? updateState.version
      : null;

  return (
    <div className="flex h-full animate-fade-in-up">
      {/* Settings sidebar */}
      <aside className="w-[220px] shrink-0 border-r border-line bg-panel px-4 py-6">
        <div className="mb-4 pl-2 font-mono text-xs font-semibold tracking-[0.08em] text-text3 uppercase">
          <span className="text-accent">▍</span> {t("settings.sidebar.title")}
        </div>
        <div className="flex flex-col gap-[2px]">
          {TAB_IDS.map((id) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={
                  active
                    ? "relative flex items-center gap-[10px] bg-hover px-3 py-[9px] text-left text-xs font-semibold text-text"
                    : "flex items-center gap-[10px] px-3 py-[9px] text-left text-xs font-medium text-text2 hover:bg-hover hover:text-text"
                }
              >
                {active && <div className="absolute top-[6px] bottom-[6px] left-0 w-[3px] bg-accent" />}
                <TabIcon tab={id} active={active} />
                {t(`settings.tabs.${id}`)}
              </button>
            );
          })}
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <div className="mb-1 font-mono text-[10px] text-text3">{t("settings.sidebar.appVersion")}</div>
          <div className="font-mono text-xs font-bold text-text">v{moru.versions.app}</div>
          {updateVersion !== null && (
            <div className="mt-[6px] flex items-center gap-1 font-mono text-[10px] text-amber">
              <div className="h-1 w-1 animate-pxpulse bg-amber" />
              {t("settings.sidebar.updateAvailable", { version: updateVersion })}
            </div>
          )}
        </div>
      </aside>

      {/* Settings content */}
      <div className="max-w-[900px] flex-1 overflow-y-auto px-10 py-8">
        {tab === "models" && <ModelsTab />}
        {tab === "general" && <GeneralTab />}
        {tab === "account" && <AccountTab />}
        {tab === "about" && <AboutTab updateState={updateState} onCheck={checkUpdates} />}
      </div>
    </div>
  );
}
