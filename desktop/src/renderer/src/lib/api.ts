/**
 * Engine API client (contracts/engine-api.yaml). All calls carry the
 * session token; the base URL comes from the engine store once the
 * sidecar handshake completes.
 */

import type {
  CommunitySyncResult,
  Entry,
  EntryPage,
  ExportParams,
  Glossary,
  Job,
  JobEventFrame,
  Provider,
  ProviderModels,
  ProviderTestResult,
  ScanParams,
  ScanResult,
  TmStats,
  TranslateParams,
  UploadParams,
} from "../../../shared/engine";
import { useEngineStore } from "../stores/engine";

export class EngineApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "EngineApiError";
  }
}

function endpoint(): { base: string; token: string } {
  const { info } = useEngineStore.getState();
  if (info.state !== "ready" || info.port === null || info.token === null) {
    throw new EngineApiError(0, "engine is not ready");
  }
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { base, token } = endpoint();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail !== undefined) detail = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new EngineApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export interface SessionSummary {
  id: string;
  modpack_name: string;
  modpack_path: string;
  source_locale: string;
  target_locale: string;
  model: string;
  status: string;
  created_at: string | null;
  finished_at: string | null;
  total_entries: number;
  done_entries: number;
  stats: Record<string, unknown> | null;
  export_zip_path: string | null;
  export_overrides_zip_path: string | null;
}

export const api = {
  startScan: (params: ScanParams) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify({ type: "scan", params }) }),
  startTranslate: (params: TranslateParams) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify({ type: "translate", params }) }),
  startExport: (params: ExportParams) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify({ type: "export", params }) }),
  startUpload: (params: UploadParams) =>
    request<Job>("/jobs", { method: "POST", body: JSON.stringify({ type: "upload", params }) }),

  job: (id: string) => request<Job>(`/jobs/${id}`),
  cancelJob: (id: string) => request<{ id: string; status: string }>(`/jobs/${id}/cancel`, { method: "POST" }),

  scanResult: (jobId: string) => request<ScanResult>(`/scan/${jobId}/result`),

  entries: (
    jobId: string,
    filter: "all" | "failed" | "warning" | "modified",
    page: number,
    pageSize = 100,
    search = "",
  ) =>
    request<EntryPage>(
      `/translate/${jobId}/entries?filter=${filter}&page=${page}&page_size=${pageSize}` +
        (search === "" ? "" : `&search=${encodeURIComponent(search)}`),
    ),
  patchEntry: (jobId: string, key: string, translatedText: string, file?: string) =>
    request<Entry>(`/translate/${jobId}/entries/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({ translated_text: translatedText, file }),
    }),
  retranslateEntry: (jobId: string, key: string, file?: string) =>
    request<Entry>(`/translate/${jobId}/entries/${encodeURIComponent(key)}/retranslate`, {
      method: "POST",
      body: JSON.stringify({ file }),
    }),

  glossary: (sourceLang: string, targetLang: string) =>
    request<Glossary>(`/glossary?source_lang=${sourceLang}&target_lang=${targetLang}`),
  putGlossary: (doc: Glossary) =>
    request<Glossary>("/glossary", { method: "PUT", body: JSON.stringify(doc) }),

  tmStats: () => request<TmStats>("/tm/stats"),
  syncCommunity: (webUrl: string, targetLang: string, sourceLang = "en_us") =>
    request<CommunitySyncResult>("/community/sync", {
      method: "POST",
      body: JSON.stringify({
        web_url: webUrl,
        source_lang: sourceLang,
        target_lang: targetLang,
      }),
    }),
  providers: () => request<Provider[]>("/providers"),
  testProvider: (provider: string, apiKey?: string, model?: string, apiBase?: string) =>
    request<ProviderTestResult>("/providers/test", {
      method: "POST",
      body: JSON.stringify({ provider, api_key: apiKey, model, api_base: apiBase }),
    }),
  providerModels: (provider: string, apiKey?: string, apiBase?: string) =>
    request<ProviderModels>("/providers/models", {
      method: "POST",
      body: JSON.stringify({ provider, api_key: apiKey, api_base: apiBase }),
    }),

  config: () => request<Record<string, unknown>>("/config"),
  putConfig: (config: Record<string, unknown>) =>
    request<Record<string, unknown>>("/config", { method: "PUT", body: JSON.stringify(config) }),

  listSessions: () => request<SessionSummary[]>("/sessions"),
  restoreSession: (sessionId: string) =>
    request<Job>(`/sessions/${sessionId}/restore`, { method: "POST" }),
  exportSession: (sessionId: string, outputPath: string) =>
    request<{ status: string; path: string }>(`/sessions/${sessionId}/export`, {
      method: "POST",
      body: JSON.stringify({ output_path: outputPath }),
    }),
  importSession: (inputPath: string) =>
    request<{ status: string; session: SessionSummary; job: Job }>("/sessions/import", {
      method: "POST",
      body: JSON.stringify({ input_path: inputPath }),
    }),
  deleteSession: (sessionId: string) =>
    request<{ status: string; id: string }>(`/sessions/${sessionId}`, { method: "DELETE" }),
};

/**
 * Subscribe to a job's event stream. Buffered history replays first, then
 * live frames; the socket closes itself after the terminal frame.
 * Returns an unsubscribe (close) function.
 */
export function openJobEvents(
  jobId: string,
  onFrame: (frame: JobEventFrame) => void,
  onClose?: () => void,
): () => void {
  const { base, token } = endpoint();
  const url = `${base.replace("http", "ws")}/jobs/${jobId}/events?token=${token}`;
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    onFrame(JSON.parse(event.data as string) as JobEventFrame);
  };
  ws.onclose = () => onClose?.();
  return () => ws.close();
}
