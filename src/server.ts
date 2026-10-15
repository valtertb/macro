import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDICATORS, MODEL, MODEL_VERSION, SYMBOLS, SYMBOL_NAMES } from "./config.ts";
import { getMeta, history, lastObsProvider, lastSnapshot, openDb, upcomingCalendar } from "./db.ts";
import type { Db } from "./db.ts";
import { freshnessOf, ageDays } from "./scoring/signals.ts";
import { computeBias, prepare } from "./scoring/engine.ts";
import { explain } from "./scoring/explain.ts";
import { loadCot } from "./cot.ts";
import { bratislavaDate, sessionBias } from "./session.ts";
import type { CotFetcher, CotResult } from "./cot.ts";
import type { IngestDeps } from "./ingest.ts";
import { loadData, refreshAll } from "./refresh.ts";
import type { Symbol } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function parseSymbol(s: string): Symbol | null {
  const u = s.toUpperCase().replace("/", "").replace("-", "");
  if (u === "NQ") return "NQ";
  if (u === "GC" || u === "GOLD" || u === "XAU") return "GC";
  if (u === "EURUSD") return "EURUSD";
  return null;
}

export function liveBias(db: Db, now: Date) {
  const prep = prepare(loadData(db), now);
  const cal = upcomingCalendar(db, now.toISOString().slice(0, 10), 14).slice(0, 8);
  return SYMBOLS.map((symbol) => {
    const prev = lastSnapshot(db, symbol);
    const bias = computeBias(symbol, prep, now, prev?.classification ?? null);
    return { symbol, name: SYMBOL_NAMES[symbol], bias, explanation: explain(bias, cal), lastSnapshotAt: prev?.calculated_at ?? null };
  });
}

