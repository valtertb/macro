import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BiasResult, Classification, Obs } from "./types.ts";

export type Db = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS observations (
  indicator    TEXT NOT NULL,
  obs_date     TEXT NOT NULL,
  value        REAL NOT NULL,
  provider     TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (indicator, obs_date)
);

-- Old values are kept when a provider revises a figure (limited vintage trail; not full point-in-time history).
CREATE TABLE IF NOT EXISTS observation_revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator    TEXT NOT NULL,
  obs_date     TEXT NOT NULL,
  old_value    REAL NOT NULL,
  new_value    REAL NOT NULL,
  detected_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indicator_status (
  indicator       TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS provider_status (
  provider        TEXT PRIMARY KEY,
  health          TEXT NOT NULL,
  detail          TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  event_date TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  importance TEXT NOT NULL,
  url        TEXT,
  UNIQUE (source, event_date, name)
);

CREATE TABLE IF NOT EXISTS bias_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  calculated_at   TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  raw_score       REAL,
  displayed_score REAL,
  classification  TEXT,
  confidence      INTEGER,
  coverage        REAL NOT NULL,
  status          TEXT NOT NULL,
  regime          TEXT NOT NULL,
  version         TEXT NOT NULL,
  payload_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_symbol_time ON bias_snapshots(symbol, calculated_at);

CREATE TABLE IF NOT EXISTS factor_scores (
  snapshot_id  INTEGER NOT NULL REFERENCES bias_snapshots(id) ON DELETE CASCADE,
  factor       TEXT NOT NULL,
  weight       REAL NOT NULL,
  z            REAL,
  score        REAL,
  contribution REAL,
  available    INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, factor)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS system_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  severity    TEXT NOT NULL,
  component   TEXT NOT NULL,
  message     TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function upsertObservations(db: Db, code: string, provider: string, obs: Obs[], retrievedAt: string): { inserted: number; revised: number } {
  const sel = db.prepare("SELECT value FROM observations WHERE indicator = ? AND obs_date = ?");
  const ins = db.prepare("INSERT INTO observations (indicator, obs_date, value, provider, retrieved_at) VALUES (?, ?, ?, ?, ?)");
  const upd = db.prepare("UPDATE observations SET value = ?, retrieved_at = ? WHERE indicator = ? AND obs_date = ?");
  const rev = db.prepare("INSERT INTO observation_revisions (indicator, obs_date, old_value, new_value, detected_at) VALUES (?, ?, ?, ?, ?)");
  let inserted = 0;
  let revised = 0;
  tx(db, () => {
    for (const o of obs) {
      const row = sel.get(code, o.date) as { value: number } | undefined;
      if (!row) {
        ins.run(code, o.date, o.value, provider, retrievedAt);
        inserted++;
      } else if (row.value !== o.value) {
        rev.run(code, o.date, row.value, o.value, retrievedAt);
        upd.run(o.value, retrievedAt, code, o.date);
        revised++;
      }
    }
  });
  return { inserted, revised };
}

export function getSeries(db: Db, code: string): Obs[] {
  return (db.prepare("SELECT obs_date AS date, value FROM observations WHERE indicator = ? ORDER BY obs_date ASC").all(code) as unknown as Obs[]);
}

export function lastObsDate(db: Db, code: string): string | null {
  const r = db.prepare("SELECT MAX(obs_date) AS d FROM observations WHERE indicator = ?").get(code) as { d: string | null };
  return r.d;
}

export function setIndicatorStatus(db: Db, code: string, attemptAt: string, error: string | null): void {
  db.prepare(
    `INSERT INTO indicator_status (indicator, last_attempt_at, last_success_at, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT(indicator) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
       last_success_at = CASE WHEN excluded.last_error IS NULL THEN excluded.last_attempt_at ELSE indicator_status.last_success_at END,
       last_error = excluded.last_error`,
  ).run(code, attemptAt, error === null ? attemptAt : null, error);
}

export function setProviderStatus(db: Db, provider: string, health: string, detail: string | null, at: string): void {
  db.prepare(
    `INSERT INTO provider_status (provider, health, detail, last_attempt_at, last_success_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET health = excluded.health, detail = excluded.detail, last_attempt_at = excluded.last_attempt_at,
       last_success_at = CASE WHEN excluded.health = 'ok' THEN excluded.last_attempt_at ELSE provider_status.last_success_at END`,
  ).run(provider, health, detail, at, health === "ok" ? at : null);
}

export function replaceCalendar(db: Db, source: string, events: { date: string; name: string; kind: string; importance: string; url?: string }[]): void {
  tx(db, () => {
    db.prepare("DELETE FROM calendar_events WHERE source = ?").run(source);
    const ins = db.prepare("INSERT OR IGNORE INTO calendar_events (source, event_date, name, kind, importance, url) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of events) ins.run(source, e.date, e.name, e.kind, e.importance, e.url ?? null);
  });
}

export function upcomingCalendar(db: Db, fromDate: string, days: number) {
  const to = new Date(Date.parse(fromDate + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT event_date AS date, name, kind, importance, COALESCE(url, '') AS source, source AS origin FROM calendar_events WHERE event_date >= ? AND event_date <= ? ORDER BY event_date ASC, name ASC")
    .all(fromDate, to) as unknown as { date: string; name: string; kind: string; importance: string; source: string; origin: string }[];
}

export function saveSnapshot(db: Db, b: BiasResult, payload: unknown): number {
  return tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO bias_snapshots (symbol, calculated_at, input_hash, raw_score, displayed_score, classification, confidence, coverage, status, regime, version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.symbol, b.calculatedAt, b.inputHash, b.rawScore, b.displayedScore, b.classification, b.confidence, b.coverage, b.status, b.regime, b.version, JSON.stringify(payload));
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare("INSERT INTO factor_scores (snapshot_id, factor, weight, z, score, contribution, available) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const f of b.factors) ins.run(id, f.code, f.weight, f.z, f.score, f.contribution, f.available ? 1 : 0);
    return id;
  });
}

export function lastSnapshot(db: Db, symbol: string): { id: number; input_hash: string; classification: Classification | null; calculated_at: string; payload: any } | null {
  const r = db.prepare("SELECT id, input_hash, classification, calculated_at, payload_json FROM bias_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT 1").get(symbol) as any;
  return r ? { id: r.id, input_hash: r.input_hash, classification: r.classification, calculated_at: r.calculated_at, payload: JSON.parse(r.payload_json) } : null;
}

export function history(db: Db, symbol: string, limit: number) {
  return db
    .prepare("SELECT calculated_at, displayed_score, classification, confidence, status FROM bias_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?")
    .all(symbol, limit)
    .reverse() as unknown as { calculated_at: string; displayed_score: number | null; classification: string | null; confidence: number | null; status: string }[];
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function logEvent(db: Db, severity: "info" | "warn" | "error", component: string, message: string, at = new Date().toISOString()): void {
  db.prepare("INSERT INTO system_events (severity, component, message, occurred_at) VALUES (?, ?, ?, ?)").run(severity, component, message, at);
}
