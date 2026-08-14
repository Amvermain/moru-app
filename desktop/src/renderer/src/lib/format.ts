/** Number/duration/cost formatting shared across screens. */

export function formatInt(n?: number | null): string {
  if (n === null || n === undefined || isNaN(n)) return "0";
  return n.toLocaleString("en-US");
}

/** Completed units per second since the measured stage began. */
export function ratePerSecond(done: number, startedAt: number | null, endedAt: number): number {
  if (done <= 0 || startedAt === null || endedAt <= startedAt) return 0;
  return done / ((endedAt - startedAt) / 1000);
}

/** Linear ETA from a stage-local rate; null until the rate is measurable. */
export function remainingSeconds(total: number, done: number, rate: number): number | null {
  if (total <= 0 || rate <= 0) return null;
  return Math.max(0, (total - done) / rate);
}

/** 2400000 -> "2.4M", 8204 -> "8.2K", 412 -> "412" */
export function formatCompact(n?: number | null): string {
  if (n === null || n === undefined || isNaN(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatInt(n);
}

export function formatUsd(usd?: number | null): string {
  if (usd === null || usd === undefined || isNaN(usd) || usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** seconds -> "4분 22초" | "52초" | "1시간 4분" (ko) or "4m 22s" (en) */
export function formatDuration(totalSeconds?: number | null, locale: "ko" | "en" = "ko"): string {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return locale === "ko" ? "0초" : "0s";
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (locale === "ko") {
    if (h > 0) return `${h}시간 ${m}분`;
    if (m > 0) return `${m}분 ${sec}초`;
    return `${sec}초`;
  }
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function parseTimestamp(ts: number | string | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === "number") return isNaN(ts) ? null : ts;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? null : parsed;
}

/** timestamp -> "2시간 전" / "어제" / "3일 전" / "2026-07-01" */
export function formatRelative(ts: number | string | null | undefined, locale: "ko" | "en"): string {
  const time = parseTimestamp(ts);
  if (time === null) return "—";
  const diff = Date.now() - time;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (locale === "ko") {
    if (minutes < 1) return "방금";
    if (minutes < 60) return `${minutes}분 전`;
    if (hours < 24) return `${hours}시간 전`;
    if (days === 1) return "어제";
    if (days < 14) return `${days}일 전`;
  } else {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return "yesterday";
    if (days < 14) return `${days}d ago`;
  }
  try {
    const d = new Date(time);
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().slice(0, 10);
  } catch {
    return "—";
  }
}

/** "Enigmatica 9" -> "E9", "Create: Astral" -> "CA", "All the Mods 10" -> "A10" */
export function packInitials(name?: string | null): string {
  if (!name) return "??";
  const words = name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const first = words[0].charAt(0).toUpperCase();
  const last = words.at(-1) ?? "";
  const lastToken = /^\d+$/.test(last) ? last : last.charAt(0).toUpperCase();
  return `${first}${lastToken}`;
}
