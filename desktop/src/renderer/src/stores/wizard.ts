/**
 * Wizard session state (W1-W6). One active translation session at a time;
 * job lifecycles (scan/translate/export) and their WS event streams are
 * driven from here so screens stay declarative.
 */

import { create } from "zustand";

import type {
  JobEventFrame,
  PipelineStats,
  ScanResult,
  TranslateParams,
} from "../../../shared/engine";
import type { ModpackProbe } from "../../../shared/bridge";
import { api, openJobEvents } from "../lib/api";
import { providerIdOf } from "../lib/models";
import { moru } from "../lib/bridge";
import { WEB_URL } from "../lib/web";
import { useSessions } from "./sessions";
import { useSettings } from "./settings";

export interface TickerPair {
  key: string;
  source: string;
  translated: string;
}

export interface ActiveBatch {
  requestId: number;
  file: string;
  key: string;
  entries: number;
  startedAt: number;
}

export interface FileProgress {
  file: string;
  done: number;
  total: number;
}

export interface GlossaryProgress {
  /** extraction chunks completed / total */
  done: number;
  total: number;
  newTerms: number;
  /** attempt number currently being retried after a schema error */
  retrying: number | null;
  lastError: string | null;
}

export interface LogLine {
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
}

/**
 * Runtime map of session id -> engine translate job id.
 * Engine jobs live only as long as the sidecar process, so this map is
 * deliberately NOT persisted: after an app/engine restart no reopen
 * affordance is offered for jobs the engine no longer holds.
 * wizard.reset() keeps it; a failed reopen probe prunes the mapping.
 */
interface SessionJobsStore {
  jobs: Record<string, string>;
  register: (sessionId: string, jobId: string) => void;
  unregister: (sessionId: string) => void;
}

export const useSessionJobs = create<SessionJobsStore>((set) => ({
  jobs: {},
  register: (sessionId, jobId) =>
    set((state) => ({ jobs: { ...state.jobs, [sessionId]: jobId } })),
  unregister: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.jobs)) return state;
      const jobs = { ...state.jobs };
      delete jobs[sessionId];
      return { jobs };
    }),
}));

interface WizardStore {
  /* W1 */
  sessionId: string | null;
  modpackPath: string | null;
  modpackName: string;
  probe: ModpackProbe | null;
  sourceLocale: string;
  targetLocale: string;

  /* W2 */
  scanJobId: string | null;
  scanState: "idle" | "running" | "done" | "failed";
  scanProgress: { current: number; total: number; message: string };
  scanError: string | null;
  scanResult: ScanResult | null;
  /** category names excluded from translation (default: all included) */
  excludedCategories: string[];

  /* W4 */
  translateJobId: string | null;
  /** Model the run was started with; settings.model may drift afterwards. */
  model: string | null;
  runState: "idle" | "running" | "done" | "failed" | "cancelled";
  runError: string | null;
  startedAt: number | null;
  /** First provider batch start; excludes scan/glossary from live throughput. */
  translationStartedAt: number | null;
  finishedAt: number | null;
  doneEntries: number;
  fileProgress: Record<string, FileProgress>;
  glossaryProgress: GlossaryProgress | null;
  failedKeys: Record<string, string[]>;
  promptTokens: number;
  completionTokens: number;
  /** prompt tokens served from the provider cache (subset of promptTokens) */
  cachedTokens: number;
  ticker: TickerPair[];
  activeBatches: Record<number, ActiveBatch>;
  log: LogLine[];
  stats: PipelineStats | null;

  /* W6 */
  exportJobId: string | null;
  exportState: "idle" | "running" | "done" | "failed";
  exportZipPath: string | null;
  exportOverridesZipPath: string | null;
  exportError: string | null;

  /* actions */
  startSession: (path: string, probe: ModpackProbe) => void;
  resumeSession: (sessionId: string) => boolean;
  /** Reopens a finished session on W5/W6 after verifying the engine job. */
  reopenSession: (sessionId: string) => Promise<"ok" | "busy" | "gone">;
  setTargetLocale: (locale: string) => void;
  toggleCategory: (name: string, included: boolean) => void;
  setCategories: (names: string[], included: boolean) => void;
  startScan: () => Promise<void>;
  startTranslate: () => Promise<void>;
  cancelTranslate: () => Promise<void>;
  startExport: () => Promise<void>;
  appendLog: (level: LogLine["level"], text: string) => void;
  reset: () => void;
}