export function indicatorStatus(db: Db, now: Date) {
  const data = loadData(db);
  const stat = new Map((db.prepare("SELECT * FROM indicator_status").all() as any[]).map((r) => [r.indicator, r]));
  return INDICATORS.filter((i) => i.provider !== "DERIVED").map((def) => {
    const s = data[def.code];
    const last = s?.[s.length - 1] ?? null;
    const st = stat.get(def.code);
    const fr = last ? freshnessOf(def.code, last.date, now) : 0;
    return {
      code: def.code, name: def.name, provider: def.provider, frequency: def.frequency, unit: def.unit, scoring: def.scoring, restricted: !!def.restricted,
      ref: getMeta(db, `ref:${def.code}`) ?? def.ref, note: def.note ?? null, lastSource: lastObsProvider(db, def.code),
      lastDate: last?.date ?? null, lastValue: last?.value ?? null, ageDays: last ? ageDays(last.date, now) : null,
      state: !last ? "missing" : fr >= 1 ? "ok" : fr > 0 ? "stale" : "expired",
      lastAttemptAt: st?.last_attempt_at ?? null, lastSuccessAt: st?.last_success_at ?? null, lastError: st?.last_error ?? null,
    };
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function createApp(db: Db, env: Record<string, string | undefined>, port: number, deps?: IngestDeps, cotFetcher?: CotFetcher) {
  let refreshing: Promise<unknown> | null = null;
  // COT is weekly: cache it for 1 hour (and reload on manual refresh).
  let cot: { at: number; data: Promise<CotResult> } | null = null;
  const getCot = (fresh = false) => {
    if (fresh || !cot || Date.now() - cot.at > 3_600_000) cot = { at: Date.now(), data: loadCot(new Date(), cotFetcher) };
    return cot.data;
  };
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  async function runRefresh(force: boolean) {
    if (refreshing) return refreshing; // one refresh at a time
    if (force) void getCot(true);
    refreshing = refreshAll(db, env, { force, deps }).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function handler(req: IncomingMessage, res: ServerResponse) {
    try {
      // DNS-rebinding guard: the app is local-only.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Zakázaný host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const path = url.pathname;
      const now = new Date();

      if (req.method === "GET" && path === "/") {
        return send(res, 200, readFileSync(join(ROOT, "public", "index.html"), "utf8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && path === "/api/bias/current") {
        const assets = liveBias(db, now);
        return send(res, 200, {
          generatedAt: now.toISOString(), version: MODEL_VERSION,
          lastRefreshAt: getMeta(db, "last_refresh_at"), fredConfigured: !!env.FRED_API_KEY?.trim(),
          dataMode: "daily-and-monthly-public-data (nie real-time)",
          session: sessionBias(assets, (await getCot()).markets, upcomingCalendar(db, bratislavaDate(now), 1), now),
          assets,
        });
      }
      const h = path.match(/^\/api\/bias\/([^/]+)\/history$/);
      if (req.method === "GET" && h) {
        const sym = parseSymbol(decodeURIComponent(h[1]));
        if (!sym) return send(res, 400, { error: "Neznámy symbol" });
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 1), 1000);
        return send(res, 200, { symbol: sym, version: MODEL_VERSION, points: history(db, sym, limit) });
      }
      if (req.method === "GET" && path === "/api/providers/status") {
        return send(res, 200, {
          generatedAt: now.toISOString(),
          providers: db.prepare("SELECT * FROM provider_status ORDER BY provider").all(),
          indicators: indicatorStatus(db, now),
          events: db.prepare("SELECT severity, component, message, occurred_at FROM system_events ORDER BY id DESC LIMIT 20").all(),
        });
      }
      if (req.method === "GET" && path === "/api/calendar/upcoming") {
        return send(res, 200, { generatedAt: now.toISOString(), events: upcomingCalendar(db, now.toISOString().slice(0, 10), 30) });
      }
      if (req.method === "GET" && path === "/api/cot") {
        return send(res, 200, await getCot());
      }
      if (req.method === "GET" && path === "/api/model") {
        return send(res, 200, { version: MODEL_VERSION, params: MODEL });
      }
      if (req.method === "POST" && path === "/api/refresh") {
        if (req.headers["x-requested-with"] !== "macro-bias") return send(res, 403, { error: "Chýba hlavička X-Requested-With" });
        const r = (await runRefresh(true)) as Awaited<ReturnType<typeof refreshAll>>;
        return send(res, 200, { ok: true, ingest: r.ingest, stored: r.score.stored });
      }
      return send(res, 404, { error: "Nenájdené" });
    } catch (e) {
      console.error("Chyba požiadavky:", e instanceof Error ? e.message : e);
      return send(res, 500, { error: "Interná chyba servera" });
    }
  }

  return { handler, runRefresh };
}

/** Scheduler: refresh hourly, more often on days with a scheduled data release or central-bank decision. */
export function startScheduler(db: Db, runRefresh: (force: boolean) => Promise<unknown>, env: Record<string, string | undefined>) {
  const normal = Math.max(parseInt(env.REFRESH_MINUTES ?? "60", 10) || 60, 5) * 60_000;
  const release = Math.max(parseInt(env.RELEASE_DAY_REFRESH_MINUTES ?? "15", 10) || 15, 5) * 60_000;
  const tick = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const isReleaseDay = upcomingCalendar(db, today, 0).length > 0;
    const last = Date.parse(getMeta(db, "last_refresh_at") ?? "1970-01-01T00:00:00Z");
    if (Date.now() - last >= (isReleaseDay ? release : normal)) {
      try { await runRefresh(false); } catch (e) { console.error("Plánovaný refresh zlyhal:", e instanceof Error ? e.message : e); }
    }
  };
  void tick();
  return setInterval(tick, 60_000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const db = openDb(process.env.DB_PATH ?? join(ROOT, "data", "macro.sqlite"));
  const app = createApp(db, process.env, port);
  startScheduler(db, app.runRefresh, process.env);
  createServer(app.handler).listen(port, "127.0.0.1", () => {
    console.log(`MACRO DAILY BIAS TERMINAL beží na http://localhost:${port}`);
    if (!process.env.FRED_API_KEY?.trim()) console.log("UPOZORNENIE: chýba FRED_API_KEY — dáta z USA sa nenačítajú (pozri .env.example).");
  });
}
