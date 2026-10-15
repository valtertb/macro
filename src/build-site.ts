/**
 * Builds the public static site (GitHub Pages):
 *   1. fetches FRED + ECB into an in-memory SQLite DB,
 *   2. scores NQ / Gold / EUR/USD,
 *   3. appends to the committed score history (data/history.json) only when inputs changed,
 *   4. writes site/index.html + site/data/*.json.
 * Raw values of third-party copyrighted series (restricted: true) are stripped from everything published.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDICATORS_BY_CODE, MODEL_VERSION, SYMBOLS, SYMBOL_NAMES } from "./config.ts";
import { openDb, upcomingCalendar } from "./db.ts";
import { ingestAll } from "./ingest.ts";
import type { IngestDeps } from "./ingest.ts";
import { loadData } from "./refresh.ts";
import { computeBias, prepare } from "./scoring/engine.ts";
import { explain } from "./scoring/explain.ts";
import { indicatorStatus } from "./server.ts";
import type { BiasResult, Classification, Symbol } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_HISTORY = 3000;

export interface HistoryPoint {
  calculated_at: string;
  displayed_score: number | null;
  classification: Classification | null;
  confidence: number | null;
  status: string;
  input_hash: string;
  version: string;
}
export type History = Partial<Record<Symbol, HistoryPoint[]>>;

const isRestricted = (code: string) => !!INDICATORS_BY_CODE[code]?.restricted;

/** Removes raw values of restricted series from a bias result (dates stay, so freshness remains visible). */
export function redactBias(b: BiasResult): BiasResult {
  return {
    ...b,
    factors: b.factors.map((f) => ({
      ...f,
      inputs: f.inputs.map((i) => (isRestricted(i.indicator) ? { indicator: i.indicator, date: i.date, kind: i.kind, value: null as unknown as number } : i)),
    })),
  };
}

export async function buildSite(opts: {
  env: Record<string, string | undefined>;
  outDir: string;
  historyPath: string;
  now?: Date;
  deps?: IngestDeps;
}) {
  const now = opts.now ?? new Date();
  const db = openDb(":memory:");
  const ingest = await ingestAll(db, opts.env, now, opts.deps);

  const history: History = existsSync(opts.historyPath) ? JSON.parse(readFileSync(opts.historyPath, "utf8")) : {};
  const prep = prepare(loadData(db), now);
  const cal = upcomingCalendar(db, now.toISOString().slice(0, 10), 14).slice(0, 8);

  const assets = SYMBOLS.map((symbol) => {
    const hist = history[symbol] ?? [];
    const last = hist[hist.length - 1];
    const bias = computeBias(symbol, prep, now, last?.classification ?? null);
    const explanation = explain(bias, cal);
    const changed = !last || last.input_hash !== bias.inputHash || last.status !== bias.status || last.version !== bias.version;
    if (changed) {
      hist.push({
        calculated_at: bias.calculatedAt,
        displayed_score: bias.displayedScore,
        classification: bias.classification,
        confidence: bias.confidence,
        status: bias.status,
        input_hash: bias.inputHash,
        version: bias.version,
      });
      history[symbol] = hist.slice(-MAX_HISTORY);
    }
    return { symbol, name: SYMBOL_NAMES[symbol], bias: redactBias(bias), explanation, lastSnapshotAt: (history[symbol] ?? []).at(-1)?.calculated_at ?? null };
  });

  const generatedAt = now.toISOString();
  const data = join(opts.outDir, "data");
  mkdirSync(data, { recursive: true });
  mkdirSync(dirname(opts.historyPath), { recursive: true });
  writeFileSync(opts.historyPath, JSON.stringify(history, null, 1) + "\n");

  const write = (name: string, v: unknown) => writeFileSync(join(data, name), JSON.stringify(v));
  write("current.json", {
    generatedAt, version: MODEL_VERSION, lastRefreshAt: generatedAt,
    fredConfigured: !!opts.env.FRED_API_KEY?.trim(),
    dataMode: "daily-and-monthly-public-data (nie real-time)",
    assets,
  });
  for (const s of SYMBOLS) {
    write(`history-${s}.json`, { symbol: s, version: MODEL_VERSION, points: (history[s] ?? []).map(({ input_hash, version, ...p }) => p) });
  }
  write("status.json", {
    generatedAt,
    providers: Object.entries(ingest.providers).map(([provider, health]) => ({ provider, health, last_attempt_at: generatedAt })),
    indicators: indicatorStatus(db, now).map((i) => (i.restricted ? { ...i, lastValue: null } : i)),
    events: db.prepare("SELECT severity, component, message, occurred_at FROM system_events ORDER BY id DESC LIMIT 20").all(),
  });
  write("calendar.json", { generatedAt, events: upcomingCalendar(db, generatedAt.slice(0, 10), 30) });

  const repo = opts.env.GITHUB_REPOSITORY ?? "";
  const html = readFileSync(join(ROOT, "public", "index.html"), "utf8").replace(
    "<!--STATIC-CONFIG-->",
    `<script>window.MB_STATIC = true; window.MB_REPO = ${JSON.stringify(repo)};</script>`,
  );
  writeFileSync(join(opts.outDir, "index.html"), html);
  writeFileSync(join(opts.outDir, ".nojekyll"), "");
  return { ingest, assets, history };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await buildSite({ env: process.env, outDir: join(ROOT, "site"), historyPath: join(ROOT, "data", "history.json") });
  console.log(JSON.stringify({
    ok: r.ingest.ok, failed: r.ingest.failed, skipped: r.ingest.skipped, providers: r.ingest.providers,
    scores: r.assets.map((a) => [a.symbol, a.bias.status, a.bias.displayedScore, a.bias.confidence]),
  }, null, 2));
}
