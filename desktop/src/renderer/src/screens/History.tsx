/**
 * History screen - full session record list.
 * Persisted sessions from useSessions, with search, status filters, and
 * row actions wired to the wizard/router/bridge infrastructure.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { moru } from "@/lib/bridge";
import { formatInt, formatRelative, formatUsd, packInitials, parseTimestamp } from "@/lib/format";
import { modelDisplayName } from "@/lib/models";
import { costUsd, priceForModel, usePricingTable, type PricingTable } from "@/lib/pricing";
import { useRouter } from "@/stores/router";
import { useSessions, type SessionRecord } from "@/stores/sessions";
import { useSettings } from "@/stores/settings";
import { useSessionJobs, useWizard } from "@/stores/wizard";

type StatusFilter = "all" | "done" | "running" | "stopped";

const PAGE_SIZE = 20;

const GRID =
  "grid grid-cols-[44px_1fr_120px_100px_100px_100px_120px_150px] gap-3";

/** Overflow-menu item; reopenable rows fold folder/retry/delete behind ⋯. */
const MENU_ITEM =
  "block w-full px-3 py-1.5 text-left font-mono text-[10px] font-semibold text-text2 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";

/** Estimated USD spend of a finished session (pricing table x final token counts). */
function sessionCostUsd(s: SessionRecord, table: PricingTable | null): number {
  if (s.stats === null) return 0;
  const price = priceForModel(table, s.model);
  if (price === null) return 0;
  return costUsd(
    {
      promptTokens: s.stats.prompt_tokens,
      completionTokens: s.stats.completion_tokens,
      cachedTokens: s.stats.cached_tokens,
    },
    price,
  );
}

/** Pass rate: engine coverage when final stats exist, else live done/total. */
function passRatePercent(s: SessionRecord): number | null {
  if (s.stats !== null) return s.stats.coverage_percent;
  if (s.totalEntries > 0) return (s.doneEntries / s.totalEntries) * 100;
  return null;
}

function StatusBadge({ status }: { status: SessionRecord["status"] }): React.JSX.Element {
  const { t } = useTranslation();
  if (status === "running") {
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 w-1.5 animate-pxpulse bg-accent" />
        <span className="font-mono text-[11px] font-bold text-accent">
          {t("history.status.running")}
        </span>
      </div>
    );
  }
  if (status === "done") {
    return (
      <div>
        <span className="font-mono text-[11px] font-bold text-accent">
          ✓ {t("history.status.done")}
        </span>
      </div>
    );
  }
  return (
    <div>
      <span className="font-mono text-[11px] font-bold text-red">
        ✗ {t(status === "failed" ? "history.status.failed" : "history.status.cancelled")}
      </span>
    </div>
  );
}

