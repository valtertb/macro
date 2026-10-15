import { INDICATORS, SYMBOLS } from "./config.ts";
import { getSeries, lastSnapshot, saveSnapshot, setMeta, upcomingCalendar } from "./db.ts";
import type { Db } from "./db.ts";
import { ingestAll } from "./ingest.ts";
import type { IngestDeps, IngestReport } from "./ingest.ts";
import { computeBias, prepare } from "./scoring/engine.ts";
import { explain } from "./scoring/explain.ts";
import type { Data } from "./types.ts";

export function loadData(db: Db): Data {
  const data: Data = {};
  for (const d of INDICATORS) {
    if (d.provider === "DERIVED") continue;
    const s = getSeries(db, d.code);
    if (s.length) data[d.code] = s;
  }
  return data;
}

export interface ScoreRun {
  stored: Record<string, boolean>; // true when a new snapshot was written
}

/** Re-scores all assets from stored observations. A snapshot is written only when inputs changed (or forced). */
export function scoreAll(db: Db, now: Date = new Date(), force = false): ScoreRun {
  const prep = prepare(loadData(db), now);
  const today = now.toISOString().slice(0, 10);
  const cal = upcomingCalendar(db, today, 14).slice(0, 8);
  const stored: Record<string, boolean> = {};
  for (const symbol of SYMBOLS) {
    const prev = lastSnapshot(db, symbol);
    const bias = computeBias(symbol, prep, now, prev?.classification ?? null);
    const unchanged = prev && prev.input_hash === bias.inputHash && prev.payload?.bias?.status === bias.status && !force;
    if (unchanged) { stored[symbol] = false; continue; }
    const explanation = explain(bias, cal);
    saveSnapshot(db, bias, { bias, explanation });
    stored[symbol] = true;
  }
  setMeta(db, "last_scored_at", now.toISOString());
  return { stored };
}

export async function refreshAll(db: Db, env: Record<string, string | undefined>, opts: { now?: Date; force?: boolean; deps?: IngestDeps } = {}): Promise<{ ingest: IngestReport; score: ScoreRun }> {
  const now = opts.now ?? new Date();
  const ingest = await ingestAll(db, env, now, opts.deps);
  setMeta(db, "last_refresh_at", now.toISOString());
  const score = scoreAll(db, now, opts.force ?? false);
  return { ingest, score };
}
