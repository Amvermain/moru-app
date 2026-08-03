/**
 * Provider/model catalog and token estimation.
 *
 * Static MODEL_PRICES is the OFFLINE FALLBACK only — live per-model pricing
 * (incl. cache-read rates) comes from OpenRouter via lib/pricing.ts.
 * Estimates are labeled "예상" in the UI; the constants below are calibrated
 * against real engine runs (DSPy JSONAdapter batches).
 */

import type { PresetId } from "../stores/settings";

export interface ModelPrice {
  /** USD per 1M prompt tokens */
  input: number;
  /** USD per 1M completion tokens */
  output: number;
  /** USD per 1M cached prompt tokens (provider cache read) */
  cacheRead?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "openai/gpt-5.6-sol": { input: 5.0, output: 30.0, cacheRead: 0.5 },
  "openai/gpt-5.6-terra": { input: 2.5, output: 15.0, cacheRead: 0.25 },
  "openai/gpt-5.6-luna": { input: 1.0, output: 6.0, cacheRead: 0.1 },
  "openai/gpt-4.1": { input: 2.0, output: 8.0, cacheRead: 0.5 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "anthropic/claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5 },
  "anthropic/claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "anthropic/claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1 },
  "gemini/gemini-3.1-pro-preview": { input: 2.0, output: 12.0, cacheRead: 0.2 },
  "gemini/gemini-3.5-flash": { input: 1.5, output: 9.0, cacheRead: 0.15 },
  "gemini/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
  "deepseek/deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
  // Listed on OpenRouter 2026-07 at $0.09/$0.18 (cache read $0.018);
  // deepseek-chat/-reasoner ids retire in favor of v4-flash/v4-pro on 7/24.
  "deepseek/deepseek-v4-flash": { input: 0.09, output: 0.18, cacheRead: 0.018 },
  "xai/grok-4": { input: 3.0, output: 15.0, cacheRead: 0.75 },
  "xai/grok-3": { input: 3.0, output: 15.0, cacheRead: 0.75 },
  "xai/grok-3-mini": { input: 0.3, output: 0.5, cacheRead: 0.075 },
  // Retired/legacy models: no longer offered, kept so History still
  // prices old sessions when the OpenRouter live table is unavailable.
  "openai/gpt-4o": { input: 2.5, output: 10.0, cacheRead: 1.25 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "openai/o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "anthropic/claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "anthropic/claude-opus-4-1": { input: 15.0, output: 75.0, cacheRead: 1.5 },
  "gemini/gemini-2.5-pro": { input: 1.25, output: 10.0, cacheRead: 0.31 },
  "gemini/gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini/gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025 },
};

/** Provider display order for the W3 provider selector. */
export const PROVIDER_ORDER: readonly string[] = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "xai",
  "openrouter",
  "claude-code",
  "codex",
  "gemini-cli",
  "ollama",
  "openai-compatible",
];

/**
 * Providers served from the user's machine: no API key requirement, a
 * base-URL setting, live model lists instead of preset tiers, and zero
 * per-token cost.
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "openai-compatible"]);

/**
 * Coding-CLI subscriptions (Claude Code, OpenAI Codex, Gemini CLI). The
 * engine rides the grant the user's own CLI already holds, so there is no
 * key to enter and no per-token bill to estimate — the plan is already
 * paid for. Unlike LOCAL_PROVIDERS they have a fixed lineup, so the normal
 * tier cards apply and there is no base URL to configure.
 */
export const CLI_PROVIDERS: Record<string, true> = {
  "claude-code": true,
  codex: true,
  "gemini-cli": true,
};

/**
 * True when a provider never takes an API key — served locally or backed
 * by a coding-CLI subscription. Two different reasons, one UI consequence,
 * so the union is worth a name.
 */
export function isKeylessProvider(providerId: string): boolean {
  return LOCAL_PROVIDERS.has(providerId) || CLI_PROVIDERS[providerId] === true;
}