interface SessionRowProps {
  s: SessionRecord;
  isCurrent: boolean;
  /** engine still holds this session's translate job (this app run) */
  canReopen: boolean;
  lang: "ko" | "en";
  onView: () => void;
  onReview: () => void;
  onExport: () => void;
  onExportSession: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

function SessionRow({
  s,
  isCurrent,
  canReopen,
  lang,
  onView,
  onReview,
  onExport,
  onExportSession,
  onRetry,
  onDelete,
}: SessionRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const packName = s.modpackName || s.modpackPath || "Modpack";
  const initials = packInitials(packName);
  const running = s.status === "running";
  const stopped = s.status === "failed" || s.status === "cancelled";
  const entryCount = s.stats?.translated_entries ?? s.doneEntries;
  const rate = passRatePercent(s);

  const rowBg = running
    ? "bg-[rgba(61,220,132,0.03)] hover:bg-[rgba(61,220,132,0.06)]"
    : stopped
      ? "bg-[rgba(242,107,107,0.03)] hover:bg-[rgba(242,107,107,0.06)]"
      : "hover:bg-raised-hover";

  const actionBase = "border px-2 py-1 font-mono text-[10px] font-semibold";

  return (
    <div className={`${GRID} group items-center border-b border-line px-4 py-3 ${rowBg}`}>
      <div
        className={`flex h-9 w-9 items-center justify-center border ${
          running ? "border-accent-lo bg-tint" : "border-edge bg-card"
        }`}
      >
        <span
          className={`font-mono font-bold ${initials.length >= 3 ? "text-[10px]" : "text-[11px]"} ${
            running ? "text-accent" : "text-text2"
          }`}
        >
          {initials}
        </span>
      </div>

      <div className="min-w-0">
        <div className="truncate text-[13px] font-bold text-text">{packName}</div>
        <div className="truncate font-mono text-[10px] text-text3">
          {s.targetLocale}
          {s.sharedUrl !== null && (
            <>
              {" · "}
              <span className="text-blue">{t("common.status.shared")}</span>
            </>
          )}
        </div>
      </div>

      <StatusBadge status={s.status} />

      <div className="font-mono text-[11px]">
        {s.status === "done" || s.totalEntries === 0 ? (
          <span className="text-text">{formatInt(entryCount)}</span>
        ) : (
          <>
            <span className={running ? "text-text" : "text-text2"}>{formatInt(entryCount)}</span>
            <span className="text-text3"> / {formatInt(s.totalEntries)}</span>
          </>
        )}
      </div>

      <div className="font-mono text-[11px] text-text">
        {rate !== null ? `${Math.round(rate * 10) / 10}%` : <span className="text-text4">—</span>}
      </div>

      <div className="truncate font-mono text-[11px] text-text2">{modelDisplayName(s.model)}</div>

      <div className="text-right font-mono text-[11px] text-text3">
        {formatRelative(s.finishedAt ?? s.createdAt, lang)}
      </div>

      <div
        className={`relative flex items-center justify-end gap-1.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
          menuOpen ? "opacity-100" : "opacity-0"
        }`}
      >
        {running && isCurrent && (
          <button
            className={`${actionBase} border-accent bg-[rgba(61,220,132,0.08)] text-accent hover:bg-[rgba(61,220,132,0.15)]`}
            onClick={onView}
          >
            {t("history.action.view")}
          </button>
        )}
        {canReopen ? (
          <>
            <button
              className={`${actionBase} border-edge text-text2 hover:border-edge2 hover:text-text`}
              onClick={onReview}
            >
              {t("history.action.review")}
            </button>
            <button
              className={`${actionBase} border-edge text-text2 hover:border-edge2 hover:text-text`}
              onClick={onExport}
            >
              {t("history.action.export")}
            </button>
            <div className="relative">
              <button
                className={`${actionBase} border-edge text-text2 hover:border-edge2 hover:text-text`}
                aria-label={t("history.action.more")}
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute top-full right-0 z-20 mt-1 w-[160px] border border-edge bg-raised py-1">
                    <button
                      className={`${MENU_ITEM} hover:text-accent`}
                      onClick={() => {
                        setMenuOpen(false);
                        onExportSession();
                      }}
                    >
                      {t("history.action.exportSession")}
                    </button>
                    {s.status === "done" && (
                      <button
                        className={`${MENU_ITEM} hover:text-text`}
                        disabled={s.exportZipPath === null}
                        onClick={() => {
                          setMenuOpen(false);
                          if (s.exportZipPath !== null) void moru.showItemInFolder(s.exportZipPath);
                        }}
                      >
                        {t("common.action.openFolder")}
                      </button>
                    )}
                    {stopped && (
                      <button
                        className={`${MENU_ITEM} hover:text-text`}
                        onClick={() => {
                          setMenuOpen(false);
                          onRetry();
                        }}
                      >
                        {t("common.action.retry")}
                      </button>
                    )}
                    <button
                      className={`${MENU_ITEM} hover:text-red`}
                      onClick={() => {
                        setMenuOpen(false);
                        onDelete();
                      }}
                    >
                      {t("common.action.delete")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {s.status === "done" && (
              <button
                className={`${actionBase} border-edge text-text2 hover:border-edge2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-text2`}
                disabled={s.exportZipPath === null}
                onClick={() => {
                  if (s.exportZipPath !== null) void moru.showItemInFolder(s.exportZipPath);
                }}
              >
                {t("common.action.openFolder")}
              </button>
            )}
            {stopped && (
              <button
                className={`${actionBase} border-edge text-text2 hover:border-edge2 hover:text-text`}
                onClick={onRetry}
              >
                {t("common.action.retry")}
              </button>
            )}
            <button
              className={`${actionBase} border-edge text-text3 hover:border-red hover:text-red`}
              onClick={onDelete}
            >
              {t("common.action.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function HistoryScreen(): React.JSX.Element {
  const { t } = useTranslation();
  const go = useRouter((s) => s.go);
  const sessions = useSessions((s) => s.sessions);
  const remove = useSessions((s) => s.remove);
  const wizardSessionId = useWizard((s) => s.sessionId);
  const resumeSession = useWizard((s) => s.resumeSession);
  const reopenSession = useWizard((s) => s.reopenSession);
  const lang = useSettings((s) => s.uiLanguage);
  const pricingTable = usePricingTable();

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const counts = useMemo(() => {
    let done = 0;
    let running = 0;
    let stopped = 0;
    for (const s of sessions) {
      if (s.status === "done") done += 1;
      else if (s.status === "running") running += 1;
      else stopped += 1;
    }
    return { all: sessions.length, done, running, stopped };
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...sessions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((s) => {
        if (filter === "done" && s.status !== "done") return false;
        if (filter === "running" && s.status !== "running") return false;
        if (filter === "stopped" && s.status !== "failed" && s.status !== "cancelled")
          return false;
        return q === "" || s.modpackName.toLowerCase().includes(q);
      });
  }, [sessions, filter, query]);

  const totalCost = useMemo(
    () => filtered.reduce((sum, s) => sum + sessionCostUsd(s, pricingTable), 0),
    [filtered, pricingTable],
  );

  const shown = filtered.slice(0, visible);
  const confirmTarget = confirmId !== null ? sessions.find((s) => s.id === confirmId) : undefined;

  const filters: { id: StatusFilter; label: string; count: number }[] = [
    { id: "all", label: t("history.filter.all"), count: counts.all },
    { id: "done", label: t("history.filter.done"), count: counts.done },
    { id: "running", label: t("history.filter.running"), count: counts.running },
    { id: "stopped", label: t("history.filter.stopped"), count: counts.stopped },
  ];

  const reopen = async (sessionId: string, screen: "w5" | "w6"): Promise<void> => {
    const result = await reopenSession(sessionId);
    if (result === "ok") {
      go(screen);
      return;
    }
    setNotice(t(result === "busy" ? "history.reopen.busy" : "history.reopen.gone"));
  };

  const handleImportSession = async (): Promise<void> => {
    const filePath = await moru.pickFile([{ name: "Moru Session", extensions: ["moru", "json"] }]);
    if (!filePath) return;
    try {
      const res = await api.importSession(filePath);
      if (res.status === "ok" && res.session) {
        const s = res.session;
        const rec: SessionRecord = {
          id: s.id,
          modpackPath: s.modpack_path || "",
          modpackName: s.modpack_name || "Modpack",
          sourceLocale: s.source_locale || "en_us",
          targetLocale: s.target_locale || "ko_kr",
          model: s.model || "",
          status: s.status === "cancelled" || s.status === "failed" ? s.status : "done",
          createdAt: parseTimestamp(s.created_at) ?? Date.now(),
          finishedAt: parseTimestamp(s.finished_at),
          doneEntries: s.done_entries ?? 0,
          totalEntries: s.total_entries ?? 0,
          stats: (s.stats as SessionRecord["stats"]) ?? null,
          error: null,
          exportZipPath: s.export_zip_path ?? null,
          exportOverridesZipPath: s.export_overrides_zip_path ?? null,
          sharedUrl: null,
        };
        useSessions.getState().upsert(rec);
        useSessionJobs.getState().register(rec.id, res.job.id);
        await reopen(rec.id, "w5");
      }
    } catch (err) {
      setNotice(lang === "ko" ? `세션 불러오기 실패: ${String(err)}` : `Import failed: ${String(err)}`);
    }
  };

  const handleExportSession = async (s: SessionRecord): Promise<void> => {
    const defaultName = `${s.modpackName.replace(/[^a-zA-Z0-9가-힣_-]/g, "_")}_session.moru`;
    const savePath = await moru.saveFile(defaultName);
    if (!savePath) return;
    try {
      const targetId = useSessionJobs.getState().jobs[s.id] ?? s.id;
      await api.exportSession(targetId, savePath);
      setNotice(lang === "ko" ? `세션 파일이 저장되었습니다: ${savePath}` : `Session saved: ${savePath}`);
    } catch (err) {
      setNotice(lang === "ko" ? `세션 내보내기 실패: ${String(err)}` : `Export failed: ${String(err)}`);
    }
  };

  return (
    <div className="animate-fade-in-up px-10 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="mb-[6px] font-mono text-[12px] font-semibold tracking-[0.08em] text-text3 uppercase">
            <span className="text-accent">▍</span> {t("history.eyebrow")}
          </div>
          <h1 className="m-0 text-[28px] font-bold tracking-[-0.02em] text-text">
            {t("history.title")}
          </h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void handleImportSession()}
            className="border border-edge bg-card px-3 py-1.5 text-[11px] font-semibold text-text2 hover:border-accent hover:text-accent flex items-center gap-1.5"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 9V2M6 2L3 5M6 2L9 5" />
              <path d="M2 10H10" />
            </svg>
            {t("history.importSession")}
          </button>
          <div className="mr-1 flex min-w-[220px] items-center gap-1.5 border border-edge bg-card px-2.5 py-1.5">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="#6A7C74"
              strokeWidth="1.5"
            >
              <circle cx="5" cy="5" r="3.5" />
              <path d="M8 8 L11 11" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("history.searchPlaceholder")}
              className="w-full flex-1 font-mono text-[12px] text-text placeholder:text-text4"
            />
          </div>
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={
                filter === f.id
                  ? "border border-accent bg-[rgba(61,220,132,0.08)] px-3 py-1.5 text-[11px] font-semibold text-accent"
                  : "border border-edge bg-transparent px-3 py-1.5 text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text"
              }
            >
              {f.label} {formatInt(f.count)}
            </button>
          ))}
        </div>
      </div>

      {notice !== null && (
        <div className="mb-4 flex items-center justify-between gap-3 border border-amber/50 bg-amber/[0.08] px-3 py-2">
          <span className="font-mono text-[11px] text-amber">{notice}</span>
          <button
            className="font-mono text-[11px] text-text3 hover:text-text"
            onClick={() => setNotice(null)}
          >
            ✕
          </button>
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="border border-dashed border-edge p-12 text-center">
          <div className="mb-1.5 text-[14px] font-bold text-text">{t("history.empty.title")}</div>
          <p className="m-0 mb-5 text-[12px] text-text3">{t("history.empty.desc")}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              className="flex items-center gap-1.5 bg-accent px-4 py-2 text-[13px] font-bold text-[#0A100D] hover:bg-accent-hi"
              onClick={() => go("w1")}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges">
                <rect x="5" y="1" width="2" height="10" fill="currentColor" />
                <rect x="1" y="5" width="10" height="2" fill="currentColor" />
              </svg>
              {t("history.empty.cta")}
            </button>
            <button
              className="flex items-center gap-1.5 border border-edge bg-card px-4 py-2 text-[13px] font-semibold text-text2 hover:border-accent hover:text-accent"
              onClick={() => void handleImportSession()}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 9V2M6 2L3 5M6 2L9 5" />
                <path d="M2 10H10" />
              </svg>
              {t("history.importSession")}
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-line2 bg-raised">
          <div
            className={`${GRID} border-b border-line2 bg-hover px-4 py-2.5 font-mono text-[10px] font-bold tracking-[0.06em] text-text3 uppercase`}
          >
            <div />
            <div>{t("history.col.pack")}</div>
            <div>{t("history.col.status")}</div>
            <div>{t("history.col.entries")}</div>
            <div>{t("history.col.passRate")}</div>
            <div>{t("history.col.model")}</div>
            <div className="text-right">{t("history.col.date")}</div>
            <div />
          </div>

          {shown.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-[11px] text-text3">
              {t("history.noResults")}
            </div>
          ) : (
            shown.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                isCurrent={s.id === wizardSessionId}
                canReopen={s.status === "done" || s.status === "cancelled"}
                lang={lang}
                onView={() => go("w4")}
                onReview={() => void reopen(s.id, "w5")}
                onExport={() => void reopen(s.id, "w6")}
                onExportSession={() => void handleExportSession(s)}
                onRetry={() => {
                  if (resumeSession(s.id)) go("w1");
                }}
                onDelete={() => setConfirmId(s.id)}
              />
            ))
          )}

          <div className="flex items-center justify-between border-t border-line2 bg-hover px-4 py-2.5">
            <div className="font-mono text-[11px] text-text3">
              {totalCost > 0
                ? t("history.footer.summaryWithCost", {
                    count: formatInt(filtered.length),
                    cost: formatUsd(totalCost),
                  })
                : t("history.footer.summary", { count: formatInt(filtered.length) })}
            </div>
            {filtered.length > visible && (
              <button
                className="font-mono text-[11px] text-text3 hover:text-text"
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
              >
                {t("history.footer.more")}
              </button>
            )}
          </div>
        </div>
      )}

      {confirmTarget !== undefined && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setConfirmId(null)}
        >
          <div
            className="w-[380px] border border-line2 bg-raised p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[14px] font-bold text-text">{t("history.confirm.title")}</div>
            <p className="m-0 mb-5 text-[12px] leading-relaxed text-text2">
              {t("history.confirm.body", { name: confirmTarget.modpackName })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="border border-edge px-3.5 py-2 text-[12px] font-semibold text-text2 hover:border-edge2 hover:text-text"
                onClick={() => setConfirmId(null)}
              >
                {t("common.action.cancel")}
              </button>
              <button
                className="bg-red px-3.5 py-2 text-[12px] font-bold text-[#0A100D] hover:bg-[#f58585]"
                onClick={() => {
                  const id = confirmTarget.id;
                  const jobId = useSessionJobs.getState().jobs[id] ?? id;
                  remove(id);
                  useSessionJobs.getState().unregister(id);
                  // Drop the .moru file too, or the engine keeps serving a
                  // session the history screen no longer lists.
                  void api.deleteSession(jobId).catch(() => undefined);
                  setConfirmId(null);
                }}
              >
                {t("common.action.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
