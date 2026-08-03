/**
 * W3 - translation settings. Provider band on top (pick who translates),
 * then the provider's 3 quality tiers, advanced knobs, glossary/TM
 * toggles, and a single footer estimate line (tokens + est. cost).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelSelect } from "@/components/ModelSelect";
import { api } from "@/lib/api";
import { moru } from "@/lib/bridge";
import { formatCompact, formatInt, formatUsd } from "@/lib/format";
import {
  CLI_PROVIDERS,
  LOCAL_PROVIDERS,
  PRESET_IDS,
  PROVIDER_ORDER,
  PROVIDER_TIERS,
  RECOMMENDED_MODEL,
  RECOMMENDED_PROVIDER,
  estimateUsage,
  modelDisplayName,
  healedModel,
  providerIdOf,
} from "@/lib/models";
import { resolveProviderSecret } from "@/lib/providerSecrets";
import { costUsd, estimatePriceForModel, usePricingTable } from "@/lib/pricing";
import { useRouter } from "@/stores/router";
import { useSettings } from "@/stores/settings";
import { selectedScanTotals, useWizard } from "@/stores/wizard";

/* ---- static maps ---- */

const TARGET_LANGS: { code: string; flag: React.CSSProperties }[] = [
  {
    code: "ko_kr",
    flag: {
      background:
        "linear-gradient(180deg, #FFF 0%, #FFF 33%, #003478 33%, #003478 66%, #CD2E3A 66%, #CD2E3A 100%)",
    },
  },
  {
    code: "ja_jp",
    flag: { background: "radial-gradient(circle at 50% 50%, #BC002D 0, #BC002D 3px, #FFF 3.5px)" },
  },
  {
    code: "zh_cn",
    flag: {
      background: "linear-gradient(135deg, #FFDE00 0%, #FFDE00 18%, #DE2910 18%, #DE2910 100%)",
    },
  },
  {
    code: "zh_tw",
    flag: {
      background: "linear-gradient(135deg, #000095 0%, #000095 40%, #FE0000 40%, #FE0000 100%)",
    },
  },
];

const SOURCE_FLAG: React.CSSProperties = {
  background: "linear-gradient(180deg, #B22234 0%, #B22234 8%, #FFF 8%, #FFF 16%)",
};

/** Display-name fallback until the engine's provider list arrives. */
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  xai: "xAI",
  openrouter: "OpenRouter",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  ollama: "Ollama",
  "openai-compatible": "OpenAI Compatible",
};

const ADVANCED_DEFAULTS = { temperature: 0.3, batchSize: 30, maxConcurrent: 15, maxRefine: 2 };
const DEFAULT_GLOSSARY_MAX_TERMS = 3000;