/** Entry volume of the current selection, from the enriched scan result. */
export function selectedScanTotals(state: {
  scanResult: ScanResult | null;
  excludedCategories: string[];
}): { files: number; entries: number; chars: number } {
  let files = 0;
  let entries = 0;
  let chars = 0;
  if (state.scanResult !== null) {
    for (const cat of state.scanResult.categories) {
      if (state.excludedCategories.includes(cat.name)) continue;
      files += cat.file_count;
      entries += cat.entry_count;
      chars += cat.char_count;
    }
  }
  return { files, entries, chars };
}

let closeScanEvents: (() => void) | null = null;
let closeTranslateEvents: (() => void) | null = null;
let closeExportEvents: (() => void) | null = null;

const MAX_LOG_LINES = 500;
const MAX_TICKER = 24;

const initialJobState = {
  scanJobId: null,
  scanState: "idle" as const,
  scanProgress: { current: 0, total: 0, message: "" },
  scanError: null,
  scanResult: null,
  excludedCategories: [],
  translateJobId: null,
  model: null,
  runState: "idle" as const,
  runError: null,
  startedAt: null,
  translationStartedAt: null,
  finishedAt: null,
  doneEntries: 0,
  fileProgress: {},
  glossaryProgress: null,
  failedKeys: {},
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  ticker: [],
  activeBatches: {},
  log: [],
  stats: null,
  exportJobId: null,
  exportState: "idle" as const,
  exportZipPath: null,
  exportOverridesZipPath: null,
  exportError: null,
};