/** LiteLLM model-string prefixes that differ from our provider ids. */
const PREFIX_TO_PROVIDER: Record<string, string> = {
  ollama_chat: "ollama",
  hosted_vllm: "openai-compatible",
};

/**
 * 제공자별 프리셋 3종 (빠른 / 균형 / 최고 품질). The user picks the provider
 * first (W3 top band); tier cards then offer that provider's models.
 * Providers with a thin lineup may repeat a model across tiers.
 * Ollama has no tiers — the UI shows the live local model list instead.
 */
export const PROVIDER_TIERS: Record<string, Record<PresetId, string>> = {
  openai: {
    fast: "openai/gpt-5.6-luna",
    balanced: "openai/gpt-5.6-terra",
    best: "openai/gpt-5.6-sol",
  },
  anthropic: {
    fast: "anthropic/claude-haiku-4-5",
    balanced: "anthropic/claude-sonnet-4-6",
    best: "anthropic/claude-opus-4-8",
  },
  gemini: {
    fast: "gemini/gemini-3.1-flash-lite",
    balanced: "gemini/gemini-3.5-flash",
    best: "gemini/gemini-3.1-pro-preview",
  },
  deepseek: {
    fast: "deepseek/deepseek-chat",
    balanced: "deepseek/deepseek-chat",
    best: "deepseek/deepseek-reasoner",
  },
  xai: {
    fast: "xai/grok-3-mini",
    balanced: "xai/grok-3",
    best: "xai/grok-4",
  },
  openrouter: {
    fast: "openrouter/deepseek/deepseek-v4-flash",
    balanced: "openrouter/anthropic/claude-haiku-4.5",
    best: "openrouter/anthropic/claude-sonnet-4.6",
  },
  "claude-code": {
    fast: "claude-code/claude-haiku-4-5",
    balanced: "claude-code/claude-sonnet-4-6",
    best: "claude-code/claude-opus-4-8",
  },
  codex: {
    fast: "codex/gpt-5.6-luna",
    balanced: "codex/gpt-5.6-terra",
    best: "codex/gpt-5.6-sol",
  },
  "gemini-cli": {
    fast: "gemini-cli/gemini-3.1-flash-lite",
    balanced: "gemini-cli/gemini-3.5-flash",
    best: "gemini-cli/gemini-3.1-pro-preview",
  },
};

export const PRESET_IDS: readonly PresetId[] = ["fast", "balanced", "best"];

/**
 * The combo moru actively recommends: OpenRouter (one key, every model,
 * live pricing) running DeepSeek V4 Flash — lowest list price in the
 * catalog and the deepest cache-read discount, which suits the repeated
 * instruction/glossary prompts of modpack translation.
 */
export const RECOMMENDED_PROVIDER = "openrouter";
export const RECOMMENDED_MODEL = "openrouter/deepseek/deepseek-v4-flash";

/** Provider id a LiteLLM model string belongs to ("ollama_chat/x" -> "ollama"). */
export function providerIdOf(model: string): string {
  const prefix = model.split("/")[0];
  return PREFIX_TO_PROVIDER[prefix] ?? prefix;
}

/**
 * Self-heal for persisted model settings. Returns the model to store, or
 * null when the stored selection is valid: the model must belong to the
 * selected provider, and a tier preset must track the tier's CURRENT
 * model - catalog refreshes retire old recommendations, and a stale
 * persisted model would keep running a dead model while the tier card
 * shows the new one as selected. A custom model of the right provider is
 * user intent and is never overridden.
 */
export function healedModel(
  settings: { preset: PresetId | "custom"; model: string },
  providerId: string,
  tiers: Record<PresetId, string> | undefined,
): string | null {
  if (tiers === undefined) return null;
  if (providerIdOf(settings.model) !== providerId) {
    return tiers[settings.preset === "custom" ? "balanced" : settings.preset];
  }
  if (settings.preset !== "custom" && settings.model !== tiers[settings.preset]) {
    return tiers[settings.preset];
  }
  return null;
}