function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}...`;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

/* ---- screen-local pieces ---- */

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#0A100D" strokeWidth="2">
      <path d="M1 5 L4 8 L9 2" />
    </svg>
  );
}

function KeyIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.5">
      <path d="M4 5 A2 2 0 0 1 8 5 A2 2 0 0 1 4 5 Z" />
      <path d="M6 7 V12 M4 10 H6" />
    </svg>
  );
}

function OptionCheck({
  checked,
  disabled = false,
  onToggle,
  title,
  sub,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle?: () => void;
  title: string;
  sub: string;
}) {
  return (
    <div
      className={`flex items-start gap-[10px] border border-line2 bg-raised p-3 ${
        disabled ? "cursor-not-allowed opacity-60" : onToggle !== undefined ? "cursor-pointer" : ""
      }`}
      onClick={disabled ? undefined : onToggle}
    >
      {checked ? (
        <div className="mt-px flex h-4 w-4 shrink-0 items-center justify-center bg-accent">
          <CheckMark />
        </div>
      ) : (
        <div className="mt-px h-4 w-4 shrink-0 border border-edge bg-bar" />
      )}
      <div>
        <div className={`mb-[2px] text-[12px] font-bold ${disabled ? "text-text2" : "text-text"}`}>
          {title}
        </div>
        <div className="font-mono text-[11px] text-text3">{sub}</div>
      </div>
    </div>
  );
}

/* ---- screen ---- */

export function W3Settings() {
  const { t } = useTranslation();
  const go = useRouter((s) => s.go);
  const wizard = useWizard();
  const settings = useSettings();
  const queryClient = useQueryClient();

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [compatKeyInput, setCompatKeyInput] = useState("");

  /* migration guard: persisted state may predate the `provider` field */
  const providerId = PROVIDER_ORDER.includes(settings.provider)
    ? settings.provider
    : providerIdOf(settings.model);
  const isOllama = providerId === "ollama";
  const isCompat = providerId === "openai-compatible";
  const isLocal = LOCAL_PROVIDERS.has(providerId);
  const tiers = PROVIDER_TIERS[providerId];

  const totals = selectedScanTotals(wizard);
  const usage = estimateUsage({
    chars: totals.chars,
    entries: totals.entries,
    batchSize: settings.batchSize,
    maxRefine: settings.maxRefine,
    glossary: settings.useVanillaGlossary || settings.useTm,
    extractGlossary: settings.extractGlossary,
    glossaryMaxTerms: settings.glossaryMaxTerms,
    thinking: settings.thinkingEnabled,
  });
  const pricingTable = usePricingTable();

  const providersQuery = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const secretQuery = useQuery({
    queryKey: ["secret", providerId],
    queryFn: () => moru.secrets.get(`apikey:${providerId}`),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const glossaryQuery = useQuery({
    queryKey: ["glossary", wizard.sourceLocale, wizard.targetLocale],
    queryFn: () => api.glossary(wizard.sourceLocale, wizard.targetLocale),
  });
  const tmQuery = useQuery({ queryKey: ["tmStats"], queryFn: api.tmStats });

  /* connection dots for the provider band */
  const providerIds = useMemo(
    () => (providersQuery.data ?? []).map((p) => p.id),
    [providersQuery.data],
  );
  const secretsQuery = useQuery({
    queryKey: ["secrets", providerIds],
    enabled: providerIds.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          providerIds.map(async (id) => [id, await moru.secrets.get(`apikey:${id}`)] as const),
        ),
      ) as Record<string, string | null>,
  });
  const ollamaModelsQuery = useQuery({
    queryKey: ["provider-models", "ollama", "nokey", settings.ollamaBaseUrl],
    queryFn: () => api.providerModels("ollama", undefined, settings.ollamaBaseUrl),
  });
  const compatKey = secretsQuery.data?.["openai-compatible"] ?? null;
  const compatModelsQuery = useQuery({
    queryKey: [
      "provider-models",
      "openai-compatible",
      compatKey !== null ? "key" : "nokey",
      settings.openaiCompatBaseUrl,
    ],
    queryFn: () =>
      api.providerModels(
        "openai-compatible",
        compatKey ?? undefined,
        settings.openaiCompatBaseUrl,
      ),
  });

  const ollamaModels =
    ollamaModelsQuery.data?.source === "live" ? ollamaModelsQuery.data.models : [];
  const compatModels =
    compatModelsQuery.data?.source === "live" ? compatModelsQuery.data.models : [];
  /* the selected local provider's query/list, for the model grid */
  const localModelsQuery = isCompat ? compatModelsQuery : ollamaModelsQuery;
  const localModels = isCompat ? compatModels : ollamaModels;
  const connected = useMemo(() => {
    const set = new Set<string>();
    for (const p of providersQuery.data ?? []) {
      if (LOCAL_PROVIDERS.has(p.id)) continue;
      if (p.has_key || (secretsQuery.data?.[p.id] ?? null) !== null) set.add(p.id);
    }
    if (ollamaModels.length > 0) set.add("ollama");
    if (compatModels.length > 0) set.add("openai-compatible");
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersQuery.data, secretsQuery.data, ollamaModelsQuery.data, compatModelsQuery.data]);

  const provider = providersQuery.data?.find((p) => p.id === providerId);
  const providerName = provider?.name ?? PROVIDER_LABELS[providerId] ?? providerId;
  const selectedSecret = resolveProviderSecret(
    providerId,
    secretQuery.data,
    secretsQuery.data,
  );
  const hasLocalKey = selectedSecret !== null;
  const keyLoading =
    !isLocal &&
    !hasLocalKey &&
    (secretQuery.isPending || secretQuery.isFetching || secretsQuery.isFetching);
  const hasKey = hasLocalKey || provider?.has_key === true;
  const modelMatches = providerIdOf(settings.model) === providerId;
  const canStart = isLocal ? modelMatches : hasKey && modelMatches;

  /* self-heal: keep the persisted model consistent with the provider and,
     for tier presets, with the tier's current recommendation (catalog
     refreshes retire old models; see healedModel). */
  useEffect(() => {
    if (isLocal) return;
    const healed = healedModel(settings, providerId, tiers);
    if (healed !== null) settings.set({ model: healed });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, providerId, tiers, settings.preset, settings.model]);

  /* live model list for the advanced select (static catalog as fallback) */
  const localBaseUrl = isOllama
    ? settings.ollamaBaseUrl
    : isCompat
      ? settings.openaiCompatBaseUrl
      : undefined;
  const liveModelsQuery = useQuery({
    queryKey: [
      "provider-models",
      providerId,
      hasLocalKey ? "key" : "nokey",
      localBaseUrl ?? "",
    ],
    enabled: advancedOpen,
    queryFn: () =>
      api.providerModels(
        providerId,
        hasLocalKey ? (selectedSecret ?? undefined) : undefined,
        localBaseUrl,
      ),
  });
  const modelOptions =
    liveModelsQuery.data !== undefined && liveModelsQuery.data.models.length > 0
      ? liveModelsQuery.data.models
      : (provider?.models ?? []);

  const keyTest = useMutation({
    mutationFn: async (key: string) => {
      const result = await api.testProvider(
        providerId,
        key,
        modelMatches ? settings.model : undefined,
      );
      if (!result.ok) throw new Error(result.error ?? t("w3.advanced.loadError"));
      await moru.secrets.set(`apikey:${providerId}`, key);
    },
    onSuccess: async () => {
      setEditingKey(false);
      setKeyInput("");
      await queryClient.invalidateQueries({ queryKey: ["secret", providerId] });
      await queryClient.invalidateQueries({ queryKey: ["secrets"] });
      await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
    },
  });
  const resetKeyTest = keyTest.reset;

  useEffect(() => {
    setEditingKey(false);
    setKeyInput("");
    resetKeyTest();
  }, [providerId, resetKeyTest]);

  /* OpenAI-compatible servers can require a key (vLLM --api-key, remote
     gateways); saving here mirrors the settings-screen CompatCard. */
  const invalidateCompatKeyCaches = async () => {
    await queryClient.invalidateQueries({ queryKey: ["secret", "openai-compatible"] });
    await queryClient.invalidateQueries({ queryKey: ["secrets"] });
    await queryClient.invalidateQueries({ queryKey: ["provider-models"] });
  };
  const saveCompatKey = async () => {
    const key = compatKeyInput.trim();
    if (key.length === 0) return;
    await moru.secrets.set("apikey:openai-compatible", key);
    setCompatKeyInput("");
    await invalidateCompatKeyCaches();
  };
  const removeCompatKey = async () => {
    await moru.secrets.delete("apikey:openai-compatible");
    await invalidateCompatKeyCaches();
  };

  const changedCount =
    (Object.keys(ADVANCED_DEFAULTS) as (keyof typeof ADVANCED_DEFAULTS)[]).filter(
      (k) => settings[k] !== ADVANCED_DEFAULTS[k],
    ).length +
    (settings.glossaryMaxTerms !== DEFAULT_GLOSSARY_MAX_TERMS ? 1 : 0) +
    (settings.thinkingEnabled ? 1 : 0) +
    (settings.preset === "custom" ? 1 : 0);

  const presetName =
    settings.preset === "custom" ? t("w3.footer.custom") : t(`common.preset.${settings.preset}`);
  const price = estimatePriceForModel(pricingTable, settings.model);
  const footerCost =
    price === null
      ? null
      : price.source === "free"
        ? t("w3.footer.free")
        : totals.chars > 0
          ? `${formatUsd(costUsd(usage, price))} ${t("w3.footer.estimated")}`
          : null;
  const recommendedPrice = estimatePriceForModel(pricingTable, RECOMMENDED_MODEL);
  const recommendedCostText =
    recommendedPrice !== null && totals.chars > 0
      ? formatUsd(costUsd(usage, recommendedPrice))
      : null;

  const numberField = (
    key: keyof typeof ADVANCED_DEFAULTS,
    label: string,
    step: number,
    min: number,
  ) => (
    <label className="block">
      <span className="mb-[6px] block font-mono text-[11px] text-text3">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={settings[key]}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (!Number.isNaN(n)) settings.set({ [key]: n });
        }}
        className="w-full border border-edge bg-ink px-[10px] py-[7px] font-mono text-[12px] text-text"
      />
    </label>
  );

  return (
    <div className="max-w-[1100px] animate-fade-in-up px-10 py-8">
      {/* Step header */}
      <div className="mb-2 flex items-center gap-[10px] font-mono text-[11px] font-semibold tracking-[0.08em] text-text3 uppercase">
        <span className="text-accent">03</span>
        <span>{t("w3.stepLabel")}</span>
        <div
          className="h-px flex-1"
          style={{
            backgroundImage: "linear-gradient(90deg, #24322B 50%, transparent 50%)",
            backgroundSize: "6px 1px",
          }}
        />
      </div>
      <h1 className="m-0 mb-[6px] text-[26px] font-bold tracking-[-0.02em] text-text">
        {t("w3.title")}
      </h1>
      <p className="m-0 mb-7 text-[13px] text-text2">
        {t("w3.subtitleBefore")}
        <b className="text-accent">{t("w3.subtitleAccent")}</b>
        {t("w3.subtitleAfter")}
      </p>

      {/* Language row */}
      <div className="mb-5 flex items-center gap-4 border border-line2 bg-raised p-4">
        <div className="text-[12px] font-semibold text-text3">{t("w3.lang.targetLabel")}</div>
        <div className="flex gap-[6px]">
          {TARGET_LANGS.map(({ code, flag }) => {
            const selected = wizard.targetLocale === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => wizard.setTargetLocale(code)}
                className={
                  selected
                    ? "flex cursor-pointer items-center gap-2 border border-accent px-3 py-[6px] text-[12px] font-semibold text-text"
                    : "flex cursor-pointer items-center gap-2 border border-edge bg-transparent px-3 py-[6px] text-[12px] text-text2 hover:border-edge2 hover:text-text"
                }
                style={selected ? { background: "rgba(61,220,132,0.08)" } : undefined}
              >
                <div className="h-3 w-[18px]" style={flag} />
                {t(`w3.lang.${code}`)}
                <span className="font-mono text-[10px] text-text3">{code}</span>
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[12px] text-text2">
          <span className="font-mono text-[11px] text-text3">{t("w3.lang.sourceLabel")}</span>
          <div className="flex items-center gap-[6px] border border-edge bg-card px-[10px] py-1">
            <div className="h-3 w-[18px]" style={SOURCE_FLAG} />
            <span className="font-mono text-[11px] text-text">{wizard.sourceLocale}</span>
          </div>
        </div>
      </div>

      {/* Provider band */}
      <div className="mb-5 border border-line2 bg-raised p-4">
        <div className="mb-3 text-[12px] font-semibold text-text3">{t("w3.provider.label")}</div>
        <div className="grid grid-cols-4 gap-[6px]">
          {PROVIDER_ORDER.map((id) => {
            const active = id === providerId;
            const isConnected = connected.has(id);
            const name =
              providersQuery.data?.find((p) => p.id === id)?.name ?? PROVIDER_LABELS[id] ?? id;
            const status = isConnected
              ? t("w3.provider.connected")
              : CLI_PROVIDERS[id] === true
                ? t("w3.provider.needsCliLogin")
                : LOCAL_PROVIDERS.has(id)
                  ? t("w3.provider.unreachable")
                  : t("w3.provider.needsKey");
            return (
              <button
                key={id}
                type="button"
                onClick={() => settings.set({ provider: id })}
                className={
                  active
                    ? "cursor-pointer border border-accent px-3 py-[8px] text-left"
                    : "cursor-pointer border border-edge bg-transparent px-3 py-[8px] text-left hover:border-edge2"
                }
                style={active ? { background: "rgba(61,220,132,0.08)" } : undefined}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-[6px] w-[6px] shrink-0 ${isConnected ? "bg-accent" : "bg-text4"}`}
                  />
                  <span
                    className={`truncate text-[12px] font-bold ${active ? "text-text" : "text-text2"}`}
                  >
                    {name}
                  </span>
                </div>
                <div
                  className={`mt-[2px] font-mono text-[10px] ${isConnected ? "text-accent" : "text-text4"}`}
                >
                  {status}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Recommended combo — hidden once it is the active selection */}
      {settings.model !== RECOMMENDED_MODEL && (
        <div className="mb-5 flex items-center gap-3 border border-accent-lo bg-tint px-[18px] py-3">
          <span className="bg-accent px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.06em] text-sel-ink uppercase">
            {t("w3.recommend.badge")}
          </span>
          <div className="flex-1">
            <div className="mb-[2px] text-[13px] font-bold text-text">
              {t("w3.recommend.title")}
            </div>
            <div className="font-mono text-[11px] text-text2">
              {recommendedCostText !== null
                ? t("w3.recommend.sub", { cost: recommendedCostText })
                : t("w3.recommend.subNoScan")}
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              settings.set({
                provider: RECOMMENDED_PROVIDER,
                preset: "fast",
                model: RECOMMENDED_MODEL,
              })
            }
            className="cursor-pointer border border-accent bg-transparent px-[14px] py-[7px] text-[12px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)]"
          >
            {t("w3.recommend.apply")}
          </button>
        </div>
      )}

      {/* Key / connection state for the selected provider */}
      {isOllama || isCompat ? (
        <div className="mb-5 flex items-center gap-[14px] border border-purple bg-hover px-[18px] py-4">
          <div
            className="flex h-8 w-8 items-center justify-center"
            style={{ background: "rgba(167,139,250,0.12)" }}
          >
            <KeyIcon color="#A78BFA" />
          </div>
          <div className="flex-1">
            <div className="mb-[2px] text-[13px] font-bold text-text">
              {t(isCompat ? "w3.key.compatTitle" : "w3.key.ollamaTitle")}
            </div>
            <div className="font-mono text-[11px] text-text2">
              {t(isCompat ? "w3.key.compatSub" : "w3.key.ollamaSub")}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-text3">{t("w3.key.baseUrl")}</span>
              <input
                type="text"
                value={isCompat ? settings.openaiCompatBaseUrl : settings.ollamaBaseUrl}
                placeholder={isCompat ? "http://localhost:1234/v1" : "http://localhost:11434"}
                onChange={(e) =>
                  settings.set(
                    isCompat
                      ? { openaiCompatBaseUrl: e.target.value }
                      : { ollamaBaseUrl: e.target.value },
                  )
                }
                className="w-[220px] border border-edge bg-ink px-[10px] py-[6px] font-mono text-[11px] text-text"
              />
            </label>
            {isCompat && (
              <label className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-text3">{t("w3.key.apiKey")}</span>
                {compatKey !== null ? (
                  <div className="flex w-[220px] items-center gap-[6px]">
                    <span className="min-w-0 flex-1 truncate border border-edge bg-ink px-[10px] py-[6px] font-mono text-[11px] text-text">
                      {maskKey(compatKey)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeCompatKey()}
                      className="shrink-0 cursor-pointer border border-edge bg-transparent px-2 py-[6px] text-[11px] font-semibold text-text2 hover:border-red hover:text-red"
                    >
                      {t("common.action.delete")}
                    </button>
                  </div>
                ) : (
                  <div className="flex w-[220px] items-center gap-[6px]">
                    <input
                      type="password"
                      value={compatKeyInput}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("settings.models.compatKeyPlaceholder")}
                      onChange={(e) => setCompatKeyInput(e.target.value)}
                      className="min-w-0 flex-1 border border-edge bg-ink px-[10px] py-[6px] font-mono text-[11px] text-text placeholder:text-text4"
                    />
                    <button
                      type="button"
                      disabled={compatKeyInput.trim().length === 0}
                      onClick={() => void saveCompatKey()}
                      className="shrink-0 cursor-pointer border border-edge bg-transparent px-2 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t("common.action.save")}
                    </button>
                  </div>
                )}
              </label>
            )}
          </div>
        </div>
      ) : keyLoading ? (
        <div className="mb-5 animate-pxpulse border border-line2 bg-raised px-[18px] py-4 font-mono text-[11px] text-text3">
          {t("w3.key.checking")}
        </div>
      ) : hasKey && !editingKey ? (
        <div className="relative mb-5 flex items-center gap-[14px] border border-accent-lo bg-tint px-[18px] py-4">
          <div
            className="flex h-8 w-8 items-center justify-center"
            style={{ background: "rgba(61,220,132,0.12)" }}
          >
            <KeyIcon color="#3DDC84" />
          </div>
          <div className="flex-1">
            <div className="mb-[2px] text-[13px] font-bold text-text">
              {t("w3.key.confirmed", { provider: providerName })}
            </div>
            <div className="font-mono text-[11px] text-text2">
              {hasLocalKey && selectedSecret !== null
                ? `${maskKey(selectedSecret)} · ${t("w3.key.savedLocal")}`
                : t("w3.key.engineManaged")}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditingKey(true)}
            className="cursor-pointer border border-edge bg-transparent px-3 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text"
          >
            {t("w3.key.change")}
          </button>
        </div>
      ) : (
        <div
          className="relative mb-5 flex items-center gap-[14px] border border-amber px-[18px] py-4"
          style={{ background: "rgba(245,180,84,0.04)" }}
        >
          <div
            className="flex h-8 w-8 items-center justify-center"
            style={{ background: "rgba(245,180,84,0.12)" }}
          >
            <KeyIcon color="#F5B454" />
          </div>
          <div className="flex-1">
            <div className="mb-[2px] text-[13px] font-bold text-text">
              {t("w3.key.needed", { provider: providerName })}
            </div>
            <div className="font-mono text-[11px] text-text3">{t("w3.key.hint")}</div>
            {keyTest.isError && (
              <div className="mt-1 font-mono text-[11px] text-red">{keyTest.error.message}</div>
            )}
          </div>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={t("w3.key.placeholder")}
            className="w-[240px] border border-edge bg-ink px-[10px] py-[7px] font-mono text-[11px] text-text placeholder:text-text4"
          />
          <button
            type="button"
            disabled={keyTest.isPending || keyInput.trim().length === 0}
            onClick={() => keyTest.mutate(keyInput.trim())}
            className="cursor-pointer border border-accent bg-transparent px-[14px] py-[7px] text-[12px] font-semibold text-accent hover:bg-[rgba(61,220,132,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {keyTest.isPending ? t("w3.key.testing") : t("w3.key.test")}
          </button>
          {editingKey && (
            <button
              type="button"
              onClick={() => {
                setEditingKey(false);
                setKeyInput("");
                keyTest.reset();
              }}
              className="cursor-pointer bg-transparent text-[11px] text-text3 hover:text-text"
            >
              {t("common.action.cancel")}
            </button>
          )}
        </div>
      )}

      {/* Quality tiers / local models */}
      {isLocal ? (
        <div className="mb-6 border border-line2 bg-raised">
          <div className="flex items-center gap-2 border-b border-line2 px-[18px] py-3">
            <span className="text-[13px] font-bold text-text">
              {t(isCompat ? "w3.provider.compatModelsTitle" : "w3.provider.ollamaModelsTitle")}
            </span>
            <span className="font-mono text-[10px] text-text3">{localBaseUrl}</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => void localModelsQuery.refetch()}
              disabled={localModelsQuery.isFetching}
              className="flex cursor-pointer items-center gap-1 text-[10px] text-text3 hover:text-text disabled:cursor-default"
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className={localModelsQuery.isFetching ? "animate-pxspin" : undefined}
              >
                <path d="M8.5 5 A3.5 3.5 0 1 1 5 1.5 M5 1.5 H8 M5 1.5 V4.5" />
              </svg>
              {t("w3.advanced.refresh")}
            </button>
          </div>
          {localModelsQuery.isPending ? (
            <div className="animate-pxpulse px-[18px] py-4 font-mono text-[11px] text-text3">
              {t("w3.provider.ollamaModelsLoading")}
            </div>
          ) : localModels.length === 0 ? (
            <div className="px-[18px] py-4 font-mono text-[11px] text-text3">
              {t(isCompat ? "w3.provider.compatEmpty" : "w3.provider.ollamaEmpty")}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-[6px] p-3">
              {localModels.map((m) => {
                const selected = settings.model === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => settings.set({ model: m, preset: "custom" })}
                    className={
                      selected
                        ? "cursor-pointer border border-purple px-3 py-[8px] text-left"
                        : "cursor-pointer border border-edge bg-transparent px-3 py-[8px] text-left hover:border-edge2"
                    }
                    style={selected ? { background: "rgba(167,139,250,0.08)" } : undefined}
                  >
                    <div
                      className={`truncate text-[12px] font-bold ${selected ? "text-text" : "text-text2"}`}
                    >
                      {modelDisplayName(m)}
                    </div>
                    <div className="mt-[2px] truncate font-mono text-[10px] text-text3">{m}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : tiers !== undefined ? (
        <div className="mb-6 grid grid-cols-3 gap-3">
          {PRESET_IDS.map((tier, index) => {
            const model = tiers[tier];
            const selected = settings.preset === tier;
            return (
              <div
                key={tier}
                onClick={() => settings.set({ preset: tier, model })}
                className={
                  selected
                    ? "relative cursor-pointer overflow-hidden p-5"
                    : "relative cursor-pointer border border-line2 bg-raised p-5 hover:border-edge2"
                }
                style={
                  selected
                    ? {
                        background: "linear-gradient(135deg, #14201A 0%, #141C18 100%)",
                        border: "2px solid #3DDC84",
                        boxShadow: "0 0 24px rgba(61,220,132,0.12)",
                      }
                    : undefined
                }
              >
                {(providerId === RECOMMENDED_PROVIDER
                  ? model === RECOMMENDED_MODEL
                  : tier === "balanced") && (
                  <div className="absolute top-0 right-0 bg-accent px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.06em] text-sel-ink uppercase">
                    {t("w3.preset.recommended")}
                  </div>
                )}
                {selected && (
                  <div
                    className="absolute h-20 w-20 opacity-10"
                    style={{
                      bottom: "-20px",
                      right: "-20px",
                      backgroundImage:
                        "radial-gradient(circle at 2px 2px, #3DDC84 1px, transparent 1px)",
                      backgroundSize: "6px 6px",
                    }}
                  />
                )}
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex gap-[2px]">
                    {[0, 1, 2].map((bar) => (
                      <div
                        key={bar}
                        className={`h-3 w-1 ${bar <= index ? "bg-accent" : "bg-edge"}`}
                      />
                    ))}
                  </div>
                  <div className="text-[15px] font-bold tracking-[-0.01em] text-text">
                    {t(`common.preset.${tier}`)}
                  </div>
                </div>
                <div className="mb-4 h-[42px] text-[12px] leading-[1.5] text-text2">
                  {t(`w3.preset.${tier}Desc`)}
                </div>
                <div className="flex justify-between font-mono text-[11px]">
                  <span className="text-text3">{t("w3.preset.model")}</span>
                  <span className={selected ? "font-bold text-accent" : "text-text"}>
                    {modelDisplayName(model)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Advanced */}
      <div className="mb-6 border border-line2 bg-raised">
        <div
          className="flex cursor-pointer items-center gap-[10px] px-[18px] py-[14px] hover:bg-raised-hover"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="#6A7C74"
            strokeWidth="1.5"
            style={{
              transform: advancedOpen ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          >
            <path d="M2 3 L5 6 L8 3" />
          </svg>
          <span className="text-[13px] font-bold text-text">{t("w3.advanced.title")}</span>
          <span className="font-mono text-[11px] text-text3">{t("w3.advanced.hint")}</span>
          <div className="flex-1" />
          {changedCount > 0 && (
            <span className="bg-bar px-[6px] py-[2px] font-mono text-[10px] text-text3">
              {t("w3.advanced.changed", { n: changedCount })}
            </span>
          )}
        </div>
        {advancedOpen && (
          <div className="flex flex-col gap-4 border-t border-line2 px-[18px] py-4">
            {providersQuery.isPending ? (
              <div className="animate-pxpulse font-mono text-[11px] text-text3">
                {t("w3.advanced.loading")}
              </div>
            ) : providersQuery.isError ? (
              <div className="flex items-center gap-3 font-mono text-[11px] text-red">
                {t("w3.advanced.loadError")}
                <button
                  type="button"
                  onClick={() => void providersQuery.refetch()}
                  className="cursor-pointer border border-edge px-2 py-1 text-[11px] text-text2 hover:border-edge2 hover:text-text"
                >
                  {t("common.action.retry")}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="block">
                  <span className="mb-[6px] flex items-center gap-2 font-mono text-[11px] text-text3">
                    <span id="w3-advanced-model-label">{t("w3.advanced.model")}</span>
                    <button
                      type="button"
                      onClick={() => void liveModelsQuery.refetch()}
                      disabled={liveModelsQuery.isFetching}
                      title={t("w3.advanced.refresh")}
                      className="ml-auto flex cursor-pointer items-center gap-1 text-[10px] text-text3 hover:text-text disabled:cursor-default"
                    >
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className={liveModelsQuery.isFetching ? "animate-pxspin" : undefined}
                      >
                        <path d="M8.5 5 A3.5 3.5 0 1 1 5 1.5 M5 1.5 H8 M5 1.5 V4.5" />
                      </svg>
                      {t("w3.advanced.refresh")}
                    </button>
                  </span>
                  <ModelSelect
                    value={settings.model}
                    options={modelOptions}
                    onSelect={(model) => settings.set({ model, preset: "custom" })}
                    labelId="w3-advanced-model-label"
                  />
                  <span className="mt-[6px] block font-mono text-[10px]">
                    {liveModelsQuery.isFetching ? (
                      <span className="animate-pxpulse text-text3">
                        {t("w3.advanced.modelsLoading")}
                      </span>
                    ) : liveModelsQuery.data?.source === "live" ? (
                      <span className="text-accent">
                        {t("w3.advanced.modelsLive", { n: modelOptions.length })}
                      </span>
                    ) : liveModelsQuery.data?.source === "static" ? (
                      <span className="text-amber">{t("w3.advanced.modelsStatic")}</span>
                    ) : null}
                  </span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-4 gap-3">
              {numberField("temperature", t("w3.advanced.temperature"), 0.1, 0)}
              {numberField("batchSize", t("w3.advanced.batchSize"), 1, 1)}
              {numberField("maxConcurrent", t("w3.advanced.maxConcurrent"), 1, 1)}
              {numberField("maxRefine", t("w3.advanced.maxRefine"), 1, 0)}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-2">
                <span className="mb-[6px] block font-mono text-[11px] text-text3">
                  {t("w3.advanced.glossaryMaxTerms")}
                </span>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step={1}
                    min={1}
                    value={settings.glossaryMaxTerms ?? ""}
                    placeholder="∞"
                    disabled={settings.glossaryMaxTerms === null}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber;
                      if (Number.isInteger(n) && n >= 1) {
                        settings.set({ glossaryMaxTerms: n });
                      }
                    }}
                    className="min-w-0 flex-1 border border-edge bg-ink px-[10px] py-[7px] font-mono text-[12px] text-text disabled:text-text3"
                  />
                  <button
                    type="button"
                    aria-pressed={settings.glossaryMaxTerms === null}
                    onClick={() =>
                      settings.set({
                        glossaryMaxTerms:
                          settings.glossaryMaxTerms === null
                            ? DEFAULT_GLOSSARY_MAX_TERMS
                            : null,
                      })
                    }
                    className={
                      settings.glossaryMaxTerms === null
                        ? "cursor-pointer border border-accent bg-accent/10 px-3 font-mono text-[11px] text-accent"
                        : "cursor-pointer border border-edge bg-ink px-3 font-mono text-[11px] text-text3 hover:border-edge2 hover:text-text"
                    }
                  >
                    {t("w3.advanced.unlimited")}
                  </button>
                </div>
              </div>
              <div className="col-span-2">
                <span className="mb-[6px] block font-mono text-[11px] text-text3">
                  {t("w3.advanced.thinking")}
                </span>
                <div className="flex gap-[6px]">
                  <button
                    type="button"
                    aria-pressed={settings.thinkingEnabled}
                    onClick={() => settings.set({ thinkingEnabled: !settings.thinkingEnabled })}
                    className={
                      settings.thinkingEnabled
                        ? "cursor-pointer border border-accent bg-accent/10 px-3 py-[7px] font-mono text-[11px] text-accent"
                        : "cursor-pointer border border-edge bg-ink px-3 py-[7px] font-mono text-[11px] text-text3 hover:border-edge2 hover:text-text"
                    }
                  >
                    {settings.thinkingEnabled
                      ? t("w3.advanced.thinkingOn")
                      : t("w3.advanced.thinkingOff")}
                  </button>
                  {(["low", "medium", "high"] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      disabled={!settings.thinkingEnabled}
                      onClick={() => settings.set({ thinkingEffort: level })}
                      className={
                        settings.thinkingEnabled && settings.thinkingEffort === level
                          ? "flex-1 cursor-pointer border border-accent bg-accent/10 px-2 py-[7px] font-mono text-[11px] text-accent"
                          : "flex-1 cursor-pointer border border-edge bg-ink px-2 py-[7px] font-mono text-[11px] text-text3 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                      }
                    >
                      {t(`w3.advanced.thinking_${level}`)}
                    </button>
                  ))}
                </div>
                <span className="mt-[6px] block font-mono text-[10px] text-text3">
                  {t("w3.advanced.thinkingHint")}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Options checkboxes */}
      <div className="mb-8 grid grid-cols-2 gap-[10px]">
        <OptionCheck
          checked={settings.useVanillaGlossary}
          onToggle={() =>
            settings.set({
              useVanillaGlossary: !settings.useVanillaGlossary,
              extractGlossary: !settings.useVanillaGlossary,
            })
          }
          title={t("w3.options.glossaryTitle")}
          sub={
            glossaryQuery.isPending
              ? t("w3.options.glossaryLoading")
              : glossaryQuery.isError
                ? t("w3.options.glossaryError")
                : t("w3.options.glossarySub", { n: formatInt(glossaryQuery.data.terms.length) })
          }
        />
        <OptionCheck
          checked={settings.useTm}
          onToggle={() => settings.set({ useTm: !settings.useTm })}
          title={t("w3.options.tmTitle")}
          sub={
            tmQuery.isPending
              ? t("w3.options.tmLoading")
              : tmQuery.isError
                ? t("w3.options.tmError")
                : t("w3.options.tmSub", { n: formatInt(tmQuery.data.entries) })
          }
        />
        <OptionCheck
          checked
          title={t("w3.options.placeholderTitle")}
          sub={t("w3.options.placeholderSub")}
        />
        <OptionCheck
          checked={false}
          disabled
          title={t("w3.options.shareTitle")}
          sub={t("w3.options.shareSub")}
        />
      </div>

      {/* Wizard footer */}
      <div className="flex items-center justify-between border-t border-line pt-5">
        <button
          type="button"
          onClick={() => go("w2")}
          className="flex cursor-pointer items-center gap-[6px] bg-transparent px-[18px] py-[10px] text-[13px] font-semibold text-text2 hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 2 L4 6 L8 10" />
          </svg>
          {t("common.action.back")}
        </button>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-text3">
            {presetName} · {modelDisplayName(settings.model)}
            {totals.chars > 0 && (
              <>
                {" · "}
                {t("w3.footer.tokens", { n: formatCompact(usage.totalTokens) })}
              </>
            )}
            {footerCost !== null && (
              <>
                {" · "}
                <span className="text-accent">{footerCost}</span>
              </>
            )}
          </span>
          <button
            type="button"
            disabled={!canStart}
            onClick={() => {
              void wizard.startTranslate();
              go("w4");
            }}
            className="flex cursor-pointer items-center gap-[6px] bg-accent px-5 py-[10px] text-[13px] font-bold text-sel-ink hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40"
            style={canStart ? { boxShadow: "0 0 24px rgba(61,220,132,0.25)" } : undefined}
          >
            {t("w3.footer.start")}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
