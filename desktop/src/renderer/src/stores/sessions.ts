/**
 * Persisted translation session history. The engine's JobManager is
 * in-memory per run, so the desktop keeps its own durable record of every
 * wizard session - this feeds the home dashboard and the history screen.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { PipelineStats } from "../../../shared/engine";

export type SessionStatus = "running" | "done" | "failed" | "cancelled";

export interface SessionRecord {
  id: string;
  modpackPath: string;
  modpackName: string;
  sourceLocale: string;
  targetLocale: string;
  model: string;
  status: SessionStatus;
  createdAt: number;
  finishedAt: number | null;
  /** live counters while running; final stats when done */
  doneEntries: number;
  totalEntries: number;
  stats: PipelineStats | null;
  error: string | null;
  exportZipPath: string | null;
  exportOverridesZipPath: string | null;
  sharedUrl: string | null;
}

interface SessionsStore {
  sessions: SessionRecord[];
  upsert: (record: SessionRecord) => void;
  patch: (id: string, patch: Partial<SessionRecord>) => void;
  remove: (id: string) => void;
}

export const useSessions = create<SessionsStore>()(
  persist(
    (set) => ({
      sessions: [],
      upsert: (record) =>
        set((state) => ({
          sessions: [record, ...state.sessions.filter((s) => s.id !== record.id)],
        })),
      patch: (id, patch) =>
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        })),
      remove: (id) => set((state) => ({ sessions: state.sessions.filter((s) => s.id !== id) })),
    }),
    {
      name: "moru-sessions",
      version: 2,
      // Records persisted by older builds may miss later-added fields
      // (undefined breaks the `=== null` checks the UI relies on).
      migrate: (persisted) => {
        const state = persisted as SessionsStore;
        return {
          ...state,
          sessions: (state.sessions ?? []).map((s) => ({
            ...s,
            doneEntries: s.doneEntries ?? 0,
            totalEntries: s.totalEntries ?? 0,
            stats: s.stats ?? null,
            error: s.error ?? null,
            exportZipPath: s.exportZipPath ?? null,
            exportOverridesZipPath: s.exportOverridesZipPath ?? null,
            sharedUrl: s.sharedUrl ?? null,
          })),
        };
      },
    },
  ),
);

/** Aggregates for the home dashboard stat strip. */
export function aggregateStats(sessions: SessionRecord[]): {
  totalTranslated: number;
  translatedThisWeek: number;
  tmHits: number;
  completedPacks: number;
  sharedPacks: number;
} {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  let totalTranslated = 0;
  let translatedThisWeek = 0;
  let tmHits = 0;
  let completedPacks = 0;
  let sharedPacks = 0;
  for (const s of sessions) {
    const translated = s.stats?.translated_entries ?? 0;
    totalTranslated += translated;
    if ((s.finishedAt ?? s.createdAt) >= weekAgo) translatedThisWeek += translated;
    tmHits += s.stats?.tm_hits ?? 0;
    if (s.status === "done") completedPacks += 1;
    if (s.sharedUrl !== null) sharedPacks += 1;
  }
  return { totalTranslated, translatedThisWeek, tmHits, completedPacks, sharedPacks };
}