export const useWizard = create<WizardStore>((set, get) => ({
  sessionId: null,
  modpackPath: null,
  modpackName: "",
  probe: null,
  sourceLocale: "en_us",
  targetLocale: useSettings.getState().targetLocale,
  ...initialJobState,

  startSession: (path, probe) => {
    closeScanEvents?.();
    closeTranslateEvents?.();
    closeExportEvents?.();
    set({
      sessionId: crypto.randomUUID(),
      modpackPath: path,
      modpackName: probe.name,
      probe,
      targetLocale: useSettings.getState().targetLocale,
      ...initialJobState,
    });
    useSettings.getState().rememberFolder(path);
  },

  resumeSession: (sessionId) => {
    // Engine jobs are in-memory: resuming a session from a previous app run
    // restores its metadata so the wizard can re-run from W1/W3.
    const record = useSessions.getState().sessions.find((s) => s.id === sessionId);
    if (record === undefined) return false;
    if (get().sessionId === sessionId) return true; // live in this run
    set({
      sessionId: record.id,
      modpackPath: record.modpackPath,
      modpackName: record.modpackName,
      probe: null,
      sourceLocale: record.sourceLocale,
      targetLocale: record.targetLocale,
      ...initialJobState,
    });
    return true;
  },

  reopenSession: async (sessionId) => {
    const state = get();
    // The sidecar can restart (dropping every job) under a live renderer,
    // so even the wizard's own finished session is probed before "ok".
    const liveJobId =
      state.sessionId === sessionId &&
      (state.runState === "done" || state.runState === "cancelled")
        ? state.translateJobId
        : null;
    if (liveJobId !== null) {
      try {
        await api.entries(liveJobId, "all", 1, 1);
      } catch {
        useSessionJobs.getState().unregister(sessionId);
        return "gone";
      }
      // Keep the richer in-run state (scan identity, failed keys, log).
      return "ok";
    }
    // One wizard session at a time - never clobber a run in flight.
    if (
      state.scanState === "running" ||
      state.runState === "running" ||
      state.exportState === "running"
    ) {
      return "busy";
    }
    const record = useSessions.getState().sessions.find((s) => s.id === sessionId);
    const jobId = useSessionJobs.getState().jobs[sessionId] ?? sessionId;
    if (
      record === undefined ||
      (record.status !== "done" && record.status !== "cancelled")
    ) {
      return "gone";
    }
    // Engine jobs are process-scoped or persisted on disk. Probing api.entries
    // auto-restores disk session files if sidecar dropped in-RAM job state.
    try {
      await api.entries(jobId, "all", 1, 1);
      useSessionJobs.getState().register(sessionId, jobId);
    } catch {
      try {
        await api.restoreSession(sessionId);
        useSessionJobs.getState().register(sessionId, sessionId);
      } catch {
        useSessionJobs.getState().unregister(sessionId);
        return "gone";
      }
    }
    const activeJobId = useSessionJobs.getState().jobs[sessionId] ?? jobId;
    const failedKeys: Record<string, string[]> = {};
    const restoredLog: LogLine[] = [];
    try {
      let page = 1;
      while (true) {
        const res = await api.entries(activeJobId, "failed", page, 500);
        for (const e of res.entries) {
          failedKeys[e.key] = e.errors.length > 0 ? e.errors : ["translation failed"];
          restoredLog.push({
            ts: record.finishedAt ?? record.createdAt,
            level: "warn",
            text: `entry failed: ${e.key} — ${e.errors.join("; ") || "failed"}`,
          });
        }
        if (res.entries.length === 0 || page * 500 >= res.total) break;
        page++;
      }

      page = 1;
      while (true) {
        const res = await api.entries(activeJobId, "warning", page, 500);
        for (const e of res.entries) {
          if (e.errors.length > 0) {
            restoredLog.push({
              ts: record.finishedAt ?? record.createdAt,
              level: "warn",
              text: `entry warning: ${e.key} — ${e.errors.join("; ")}`,
            });
          }
        }
        if (res.entries.length === 0 || page * 500 >= res.total) break;
        page++;
      }
    } catch {
      // ignore
    }

    let scanResult: ScanResult | null = null;
    try {
      scanResult = await api.scanResult(activeJobId);
    } catch {
      // ignore
    }

    closeScanEvents?.();
    closeTranslateEvents?.();
    closeExportEvents?.();
    set({
      sessionId: record.id,
      modpackPath: record.modpackPath,
      modpackName: record.modpackName,
      probe: null,
      sourceLocale: record.sourceLocale,
      targetLocale: record.targetLocale,
      ...initialJobState,
      scanState: scanResult !== null ? ("done" as const) : ("idle" as const),
      scanResult,
      failedKeys,
      log: restoredLog,
      translateJobId: activeJobId,
      model: record.model,
      runState: record.status,
      startedAt: record.createdAt,
      finishedAt: record.finishedAt,
      doneEntries: record.doneEntries,
      stats: record.stats,
      exportState: record.exportZipPath !== null ? ("done" as const) : ("idle" as const),
      exportZipPath: record.exportZipPath,
      exportOverridesZipPath: record.exportOverridesZipPath,
    });
    return "ok";
  },

  setTargetLocale: (locale) => {
    set({ targetLocale: locale });
    useSettings.getState().set({ targetLocale: locale });
  },

  toggleCategory: (name, included) =>
    set((state) => ({
      excludedCategories: included
        ? state.excludedCategories.filter((c) => c !== name)
        : [...new Set([...state.excludedCategories, name])],
    })),

  setCategories: (names, included) =>
    set((state) => ({
      excludedCategories: included
        ? state.excludedCategories.filter((c) => !names.includes(c))
        : [...new Set([...state.excludedCategories, ...names])],
    })),

  startScan: async () => {
    const { modpackPath, sourceLocale, targetLocale } = get();
    if (modpackPath === null || get().scanState === "running") return;
    closeScanEvents?.();
    set({
      scanState: "running",
      scanError: null,
      scanResult: null,
      scanProgress: { current: 0, total: 0, message: "" },
    });
    try {
      const job = await api.startScan({
        modpack_path: modpackPath,
        source_locale: sourceLocale,
        target_locale: targetLocale,
      });
      set({ scanJobId: job.id });
      closeScanEvents = openJobEvents(job.id, (frame) => {
        if (frame.type === "progress") {
          set({
            scanProgress: {
              current: frame.current ?? frame.done ?? 0,
              total: frame.total ?? 0,
              message: frame.message ?? "",
            },
          });
        } else if (frame.type === "done") {
          void api.scanResult(job.id).then((result) => {
            // Confident launcher-metadata identity beats the folder-name guess.
            const identity = result.identity;
            set({
              scanState: "done",
              scanResult: result,
              excludedCategories: [],
              ...(identity?.confident === true && identity.name !== null
                ? { modpackName: identity.name }
                : {}),
            });
          });
        } else if (frame.type === "failed") {
          set({ scanState: "failed", scanError: frame.error ?? "scan failed" });
        } else if (frame.type === "cancelled") {
          set({ scanState: "idle" });
        }
      });
    } catch (error) {
      set({ scanState: "failed", scanError: String(error) });
    }
  },

  startTranslate: async () => {
    const state = get();
    if (state.modpackPath === null || state.runState === "running") return;
    const settings = useSettings.getState();
    closeTranslateEvents?.();

    const providerId = providerIdOf(settings.model);
    const apiKey = (await moru.secrets.get(`apikey:${providerId}`)) ?? undefined;
    const apiBase =
      providerId === "ollama"
        ? settings.ollamaBaseUrl
        : providerId === "openai-compatible"
          ? settings.openaiCompatBaseUrl
          : undefined;
    const sessionId = state.sessionId ?? crypto.randomUUID();
    const params: TranslateParams = {
      session_id: sessionId,
      scan_job_id: state.scanJobId ?? undefined,
      modpack_path: state.modpackPath,
      source_locale: state.sourceLocale,
      target_locale: state.targetLocale,
      model: settings.model,
      api_key: apiKey,
      api_base: apiBase,
      temperature: settings.temperature,
      batch_size: settings.batchSize,
      max_concurrent: settings.maxConcurrent,
      max_refine: settings.maxRefine,
      reasoning_effort: settings.thinkingEnabled ? settings.thinkingEffort : undefined,
      use_tm: settings.useTm,
      use_vanilla_glossary: settings.useVanillaGlossary,
      extract_glossary: settings.extractGlossary,
      glossary_max_terms: settings.glossaryMaxTerms,
      include_categories:
        state.excludedCategories.length > 0 && state.scanResult !== null
          ? state.scanResult.categories
              .map((c) => c.name)
              .filter((name) => !state.excludedCategories.includes(name))
          : undefined,
      output_dir: settings.outputDir ?? undefined,
    };

    set({
      runState: "running",
      model: settings.model,
      runError: null,
      startedAt: Date.now(),
      translationStartedAt: null,
      finishedAt: null,
      doneEntries: 0,
      fileProgress: {},
      glossaryProgress: null,
      failedKeys: {},
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      ticker: [],
      activeBatches: {},
      log: [],
      stats: null,
    });
    get().appendLog("info", `translate start: ${state.modpackName} → ${state.targetLocale}`);
    moru.setBusy(true);

    // Best-effort community pull: fresh approved corrections/terms land in
    // the local TM + user glossary store before the glossary stage reads
    // them. Network failure only logs - the run itself never blocks on it.
    try {
      const sync = await api.syncCommunity(WEB_URL, state.targetLocale, state.sourceLocale);
      const parts: string[] = [];
      if (sync.tm !== null) {
        parts.push(`TM v${sync.tm.version} (${sync.tm.entries})${sync.tm.updated ? " *" : ""}`);
      }
      if (sync.glossary !== null) {
        parts.push(
          `glossary v${sync.glossary.version} (${sync.glossary.terms})${sync.glossary.updated ? " *" : ""}`,
        );
      }
      get().appendLog(
        "info",
        parts.length > 0 ? `community sync: ${parts.join(", ")}` : "community sync: nothing published",
      );
    } catch (error) {
      get().appendLog("warn", `community sync skipped: ${String(error)}`);
    }

    const sessions = useSessions.getState();
    sessions.upsert({
      id: sessionId,
      modpackPath: state.modpackPath,
      modpackName: state.modpackName,
      sourceLocale: state.sourceLocale,
      targetLocale: state.targetLocale,
      model: settings.model,
      status: "running",
      createdAt: Date.now(),
      finishedAt: null,
      doneEntries: 0,
      totalEntries: selectedScanTotals(state).entries,
      stats: null,
      error: null,
      exportZipPath: null,
      exportOverridesZipPath: null,
      sharedUrl: null,
    });
    set({ sessionId });

    const finish = (
      runState: "done" | "failed" | "cancelled",
      patch: Partial<WizardStore> = {},
    ): void => {
      moru.setBusy(false);
      set({ runState, finishedAt: Date.now(), activeBatches: {}, ...patch });
      const current = get();
      useSessions.getState().patch(sessionId, {
        status: runState,
        finishedAt: Date.now(),
        doneEntries: current.doneEntries,
        stats: current.stats,
        error: current.runError,
      });
    };

    try {
      const job = await api.startTranslate(params);
      set({ translateJobId: job.id });
      useSessionJobs.getState().register(sessionId, job.id);
      closeTranslateEvents = openJobEvents(job.id, (frame: JobEventFrame) => {
        switch (frame.type) {
          case "progress": {
            const file = frame.file;
            if (frame.stage === "translate" && file !== undefined) {
              const done = frame.done ?? 0;
              const total = frame.total ?? 0;
              set((prev) => {
                const fileProgress = {
                  ...prev.fileProgress,
                  [file]: { file, done, total },
                };
                const doneEntries = Object.values(fileProgress).reduce(
                  (sum, f) => sum + f.done,
                  0,
                );
                return { fileProgress, doneEntries };
              });
            } else {
              get().appendLog("info", `stage: ${frame.stage}`);
            }
            break;
          }
          case "batch_started": {
            const batchStartedAt = Date.now();
            set((prev) => ({
              translationStartedAt: prev.translationStartedAt ?? batchStartedAt,
              activeBatches: {
                ...prev.activeBatches,
                [frame.request_id]: {
                  requestId: frame.request_id,
                  file: frame.file,
                  key: frame.key,
                  entries: frame.entries,
                  startedAt: batchStartedAt,
                },
              },
            }));
            break;
          }
          case "batch_finished":
            set((prev) => {
              const activeBatches = { ...prev.activeBatches };
              delete activeBatches[frame.request_id];
              return { activeBatches };
            });
            break;
          case "tokens":
            set({
              promptTokens: frame.prompt_tokens,
              completionTokens: frame.completion_tokens,
              ...(frame.cached_tokens !== undefined
                ? { cachedTokens: frame.cached_tokens }
                : {}),
            });
            break;
          case "entry_done":
            set((prev) => ({
              ticker: [
                { key: frame.key, source: frame.source, translated: frame.translated },
                ...prev.ticker,
              ].slice(0, MAX_TICKER),
            }));
            break;
          case "entry_failed":
            set((prev) => ({
              failedKeys: { ...prev.failedKeys, [frame.key]: frame.errors },
            }));
            get().appendLog("warn", `entry failed: ${frame.key} — ${frame.errors.join("; ")}`);
            break;
          case "glossary_progress": {
            const failedAttempt = frame.error !== undefined;
            if (failedAttempt) {
              get().appendLog(
                "warn",
                `glossary chunk ${frame.chunk ?? frame.done + 1}/${frame.total} ` +
                  (frame.skipped ? "skipped" : `retry ${frame.attempt}`) +
                  `: ${frame.error}`,
              );
            }
            set({
              glossaryProgress: {
                done: frame.done,
                total: frame.total,
                newTerms: frame.new_terms,
                retrying: failedAttempt && !frame.skipped ? (frame.attempt ?? 1) : null,
                lastError: failedAttempt ? (frame.error ?? null) : null,
              },
            });
            break;
          }
          case "glossary_extracted":
            get().appendLog("info", `glossary: +${frame.new_terms} terms extracted`);
            break;
          case "done":
            get().appendLog("info", "translate done");
            finish("done", { stats: frame.stats ?? null });
            break;
          case "failed":
            get().appendLog("error", frame.error ?? "translate failed");
            finish("failed", { runError: frame.error ?? "translate failed" });
            break;
          case "cancelled":
            get().appendLog("warn", "translate cancelled; partial result preserved");
            finish("cancelled", { stats: frame.stats ?? null });
            break;
        }
      });
    } catch (error) {
      get().appendLog("error", String(error));
      finish("failed", { runError: String(error) });
    }
  },

  cancelTranslate: async () => {
    const { translateJobId } = get();
    if (translateJobId === null) return;
    await api.cancelJob(translateJobId);
  },

  startExport: async () => {
    const { translateJobId, exportState } = get();
    if (translateJobId === null || exportState === "running") return;
    closeExportEvents?.();
    set({ exportState: "running", exportError: null });
    try {
      const job = await api.startExport({ translate_job_id: translateJobId });
      set({ exportJobId: job.id });
      closeExportEvents = openJobEvents(job.id, (frame) => {
        if (frame.type === "done") {
          const zipPath = frame.zip_path ?? null;
          const overridesZipPath = frame.overrides_zip_path ?? null;
          set({
            exportState: "done",
            exportZipPath: zipPath,
            exportOverridesZipPath: overridesZipPath,
          });
          const sessionId = get().sessionId;
          if (sessionId !== null) {
            useSessions.getState().patch(sessionId, {
              exportZipPath: zipPath,
              exportOverridesZipPath: overridesZipPath,
            });
          }
        } else if (frame.type === "failed") {
          set({ exportState: "failed", exportError: frame.error ?? "export failed" });
        }
      });
    } catch (error) {
      set({ exportState: "failed", exportError: String(error) });
    }
  },

  appendLog: (level, text) =>
    set((prev) => ({
      log: [...prev.log.slice(-MAX_LOG_LINES + 1), { ts: Date.now(), level, text }],
    })),

  reset: () => {
    closeScanEvents?.();
    closeTranslateEvents?.();
    closeExportEvents?.();
    moru.setBusy(false);
    set({
      sessionId: null,
      modpackPath: null,
      modpackName: "",
      probe: null,
      ...initialJobState,
    });
  },
}));
