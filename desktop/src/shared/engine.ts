/**
 * Engine API contract types - mirror of contracts/engine-api.yaml.
 * Keep field names snake_case: these are wire types, not view models.
 */

export type JobType = "scan" | "translate" | "export" | "upload";

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  error: string | null;
  created_at: string;
}

export type EntryStatus = "passed" | "warning" | "failed" | "modified" | "tm_hit" | "skipped";

export interface Entry {
  key: string;
  file: string;
  source_text: string;
  translated_text: string;
  status: EntryStatus;
  errors: string[];
}

export interface EntryPage {
  total: number;
  page: number;
  entries: Entry[];
}

export interface ScanFile {
  path: string;
  entry_count: number;
  char_count: number;
  sample: Record<string, string>;
}

export interface ScanCategory {
  name: string;
  handler: string;
  file_count: number;
  entry_count: number;
  char_count: number;
  files: ScanFile[];
}

/** Pack identity resolved by the scanner from launcher metadata/manifests. */
export interface PackIdentity {
  name: string | null;
  version: string | null;
  mc_version: string | null;
  loader: string | null;
  curseforge_project_id: number | null;
  curseforge_file_id: number | null;
  modrinth_project_id: string | null;
  modrinth_version_id: string | null;
  source:
    | "curseforge_instance"
    | "curseforge_manifest"
    | "modrinth_pack"
    | "prism_managed"
    | "prism_instance"
    | "folder";
  confident: boolean;
}

export interface ScanResult {
  modpack_path: string;
  categories: ScanCategory[];
  /** null only when the engine could not run detection (defensive) */
  identity: PackIdentity | null;
}

export type GlossaryOrigin = "vanilla" | "extracted" | "manual" | "community";

export interface GlossaryTerm {
  source: string;
  target: string;
  origin: GlossaryOrigin;
}

export interface Glossary {
  source_lang: string;
  target_lang: string;
  terms: GlossaryTerm[];
}

export interface TmStats {
  entries: number;
  hits: number;
  last_sync_version: string | null;
  by_origin?: Record<string, number>;
}

/** POST /community/sync result: null side = nothing published on the web. */
export interface CommunitySyncResult {
  glossary: { version: string; terms: number; updated: boolean } | null;
  tm: { version: string; entries: number; updated: boolean } | null;
}

export interface Provider {
  id: string;
  name: string;
  models: string[];
  /** Ready to use: an API key is present, or — for `auth: "cli"` — the
   *  user's coding CLI is logged in. */
  has_key: boolean;
  /** Present only for coding-CLI subscriptions (Claude Code, Codex, Gemini CLI). */
  auth?: "cli";
  connected?: boolean;
  /** Shell command that authenticates the CLI, e.g. "claude login". */
  login_hint?: string | null;
  /** Signed-in account, when the CLI's credential exposes one. */
  account?: string | null;
}

/** POST /providers/models - live model listing with static-catalog fallback. */
export interface ProviderModels {
  provider: string;
  models: string[];
  source: "live" | "static";
  error: string | null;
}

export interface ProviderTestResult {
  ok: boolean;
  error: string | null;
}

export interface PipelineStats {
  total_files: number;
  total_entries: number;
  translated_entries: number;
  failed_entries: number;
  tm_hits: number;
  skipped_entries: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** cumulative prompt tokens served from the provider cache */
  cached_tokens?: number;
  duration_seconds: number;
  coverage_percent: number;
  quality_score: number;
  /** translated-entry counts per content bucket (quests, guidebook, ...) */
  categories?: Record<string, number>;
}

/** Params for POST /jobs {type: "translate"} - engine PipelineConfig surface. */
export interface TranslateParams {
  session_id?: string;
  /** Scan the run came from; lets the engine persist its payload on the
   *  translate session so reopening can replay the scan screen. */
  scan_job_id?: string;
  modpack_path: string;
  output_dir?: string;
  source_locale?: string;
  target_locale?: string;
  model?: string;
  api_key?: string;
  api_base?: string;
  temperature?: number;
  batch_size?: number;
  max_concurrent?: number;
  file_workers?: number;
  max_refine?: number;
  /** litellm reasoning_effort: thinking effort for reasoning-capable models */
  reasoning_effort?: "low" | "medium" | "high";
  use_tm?: boolean;
  use_vanilla_glossary?: boolean;
  extract_glossary?: boolean;
  /** Maximum mined glossary candidates; null means unlimited. */
  glossary_max_terms?: number | null;
  include_categories?: string[];
}

export interface ScanParams {
  modpack_path: string;
  source_locale?: string;
  target_locale?: string;
}

export interface ExportParams {
  translate_job_id: string;
  output_zip?: string;
}

/** Params for POST /jobs {type: "upload"} - engine upload job surface. */
export interface UploadParams {
  translate_job_id: string;
  modpack_name: string;
  modpack_version?: string;
  /** CurseForge modpack id, forwarded to the web pack registration */
  curseforge_id?: number;
  description?: string;
  changelog?: string;
  web_url?: string;
  api_token?: string;
}

/* ---- WebSocket event frames (/jobs/{id}/events) ---- */

export interface ProgressFrame {
  type: "progress";
  stage: string;
  /** translate/export style */
  done?: number;
  total?: number;
  file?: string;
  /** scan style */
  current?: number;
  message?: string;
}

export interface EntryFailedFrame {
  type: "entry_failed";
  key: string;
  errors: string[];
}

export interface EntryDoneFrame {
  type: "entry_done";
  key: string;
  source: string;
  translated: string;
}

export interface BatchStartedFrame {
  type: "batch_started";
  request_id: number;
  file: string;
  key: string;
  entries: number;
}

export interface BatchFinishedFrame {
  type: "batch_finished";
  request_id: number;
}

export interface TokensFrame {
  type: "tokens";
  prompt_tokens: number;
  completion_tokens: number;
  /** cumulative prompt tokens served from the provider cache */
  cached_tokens?: number;
}

export interface GlossaryExtractedFrame {
  type: "glossary_extracted";
  new_terms: number;
}

export interface GlossaryProgressFrame {
  type: "glossary_progress";
  /** extraction chunks completed */
  done: number;
  total: number;
  /** one-based chunk number for retry/skip diagnostics */
  chunk?: number;
  /** terms extracted so far */
  new_terms: number;
  /** present when a schema-invalid LLM response failed this attempt */
  attempt?: number;
  error?: string;
  /** chunk gave up after exhausting retries */
  skipped?: boolean;
}

export interface TerminalFrame {
  type: "done" | "failed" | "cancelled";
  status: JobStatus;
  error?: string;
  stats?: PipelineStats;
  /** export terminal payload — either zip is null when its tree is empty */
  zip_path?: string | null;
  overrides_zip_path?: string | null;
  file_count?: number;
  /** upload terminal payload */
  pack_id?: string;
  url?: string;
}

export type JobEventFrame =
  | ProgressFrame
  | EntryFailedFrame
  | EntryDoneFrame
  | TokensFrame
  | BatchStartedFrame
  | BatchFinishedFrame
  | GlossaryProgressFrame
  | GlossaryExtractedFrame
  | TerminalFrame;