/** Short display name: "anthropic/claude-haiku-4-5" -> "Claude Haiku 4.5". */
export function modelDisplayName(model: string): string {
  const bare = model.split("/").at(-1) ?? model;
  return bare
    .replace(/^gpt/, "GPT")
    .replace(/^claude/, "Claude")
    .replace(/^gemini/, "Gemini")
    .replace(/^deepseek/, "DeepSeek")
    .replace(/^grok/, "Grok")
    .replace(/^o4/, "o4")
    .replace(/^qwen/, "Qwen")
    .replace(/^llama/, "Llama")
    .replace(/^gemma/, "Gemma")
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/(\d) (\d)/g, "$1.$2");
}

/* -------------------------------------------------------------------- */
/* Token estimation                                                     */
/* -------------------------------------------------------------------- */

/**
 * Engine request shape (dspy JSONAdapter): every batch re-sends the
 * signature instructions + JSON schema + field scaffolding, plus a
 * glossary slice; entry keys are echoed in prompt AND completion.
 * Baseline constants calibrated against real engine runs.
 *
 * CONSERVATIVELY BIASED (empirical buffer, not a mathematical bound):
 * the estimate is sized to overshoot the real bill in practice — the
 * 2026-07 76k-entry run burned past the old baseline-only estimate.
 * The TRUE engine ceiling is deliberately not priced: translator.py
 * re-translates every still-failed entry per refine pass and issues
 * per-entry refine calls, and the orchestrator may re-send a glossary
 * chunk up to 1+glossary_max_retries FULL times — pricing that would
 * roughly triple the figure and make the estimate useless. The W4
 * screen additionally clamps the DISPLAYED estimate to the live
 * counters, so the shown number can never trail actual burn.
 * Buffered components, calibrated at/above the worst observed run:
 * - refine passes and parse-failure splits re-send translation traffic:
 *   priced per configured refine pass (settings maxRefine, engine
 *   orchestrator max_refine)             -> RETRY_TRAFFIC_SHARE
 * - glossary chunks retry on schema errors: priced per allowed retry
 *   (engine glossary_max_retries; observed retry rate ~5% of chunks)
 *                                        -> RETRY_TRAFFIC_SHARE
 * - verbose models bill completions above the source token volume
 *                                        -> COMPLETION_RATIO
 * - reasoning tokens are billed as completions when thinking is on
 *                                        -> THINKING_COMPLETION_MULTIPLIER
 * - everything unmodeled (long-entry re-batching, tokenizer variance)
 *                                        -> SAFETY_MARGIN on the total
 */
const TOKENS_PER_CHAR = 1 / 3.5;
const BATCH_OVERHEAD_TOKENS = 950;
const GLOSSARY_TOKENS_PER_BATCH = 250;
const KEY_TOKENS_PER_ENTRY = 7;
/** ko/ja/zh completions routinely tokenize above the source volume */
const COMPLETION_RATIO = 1.2;
/**
 * Traffic share assumed re-sent PER allowed retry pass — an empirical
 * rate (observed failure shares run well below it), NOT the all-fail
 * ceiling. Refine work scales with settings.maxRefine; glossary retries
 * with the engine's glossary_max_retries. maxRefine=0 prices zero
 * refine work.
 */
const RETRY_TRAFFIC_SHARE = 0.1;
/** orchestrator PipelineConfig.glossary_max_retries (not user-tunable) */
const ENGINE_GLOSSARY_MAX_RETRIES = 2;
/** reasoning output when thinking is enabled, billed as completion */
const THINKING_COMPLETION_MULTIPLIER = 2.0;
/**
 * Final empirical pad. Sized off the 2026-07 76k-entry calibration run:
 * models that reason BY DEFAULT (DeepSeek V4 Flash emits CoT without
 * the thinking toggle) burn ~6% past the component model at 1.25 — 1.4
 * keeps real headroom.
 */
