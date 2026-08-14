/**
 * W5 - Review. Entry table with filter chips, pagination, client search,
 * detail panel with placeholder-token highlighting, inline edit + retranslate,
 * and a Minecraft §-color preview.
 */

import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Entry, EntryStatus } from "../../../shared/engine";
import { api } from "@/lib/api";
import { moru } from "@/lib/bridge";
import { formatInt } from "@/lib/format";
import { modelDisplayName } from "@/lib/models";
import { useRouter } from "@/stores/router";
import { useSettings } from "@/stores/settings";
import { useSessionJobs, useWizard } from "@/stores/wizard";

const PAGE_SIZE = 100;

/** One entry's identity. A key is only unique within its own source file. */
interface EntryRef {
  key: string;
  file: string;
}

type EntryFilter = "all" | "failed" | "warning" | "modified";
const FILTERS: readonly EntryFilter[] = ["all", "failed", "warning", "modified"];

/* ---- status presentation -------------------------------------------- */

const STATUS_COLOR: Record<EntryStatus, string> = {
  passed: "#3DDC84",
  warning: "#F5B454",
  failed: "#F26B6B",
  modified: "#6BB3F5",
  tm_hit: "#A78BFA",
  skipped: "#6A7C74",
};

const FILTER_COLOR: Record<EntryFilter, string> = {
  all: "#3DDC84",
  failed: "#F26B6B",
  warning: "#F5B454",
  modified: "#6BB3F5",
};

function StatusIcon({ status, size = 12 }: { status: EntryStatus; size?: number }): ReactNode {
  const s = size - 4;
  let glyph: ReactNode;
  switch (status) {
    case "failed":
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" fill="none" stroke="#0A100D" strokeWidth="2">
          <path d="M2 2 L6 6 M6 2 L2 6" />
        </svg>
      );
      break;
    case "warning":
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" shapeRendering="crispEdges">
          <rect x="3" y="1" width="2" height="4" fill="#0A100D" />
          <rect x="3" y="6" width="2" height="1" fill="#0A100D" />
        </svg>
      );
      break;
    case "modified":
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" fill="none" stroke="#0A100D" strokeWidth="1.5">
          <path d="M1 6 L5 2 L7 4 L3 8 Z" fill="#0A100D" />
        </svg>
      );
      break;
    case "tm_hit":
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" shapeRendering="crispEdges">
          <rect x="1" y="1" width="6" height="2" fill="#0A100D" />
          <rect x="1" y="5" width="6" height="2" fill="#0A100D" />
        </svg>
      );
      break;
    case "skipped":
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" shapeRendering="crispEdges">
          <rect x="1" y="3" width="6" height="2" fill="#0A100D" />
        </svg>
      );
      break;
    default:
      glyph = (
        <svg width={s} height={s} viewBox="0 0 8 8" fill="none" stroke="#0A100D" strokeWidth="2">
          <path d="M1 4 L3 6 L7 2" />
        </svg>
      );
  }
  return (
    <div
      className="flex items-center justify-center"
      style={{ width: size, height: size, background: STATUS_COLOR[status] }}
    >
      {glyph}
    </div>
  );
}

/* ---- placeholder token highlighting ---------------------------------- */

const TOKEN_SRC = String.raw`\{\{[^{}]*\}\}|\{[^{}]*\}|<[^<>]+>|%(?:\d+\$)?[A-Za-z]|§.|\\n`;
const TOKEN_SPLIT = new RegExp(`(${TOKEN_SRC})`, "g");
const TOKEN_EXACT = new RegExp(`^(?:${TOKEN_SRC})$`);

/** accent -> blue -> purple -> amber, cycling; same token = same color. */
const TOKEN_PALETTE = [
  { color: "#3DDC84", bg: "rgba(61,220,132,0.15)", border: "rgba(61,220,132,0.3)" },
  { color: "#6BB3F5", bg: "rgba(107,179,245,0.15)", border: "rgba(107,179,245,0.3)" },
  { color: "#A78BFA", bg: "rgba(167,139,250,0.15)", border: "rgba(167,139,250,0.3)" },
  { color: "#F5B454", bg: "rgba(245,180,84,0.15)", border: "rgba(245,180,84,0.3)" },
];

