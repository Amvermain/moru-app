/**
 * reopenSession contract: History's 검수/내보내기 buttons must only land on
 * a working W5/W6 — the engine job is verified (and pruned when gone)
 * before the wizard state is replaced.
 */
import { expect, test } from "bun:test";

// wizard.ts transitively imports lib/bridge (window.moru) and lib/web
// (window.localStorage) at module scope. Other test files in the same
// bun process may have installed window + the cached bridge singleton
// first, so merge globals instead of replacing them and patch the
// exported moru object directly.
const storage = new Map();
const localStorageStub = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
};
globalThis.localStorage ??= localStorageStub;
const win = (globalThis.window ??= {});
win.localStorage ??= localStorageStub;
win.location ??= { search: "" };
win.moru ??= {};

const fetchCalls = [];
let nextResponse = null;
/** url substring -> response, consulted before the shared nextResponse. */
const routeResponses = new Map();
globalThis.fetch = async (url) => {
  const href = String(url);
  fetchCalls.push(href);
  for (const [needle, response] of routeResponses) {
    if (href.includes(needle)) return response;
  }
  return nextResponse;
};

const { useWizard, useSessionJobs } = await import("./wizard.ts");
const { useSessions } = await import("./sessions.ts");
const { useEngineStore } = await import("./engine.ts");
const bridge = await import("../lib/bridge.ts");
if (typeof bridge.moru.setBusy !== "function") {
  bridge.moru.setBusy = () => undefined;
}

useEngineStore.setState({
  info: { state: "ready", port: 59999, token: "tk", restarts: 0 },
});

function record(id, status, overrides = {}) {
  return {
    id,
    modpackPath: `/packs/${id}`,
    modpackName: `Pack ${id}`,
    sourceLocale: "en_us",
    targetLocale: "ko_kr",
    model: "openai/gpt-test",
    status,
    createdAt: 1_000,
    finishedAt: 2_000,
    doneEntries: 42,
    totalEntries: 50,
    stats: { translated_entries: 42, total_entries: 50, coverage_percent: 84 },
    error: null,
    exportZipPath: "/exports/pack.zip",
    exportOverridesZipPath: null,
    sharedUrl: null,
    ...overrides,
  };
}

const okPage = {
  ok: true,
  json: async () => ({ entries: [], total: 0, page: 1, page_size: 1 }),
};
const notFound = {
  ok: false,
  status: 404,
  statusText: "Not Found",
  json: async () => ({ detail: "unknown job: dead" }),
};

test("refuses to clobber a run in flight", async () => {
  useWizard.setState({ runState: "running" });
  expect(await useWizard.getState().reopenSession("s1")).toBe("busy");
  useWizard.setState({ runState: "idle" });
});

test("gone when the session has no registered engine job and disk session restore fails", async () => {
  useSessions.getState().upsert(record("s1", "done"));
  fetchCalls.length = 0;
  expect(await useWizard.getState().reopenSession("s1")).toBe("gone");
  // Probe the entries endpoint first, then fall back to the disk session.
  expect(fetchCalls).toHaveLength(2);
  expect(fetchCalls[0]).toContain("/translate/s1/entries");
  expect(fetchCalls[1]).toContain("/sessions/s1/restore");
});

test("hydrates W5/W6 state after a successful probe", async () => {
  useSessionJobs.getState().register("s1", "job-1");
  nextResponse = okPage;
  expect(await useWizard.getState().reopenSession("s1")).toBe("ok");
  expect(fetchCalls.some((c) => c.includes("/translate/job-1/entries"))).toBe(true);

  const w = useWizard.getState();
  expect(w.sessionId).toBe("s1");
  expect(w.translateJobId).toBe("job-1");
  expect(w.runState).toBe("done");
  expect(w.model).toBe("openai/gpt-test");
  expect(w.stats.coverage_percent).toBe(84);
  expect(w.exportState).toBe("done");
  expect(w.exportZipPath).toBe("/exports/pack.zip");
});

test("already-live finished session revalidates and keeps in-run state", async () => {
  useWizard.setState({ failedKeys: { "block.x": ["schema"] } }); // richer in-run state
  nextResponse = okPage;
  const before = fetchCalls.length;
  expect(await useWizard.getState().reopenSession("s1")).toBe("ok");
  expect(fetchCalls.length).toBe(before + 1); // sidecar may have restarted: always probe
  expect(fetchCalls.pop()).toContain("/translate/job-1/entries");
  expect(useWizard.getState().failedKeys["block.x"]).toEqual(["schema"]); // not rewritten
});

test("prunes the mapping and keeps state when the engine job is gone", async () => {
  useSessions.getState().upsert(record("s2", "cancelled", { exportZipPath: null }));
  useSessionJobs.getState().register("s2", "dead");
  nextResponse = notFound;
  expect(await useWizard.getState().reopenSession("s2")).toBe("gone");
  expect(useSessionJobs.getState().jobs.s2).toBeUndefined();
  expect(useWizard.getState().sessionId).toBe("s1"); // untouched
});

test("wizard reset keeps the runtime job registry", () => {
  useWizard.getState().reset();
  expect(useWizard.getState().sessionId).toBe(null);
  expect(useSessionJobs.getState().jobs.s1).toBe("job-1");
});

test("stale current session probes, prunes, and reports gone", async () => {
  // Re-hydrate s1 so the wizard owns it again (post-reset it is non-live).
  nextResponse = okPage;
  expect(await useWizard.getState().reopenSession("s1")).toBe("ok");
  // Sidecar restarted underneath: same wizard session, engine lost the job.
  nextResponse = notFound;
  expect(await useWizard.getState().reopenSession("s1")).toBe("gone");
  expect(useSessionJobs.getState().jobs.s1).toBeUndefined(); // affordance revoked
  expect(useWizard.getState().sessionId).toBe("s1"); // live state left in place
});

test("failed records never reopen even with a live job", async () => {
  useSessions.getState().upsert(record("s3", "failed"));
  useSessionJobs.getState().register("s3", "job-3");
  const before = fetchCalls.length;
  expect(await useWizard.getState().reopenSession("s3")).toBe("gone");
  expect(fetchCalls.length).toBe(before); // status gate precedes the probe
});

test("restores the scan screen only when the session carries a scan payload", async () => {
  const scanPayload = { modpack_path: "/packs/s4", categories: [], identity: null };
  useSessions.getState().upsert(record("s4", "done"));
  useSessionJobs.getState().register("s4", "job-4");
  nextResponse = okPage;
  routeResponses.set("/scan/", { ok: true, json: async () => scanPayload });

  expect(await useWizard.getState().reopenSession("s4")).toBe("ok");
  expect(useWizard.getState().scanResult).toEqual(scanPayload);
  expect(useWizard.getState().scanState).toBe("done"); // otherwise w3 is unreachable

  // A different session with no persisted payload: the scan screen stays
  // idle rather than half-restored. (Reopening s4 again would short-circuit
  // on the already-live path and keep its state.)
  useSessions.getState().upsert(record("s5", "done"));
  useSessionJobs.getState().register("s5", "job-5");
  routeResponses.set("/scan/", notFound);
  expect(await useWizard.getState().reopenSession("s5")).toBe("ok");
  expect(useWizard.getState().scanResult).toBe(null);
  expect(useWizard.getState().scanState).toBe("idle");
  routeResponses.clear();
});