const SAFETY_MARGIN = 1.4;
/** Glossary curation: 50 candidates per engine request. */
const GLOSSARY_CHUNK_SIZE = 50;
/** DSPy signature/schema plus existing-glossary context on every chunk. */
const GLOSSARY_PROMPT_OVERHEAD_TOKENS = 3000;
/** Candidate line and structured TermRule output token volumes. */
const GLOSSARY_PROMPT_TOKENS_PER_CANDIDATE = 30;
const GLOSSARY_COMPLETION_TOKENS_PER_CANDIDATE = 75;
/** engine-side batch splitting also caps chars per batch */
const MAX_BATCH_CHARS = 8000;

export interface UsageEstimateInput {
  /** source character volume (scan char_count of the selection) */
  chars: number;
  /** entry count of the selection */
  entries: number;
  /** settings.batchSize */
  batchSize: number;
  /** settings.maxRefine — allowed refine passes; scales retry pricing */
  maxRefine?: number;
  /** a glossary is sent with every batch (vanilla/community/user) */
  glossary: boolean;
  /** term extraction pass enabled */
  extractGlossary: boolean;
  /** maximum candidates curated by the glossary LLM; null means uncapped */
  glossaryMaxTerms: number | null;
  /** litellm reasoning enabled — reasoning tokens are billed as completions */
  thinking?: boolean;
}

export interface UsageEstimate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function estimateUsage(input: UsageEstimateInput): UsageEstimate {
  const { chars, entries } = input;
  if (chars <= 0 || entries <= 0) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const batchSize = Math.max(1, input.batchSize);
  // engine splits on entry count AND char volume, whichever is tighter
  const charsWithKeys = chars + entries * 24;
  const batches = Math.max(
    Math.ceil(entries / batchSize),
    Math.ceil(charsWithKeys / MAX_BATCH_CHARS),
  );

  const sourceTokens = chars * TOKENS_PER_CHAR;
  const keyTokens = entries * KEY_TOKENS_PER_ENTRY;

  const thinkingMult = input.thinking === true ? THINKING_COMPLETION_MULTIPLIER : 1;
  const refinePasses = Math.max(0, input.maxRefine ?? 2);
  const translationRetryFactor = 1 + RETRY_TRAFFIC_SHARE * refinePasses;
  const glossaryRetryFactor = 1 + RETRY_TRAFFIC_SHARE * ENGINE_GLOSSARY_MAX_RETRIES;

  let prompt =
    (batches * BATCH_OVERHEAD_TOKENS +
      (input.glossary ? batches * GLOSSARY_TOKENS_PER_BATCH : 0) +
      sourceTokens +
      keyTokens) *
    translationRetryFactor;
  let completion =
    (sourceTokens * COMPLETION_RATIO * thinkingMult + keyTokens) *
    translationRetryFactor;

  if (input.extractGlossary) {
    // Uncapped extraction: the miner keeps every ranked candidate, so
    // price the conservative upper bound of one candidate per entry.
    const configuredLimit =
      input.glossaryMaxTerms === null
        ? entries
        : Math.max(0, Math.floor(input.glossaryMaxTerms));
    const candidates = Math.min(entries, configuredLimit);
    const chunks = Math.ceil(candidates / GLOSSARY_CHUNK_SIZE);
    prompt +=
      (chunks * GLOSSARY_PROMPT_OVERHEAD_TOKENS +
        candidates * GLOSSARY_PROMPT_TOKENS_PER_CANDIDATE) *
      glossaryRetryFactor;
    completion +=
      candidates *
      GLOSSARY_COMPLETION_TOKENS_PER_CANDIDATE *
      thinkingMult *
      glossaryRetryFactor;
  }

  // Round UP: the buffer must not lose tokens to rounding.
  const promptTokens = Math.ceil(prompt * SAFETY_MARGIN);
  const completionTokens = Math.ceil(completion * SAFETY_MARGIN);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