function tokenColorMap(...texts: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const text of texts) {
    for (const part of text.split(TOKEN_SPLIT)) {
      if (part !== "" && TOKEN_EXACT.test(part) && !map.has(part)) {
        map.set(part, map.size % TOKEN_PALETTE.length);
      }
    }
  }
  return map;
}

function TokenText({ text, colors }: { text: string; colors: Map<string, number> }): ReactNode {
  const parts = text.split(TOKEN_SPLIT).filter((p) => p !== "");
  return (
    <>
      {parts.map((part, i) => {
        const idx = TOKEN_EXACT.test(part) ? colors.get(part) : undefined;
        if (idx === undefined) return <span key={i}>{part}</span>;
        const p = TOKEN_PALETTE[idx];
        return (
          <span
            key={i}
            className="border px-[3px] font-mono text-[11px]"
            style={{ background: p.bg, color: p.color, borderColor: p.border }}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}

/* ---- Minecraft § color rendering -------------------------------------- */

const MC_COLORS: Record<string, string> = {
  "0": "#000000",
  "1": "#0000AA",
  "2": "#00AA00",
  "3": "#00AAAA",
  "4": "#AA0000",
  "5": "#AA00AA",
  "6": "#FFAA00",
  "7": "#AAAAAA",
  "8": "#555555",
  "9": "#5555FF",
  a: "#55FF55",
  b: "#55FFFF",
  c: "#FF5555",
  d: "#FF55FF",
  e: "#FFFF55",
  f: "#FFFFFF",
};

/** Renders text split on §-codes with approximate Minecraft colors/styles. */
function McText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(§.)/);
  const spans: ReactNode[] = [];
  let color: string | null = null;
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;
  parts.forEach((part, i) => {
    if (part.length === 2 && part.startsWith("§")) {
      const code = part[1].toLowerCase();
      if (MC_COLORS[code] !== undefined) {
        color = MC_COLORS[code];
        bold = italic = underline = strike = false;
      } else if (code === "l") bold = true;
      else if (code === "o") italic = true;
      else if (code === "n") underline = true;
      else if (code === "m") strike = true;
      else if (code === "r") {
        color = null;
        bold = italic = underline = strike = false;
      }
      return;
    }
    if (part === "") return;
    const deco = [underline ? "underline" : null, strike ? "line-through" : null]
      .filter((d) => d !== null)
      .join(" ");
    spans.push(
      <span
        key={i}
        style={{
          color: color ?? undefined,
          fontWeight: bold ? 700 : undefined,
          fontStyle: italic ? "italic" : undefined,
          textDecoration: deco === "" ? undefined : deco,
        }}
      >
        {part}
      </span>,
    );
  });
  return <>{spans}</>;
}

/* ---- small pieces ------------------------------------------------------ */

function SummaryBox({
  value,
  label,
  color,
  alert,
}: {
  value: string;
  label: string;
  color: string;
  alert?: boolean;
}): ReactNode {
  return (
    <div
      className={`min-w-[90px] border bg-raised px-[14px] py-[10px] text-center ${alert === true ? "border-red" : "border-line2"}`}
    >
      <div className="font-mono text-[20px] font-bold tracking-[-0.02em]" style={{ color }}>
        {value}
      </div>
      <div className="mt-[2px] font-mono text-[10px] text-text3">{label}</div>
    </div>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---- screen ------------------------------------------------------------ */

export function W5Review() {
  const { t } = useTranslation();
  const go = useRouter((s) => s.go);
  const sessionId = useWizard((s) => s.sessionId);
  const modpackName = useWizard((s) => s.modpackName);
  const translateJobId = useWizard((s) => s.translateJobId);
  const failedKeys = useWizard((s) => s.failedKeys);
  const stats = useWizard((s) => s.stats);
  const scanState = useWizard((s) => s.scanState);
  const sourceLocale = useWizard((s) => s.sourceLocale);
  const targetLocale = useWizard((s) => s.targetLocale);
  const settingsModel = useSettings((s) => s.model);
  const model = useWizard((s) => s.model) ?? settingsModel;
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<EntryFilter>("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Debounced copy of `search`; drives the query so typing stays snappy.
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [colorPreview, setColorPreview] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Search runs on the engine so it spans the whole result set. Filtering
  // `entries` here would only ever see the PAGE_SIZE rows already fetched.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);

  // A narrowed result set renumbers pages; page 7 of the old set is
  // meaningless against the new one.
  useEffect(() => {
    setPage(1);
    setSelectedKey(null);
  }, [query]);

  const pageQuery = useQuery({
    queryKey: ["w5", translateJobId, "entries", filter, page, query],
    queryFn: () => api.entries(translateJobId as string, filter, page, PAGE_SIZE, query),
    enabled: translateJobId !== null,
    placeholderData: keepPreviousData,
  });

  const countQueries = useQueries({
    queries: FILTERS.map((f) => ({
      queryKey: ["w5", translateJobId, "count", f, query],
      queryFn: () => api.entries(translateJobId as string, f, 1, 1, query),
      enabled: translateJobId !== null,
      placeholderData: keepPreviousData,
    })),
  });
  const counts = useMemo(() => {
    const map = {} as Record<EntryFilter, number | null>;
    FILTERS.forEach((f, i) => {
      map[f] = countQueries[i].data?.total ?? null;
    });
    return map;
  }, [countQueries]);

  const entries = pageQuery.data?.entries ?? [];
  const total = pageQuery.data?.total ?? 0;

  // Already filtered server-side by `query`; nothing left to narrow here.
  const rows = entries;

  const selected: Entry | null =
    rows.find((e) => `${e.file}:${e.key}` === selectedKey) ??
    rows[0] ??
    null;

  useEffect(() => {
    setDraft(selected?.translated_text ?? "");
    setActionError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.file, selected?.key, selected?.translated_text]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["w5", translateJobId] });
  };

  // Mutations carry file + key: the same key can live in two source files,
  // and the engine would otherwise patch whichever one it finds first.
  const patchMut = useMutation({
    mutationFn: ({ key, file, text }: EntryRef & { text: string }) =>
      api.patchEntry(translateJobId as string, key, text, file),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(errorText(err)),
  });

  const retransMut = useMutation({
    mutationFn: ({ key, file }: EntryRef) =>
      api.retranslateEntry(translateJobId as string, key, file),
    onSuccess: (entry) => {
      setActionError(null);
      setDraft(entry.translated_text);
      invalidate();
    },
    onError: (err) => setActionError(errorText(err)),
  });

  const bulkMut = useMutation({
    mutationFn: async (refs: EntryRef[]) => {
      for (const ref of refs) {
        await api.retranslateEntry(translateJobId as string, ref.key, ref.file);
      }
    },
    onError: (err) => setActionError(errorText(err)),
    onSettled: () => invalidate(),
  });

  const failedTotal = counts.failed ?? Object.keys(failedKeys).length;
  const allTotal = counts.all ?? stats?.total_entries ?? null;
  const passRate =
    stats !== null
      ? stats.quality_score * 100 // engine quality_score is a 0..1 ratio
      : allTotal !== null && allTotal > 0
        ? ((allTotal - failedTotal) / allTotal) * 100
        : null;

  const moveSelection = (delta: number): void => {
    if (rows.length === 0) return;
    const idx =
      selected === null
        ? 0
        : rows.findIndex((e) => e.file === selected.file && e.key === selected.key);
    const next = Math.min(rows.length - 1, Math.max(0, idx + delta));
    const entryId = `${rows[next].file}:${rows[next].key}`;
    setSelectedKey(entryId);
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(entryId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        editRef.current?.focus();
      } else if ((e.key === "r" || e.key === "R") && selected !== null && !retransMut.isPending) {
        e.preventDefault();
        retransMut.mutate({ key: selected.key, file: selected.file });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const statusLabel = (s: EntryStatus): string => {
    switch (s) {
      case "passed":
        return t("common.status.passed");
      case "warning":
        return t("common.status.warning");
      case "failed":
        return t("common.status.failed");
      case "modified":
        return t("common.status.modified");
      case "tm_hit":
        return t("common.status.tmHit");
      default:
        return t("common.status.skipped");
    }
  };

  const stepHeader = (
    <div className="mb-2 flex items-center gap-[10px] font-mono text-[11px] font-semibold tracking-[0.08em] text-text3 uppercase">
      <span className="text-accent">05</span>
      <span>{t("common.wizard.step5")}</span>
      <div
        className="h-px flex-1"
        style={{
          backgroundImage: "linear-gradient(90deg, #24322B 50%, transparent 50%)",
          backgroundSize: "6px 1px",
        }}
      />
    </div>
  );

  /* ---- empty state: no translate job yet ---- */
  if (translateJobId === null) {
    return (
      <div className="animate-fade-in-up px-10 py-[28px]">
        {stepHeader}
        <div
          className="flex flex-col items-center justify-center gap-2 border border-line2 bg-raised py-20"
          style={{
            backgroundImage: "radial-gradient(#1A231F 1px, transparent 1px)",
            backgroundSize: "12px 12px",
          }}
        >
          <h2 className="m-0 text-[18px] font-bold text-text">{t("w5.empty.title")}</h2>
          <p className="m-0 text-[13px] text-text2">{t("w5.empty.desc")}</p>
          <button
            onClick={() => go(scanState === "done" ? "w4" : "w1")}
            className="mt-3 bg-accent px-5 py-[10px] text-[13px] font-bold text-[#0A100D] hover:bg-accent-hi"
          >
            {t("w5.empty.cta")}
          </button>
        </div>
      </div>
    );
  }

  const failedOnPage: EntryRef[] = rows
    .filter((e) => e.status === "failed")
    .map((e) => ({ key: e.key, file: e.file }));
  const remaining = Math.max(0, total - page * PAGE_SIZE);
  const selColor = selected === null ? "#6A7C74" : STATUS_COLOR[selected.status];
  const detailColors =
    selected === null
      ? new Map<string, number>()
      : tokenColorMap(selected.source_text, selected.translated_text);

  const chip = (f: EntryFilter): ReactNode => {
    const c = FILTER_COLOR[f];
    const active = filter === f;
    const count = counts[f];
    return (
      <button
        key={f}
        onClick={() => {
          setFilter(f);
          setPage(1);
          setSelectedKey(null);
        }}
        className={`flex items-center gap-1 border px-[10px] py-[6px] text-[11px] font-semibold ${
          active ? "" : "border-edge text-text2 hover:border-edge2 hover:text-text"
        }`}
        style={active ? { background: `${c}14`, borderColor: c, color: c } : undefined}
      >
        <div className="h-[5px] w-[5px]" style={{ background: c }} />
        {t(`w5.filter.${f}`)}
        {count !== null ? ` ${formatInt(count)}` : ""}
      </button>
    );
  };

  const handleExportSession = async (): Promise<void> => {
    const targetId = (translateJobId ?? (sessionId ? useSessionJobs.getState().jobs[sessionId] : null)) ?? sessionId;
    if (!targetId) return;
    const name = (modpackName || "modpack").replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
    const savePath = await moru.saveFile(`${name}_session.moru`);
    if (!savePath) return;
    try {
      await api.exportSession(targetId, savePath);
      setActionError(null);
    } catch (err) {
      console.error("Failed to export session:", err);
      setActionError(errorText(err));
    }
  };

  return (
    <div className="animate-fade-in-up px-10 py-[28px]">
      {stepHeader}

      {/* Header + summary */}
      <div className="mb-5 flex items-end justify-between gap-6">
        <div>
          <h1 className="m-0 mb-1 text-[24px] font-bold tracking-[-0.02em] text-text">
            {t("w5.title")}
          </h1>
          <p className="m-0 text-[13px] text-text2">{t("w5.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <SummaryBox
            value={passRate !== null ? `${passRate.toFixed(1)}%` : "—"}
            label={t("w5.summary.passRate")}
            color="#3DDC84"
          />
          <SummaryBox
            value={counts.warning !== null ? formatInt(counts.warning) : "—"}
            label={t("w5.summary.warnings")}
            color="#F5B454"
          />
          <SummaryBox
            value={formatInt(failedTotal)}
            label={t("w5.summary.failed")}
            color="#F26B6B"
            alert={failedTotal > 0}
          />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border border-b-0 border-line2 bg-raised px-[14px] py-[10px]">
        <div className="flex max-w-[320px] flex-1 items-center gap-[6px] border border-edge bg-card px-[10px] py-[6px]">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#6A7C74" strokeWidth="1.5">
            <circle cx="5" cy="5" r="3.5" />
            <path d="M8 8 L11 11" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("w5.searchPlaceholder")}
            className="flex-1 font-mono text-[12px] text-text placeholder:text-text4"
          />
          <span className="bg-bar px-1 py-px font-mono text-[10px] text-text4">⌘F</span>
        </div>
        <div className="mx-1 h-5 w-px bg-edge" />
        {FILTERS.map((f) => chip(f))}
        <div className="mx-1 h-5 w-px bg-edge" />
        <button
          onClick={() => setColorPreview((v) => !v)}
          className={`flex items-center gap-[6px] border px-[10px] py-[6px] text-[11px] font-semibold ${
            colorPreview
              ? "border-accent bg-[rgba(61,220,132,0.08)] text-accent"
              : "border-edge text-text2 hover:border-edge2 hover:text-text"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges">
            <rect x="1" y="2" width="10" height="2" fill="currentColor" />
            <rect x="1" y="5" width="10" height="2" fill="currentColor" />
            <rect x="1" y="8" width="6" height="2" fill="currentColor" />
          </svg>
          {t("w5.colorPreview")}
        </button>
        <div className="flex-1" />
        <button
          onClick={() => bulkMut.mutate(failedOnPage)}
          disabled={failedOnPage.length === 0 || bulkMut.isPending}
          className="flex items-center gap-[6px] border border-edge px-3 py-[6px] text-[11px] font-semibold text-text2 hover:border-edge2 hover:text-text disabled:cursor-default disabled:opacity-50"
        >
          {bulkMut.isPending ? (
            <span className="inline-block h-3.5 w-3.5 animate-pxspin border-2 border-accent border-t-transparent" />
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 6 A5 5 0 0 1 11 6 L9 6" />
              <path d="M11 6 L9 4 M11 6 L9 8" />
            </svg>
          )}
          {t("w5.bulkRetranslate")}
        </button>
      </div>

      {/* 2-col: table + detail */}
      <div className="grid grid-cols-[1fr_400px] border border-t-0 border-line2 bg-raised">
        {/* Table */}
        <div className="border-r border-line2">
          <div className="grid grid-cols-[20px_200px_1fr_1fr_80px] gap-[10px] border-b border-line2 bg-hover px-[14px] py-2 font-mono text-[10px] font-bold tracking-[0.06em] text-text3 uppercase">
            <div />
            <div>{t("w5.col.key")}</div>
            <div>{t("w5.col.source")}</div>
            <div>{t("w5.col.translation")}</div>
            <div className="text-right">{t("w5.col.status")}</div>
          </div>

          <div ref={listRef} className="max-h-[480px] overflow-y-auto">
            {pageQuery.isPending ? (
              Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[20px_200px_1fr_1fr_80px] gap-[10px] border-b border-line px-[14px] py-[10px]"
                >
                  <div className="h-3 w-3 animate-pxpulse bg-hover" />
                  <div className="h-3 animate-pxpulse bg-hover" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
                  <div className="h-3 animate-pxpulse bg-hover" style={{ width: `${45 + ((i * 23) % 50)}%` }} />
                  <div className="h-3 animate-pxpulse bg-hover" style={{ width: `${40 + ((i * 31) % 55)}%` }} />
                  <div className="h-3 animate-pxpulse justify-self-end bg-hover" style={{ width: "60%" }} />
                </div>
              ))
            ) : pageQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-[14px] py-12">
                <div className="font-mono text-[12px] text-red">{t("w5.loadError")}</div>
                <div className="max-w-[420px] text-center font-mono text-[11px] text-text3">
                  {errorText(pageQuery.error)}
                </div>
                <button
                  onClick={() => void pageQuery.refetch()}
                  className="border border-red px-3 py-[6px] text-[11px] font-semibold text-red hover:bg-[rgba(242,107,107,0.08)]"
                >
                  {t("common.action.retry")}
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-[14px] py-12 text-center font-mono text-[11px] text-text3">
                {t("w5.noRows")}
              </div>
            ) : (
              <>
                {page > 1 && (
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="w-full px-[14px] py-[10px] text-center font-mono text-[11px] text-text3 hover:bg-raised-hover hover:text-text"
                  >
                    {t("w5.rowsPrev", { n: formatInt(PAGE_SIZE) })}
                  </button>
                )}
                {rows.map((e) => {
                  const c = STATUS_COLOR[e.status];
                  const isSel = selected !== null && selected.key === e.key && selected.file === e.file;
                  return (
                    <div
                      key={`${e.file}:${e.key}`}
                      data-key={`${e.file}:${e.key}`}
                      onClick={() => setSelectedKey(`${e.file}:${e.key}`)}
                      className={`grid cursor-pointer grid-cols-[20px_200px_1fr_1fr_80px] gap-[10px] border-b border-line px-[14px] py-[10px] ${
                        isSel ? "" : "hover:bg-raised-hover"
                      }`}
                      style={
                        isSel
                          ? {
                              background: `linear-gradient(90deg, ${c}0F 0%, transparent 100%)`,
                              borderLeft: `3px solid ${c}`,
                            }
                          : undefined
                      }
                    >
                      <div className="mt-[2px]">
                        <StatusIcon status={e.status} />
                      </div>
                      <div
                        className={`overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap ${
                          isSel ? "text-text" : "text-text2"
                        }`}
                      >
                        {e.key}
                      </div>
                      <div className="text-[12px] leading-[1.4] text-text2">{e.source_text}</div>
                      <div
                        className={`text-[12px] leading-[1.4] ${
                          e.status === "failed" ? "text-red" : "text-text"
                        }`}
                      >
                        {colorPreview ? <McText text={e.translated_text} /> : e.translated_text}
                      </div>
                      <div
                        className="overflow-hidden text-right font-mono text-[10px] font-bold text-ellipsis whitespace-nowrap"
                        style={{ color: c }}
                      >
                        {e.status === "warning" && e.errors.length > 0
                          ? e.errors[0]
                          : statusLabel(e.status)}
                      </div>
                    </div>
                  );
                })}
                {remaining > 0 && (
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    className="w-full px-[14px] py-[10px] text-center font-mono text-[11px] text-text3 hover:bg-raised-hover hover:text-text"
                  >
                    {t("w5.rowsMore", { n: formatInt(remaining) })}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Table footer */}
          <div className="flex items-center justify-between border-t border-line2 bg-hover px-[14px] py-2 font-mono text-[11px] text-text3">
            <div>{t("w5.footerCount", { total: formatInt(total), shown: formatInt(rows.length) })}</div>
            <div className="flex gap-3">
              <span className="text-text4">{t("w5.hintMove")}</span>
              <span className="text-text4">{t("w5.hintEdit")}</span>
              <span className="text-text4">{t("w5.hintRetranslate")}</span>
            </div>
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex max-h-[620px] flex-col gap-[14px] overflow-y-auto p-4">
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center py-16 font-mono text-[11px] text-text3">
              {t("w5.detail.noSelection")}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <StatusIcon status={selected.status} size={14} />
                <span
                  className="overflow-hidden font-mono text-[10px] font-bold tracking-[0.08em] text-ellipsis whitespace-nowrap uppercase"
                  style={{ color: selColor }}
                >
                  {selected.errors.length > 0 ? selected.errors[0] : statusLabel(selected.status)}
                </span>
              </div>
              <div className="border border-edge bg-card px-[10px] py-2 font-mono text-[11px] break-all text-text2">
                {selected.key}
              </div>

              {/* Source with highlights */}
              <div>
                <div className="mb-[6px] font-mono text-[10px] font-bold tracking-[0.06em] text-text3 uppercase">
                  {t("w5.detail.sourceLabel", { lang: (sourceLocale.split("_")[0] ?? sourceLocale).toUpperCase() })}
                </div>
                <div className="border border-edge bg-card p-3 text-[13px] leading-[1.6] break-words text-text [word-break:keep-all]">
                  <TokenText text={selected.source_text} colors={detailColors} />
                </div>
              </div>

              {/* Translation editor */}
              <div>
                <div className="mb-[6px] flex items-center justify-between">
                  <div className="font-mono text-[10px] font-bold tracking-[0.06em] text-text3 uppercase">
                    {t("w5.detail.translationLabel", { lang: (targetLocale.split("_")[0] ?? targetLocale).toUpperCase() })}
                  </div>
                  {selected.errors.length > 0 && (
                    <div
                      className="max-w-[220px] overflow-hidden font-mono text-[10px] text-ellipsis whitespace-nowrap"
                      style={{ color: selected.status === "failed" ? "#F26B6B" : "#F5B454" }}
                    >
                      {selected.errors.join(" · ")}
                    </div>
                  )}
                </div>
                <textarea
                  ref={editRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className={`min-h-[88px] w-full resize-y border bg-card p-3 text-[13px] leading-[1.6] text-text ${
                    selected.status === "failed" ? "border-red" : "border-edge"
                  }`}
                />
              </div>

              {/* § color preview */}
              {colorPreview && (
                <div>
                  <div className="mb-[6px] font-mono text-[10px] font-bold tracking-[0.06em] text-text3 uppercase">
                    {t("w5.detail.preview")}
                  </div>
                  <div className="border border-edge bg-card p-3 text-[13px] leading-[1.6] break-words text-text">
                    <McText text={draft} />
                  </div>
                </div>
              )}

              {/* Validation errors */}
              {selected.errors.length > 0 && (
                <div
                  className="flex flex-col gap-[6px] border px-3 py-[10px]"
                  style={{
                    background: `${selected.status === "failed" ? "#F26B6B" : "#F5B454"}0F`,
                    borderColor: selected.status === "failed" ? "#F26B6B" : "#F5B454",
                  }}
                >
                  {selected.errors.map((err, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-[6px] font-mono text-[11px]"
                      style={{ color: selected.status === "failed" ? "#F26B6B" : "#F5B454" }}
                    >
                      <div
                        className="h-1 w-1 shrink-0"
                        style={{ background: selected.status === "failed" ? "#F26B6B" : "#F5B454" }}
                      />
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="grid grid-cols-2 gap-[6px]">
                <button
                  onClick={() => retransMut.mutate({ key: selected.key, file: selected.file })}
                  disabled={retransMut.isPending}
                  className="flex items-center justify-center gap-[6px] bg-accent p-[10px] text-[12px] font-bold text-[#0A100D] hover:bg-accent-hi disabled:opacity-60"
                >
                  <svg
                    className={retransMut.isPending ? "animate-pxspin" : ""}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M1 6 A5 5 0 0 1 11 6 L9 6" />
                    <path d="M11 6 L9 4 M11 6 L9 8" />
                  </svg>
                  {retransMut.isPending ? t("w5.detail.retranslating") : t("w5.detail.retranslate")}
                </button>
                <button
                  onClick={() =>
                    patchMut.mutate({ key: selected.key, file: selected.file, text: draft })
                  }
                  disabled={patchMut.isPending || draft === selected.translated_text}
                  className="bg-line2 p-[10px] text-[12px] font-semibold text-text hover:bg-edge disabled:opacity-60"
                >
                  {patchMut.isPending ? t("w5.detail.saving") : t("w5.detail.save")}
                </button>
              </div>
              {actionError !== null && (
                <div className="font-mono text-[11px] break-words text-red">{actionError}</div>
              )}

              <div className="my-1 h-px bg-line" />

              {/* Metadata */}
              <div className="flex flex-col gap-[3px] font-mono text-[11px] text-text3">
                <div>
                  <span className="text-text4">{t("w5.detail.file")}</span> {selected.file}
                </div>
                <div>
                  <span className="text-text4">{t("w5.detail.model")}</span> {modelDisplayName(model)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Wizard footer */}
      <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => go("w4")}
            className="flex items-center gap-[6px] px-[18px] py-[10px] text-[13px] font-semibold text-text2 hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2 L4 6 L8 10" />
            </svg>
            {t("common.action.back")}
          </button>
          <button
            onClick={() => void handleExportSession()}
            className="flex items-center gap-[6px] border border-edge bg-card px-3.5 py-[8px] text-[12px] font-semibold text-text2 hover:border-accent hover:text-accent"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 8V2M6 8L3 5M6 8L9 5" />
              <path d="M2 10H10" />
            </svg>
            {t("w5.detail.exportSession")}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {failedTotal > 0 && (
            <span className="font-mono text-[11px] text-amber">
              {t("w5.failedRemain", { n: formatInt(failedTotal) })}
            </span>
          )}
          <button
            onClick={() => go("w6")}
            className="flex items-center gap-[6px] bg-accent px-5 py-[10px] text-[13px] font-bold text-[#0A100D] hover:bg-accent-hi"
          >
            {t("w5.next")}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 2 L8 6 L4 10" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
