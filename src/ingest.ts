import { INDICATORS, STATIC_CALENDAR, WATCHED_RELEASES } from "./config.ts";
import type { IndicatorDef } from "./config.ts";
import { getMeta, insertMissingObservations, lastObsDate, logEvent, setMeta, replaceCalendar, setIndicatorStatus, setProviderStatus, upsertObservations } from "./db.ts";
import type { Db } from "./db.ts";
import { redact } from "./http.ts";
import { fetchEcbSeries } from "./providers/ecb.ts";
import { fetchTreasuryMonth, parseTreasuryXml, recentMonths } from "./providers/treasury.ts";
import type { TreasuryFeed } from "./providers/treasury.ts";
import { fetchFredReleaseDates, fetchFredSeries } from "./providers/fred.ts";
import type { ReleaseDate } from "./providers/fred.ts";
import type { Obs } from "./types.ts";

export interface IngestDeps {
  fetchFred?: (id: string, key: string, start: string) => Promise<Obs[]>;
  fetchEcb?: (def: IndicatorDef, start: string) => Promise<Obs[]>;
  fetchReleases?: (key: string, from: string, to: string) => Promise<ReleaseDate[]>;
  fetchTreasury?: (feed: TreasuryFeed, yyyymm: string) => Promise<string>;
}

export interface IngestReport {
  ok: string[];
  failed: { code: string; error: string }[];
  skipped: string[];
  providers: Record<string, string>;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

function startFor(db: Db, def: IndicatorDef): string {
  const last = lastObsDate(db, def.code);
  if (!last) return def.historyStart;
  // Re-fetch a recent window so provider revisions are detected.
  const back = def.frequency === "monthly" ? 400 : 45;
  const s = addDays(last, -back);
  return s > def.historyStart ? s : def.historyStart;
}

export async function ingestAll(db: Db, env: Record<string, string | undefined>, now: Date = new Date(), deps: IngestDeps = {}): Promise<IngestReport> {
  const at = now.toISOString();
  const fred = deps.fetchFred ?? ((id, key, start) => fetchFredSeries(id, key, start));
  const ecb = deps.fetchEcb ?? ((def, start) => fetchEcbSeries(def.ref, def.frequency, start));
  const releases = deps.fetchReleases ?? ((key, from, to) => fetchFredReleaseDates(key, from, to));
  const report: IngestReport = { ok: [], failed: [], skipped: [], providers: {} };
  const key = env.FRED_API_KEY?.trim();

  const counts: Record<string, { ok: number; fail: number; err?: string }> = { FRED: { ok: 0, fail: 0 }, ECB: { ok: 0, fail: 0 } };

  for (const def of INDICATORS.filter((i) => i.provider !== "DERIVED")) {
    const c = counts[def.provider];
    if (def.provider === "FRED" && !key) {
      report.skipped.push(def.code);
      setIndicatorStatus(db, def.code, at, "Chýba FRED_API_KEY (zadarmo: fredaccount.stlouisfed.org/apikeys)");
      continue;
    }
    try {
      let obs: Obs[];
      if (def.altRefs?.length) {
        // Same concept published under several codes: take the one with the most recent data, never splice.
        const tried: { ref: string; obs: Obs[] }[] = [];
        const errors: string[] = [];
        for (const ref of [def.ref, ...def.altRefs]) {
          try {
            const o = def.provider === "FRED" ? await fred(ref, key as string, def.historyStart) : await ecb({ ...def, ref }, def.historyStart);
            if (o.length) tried.push({ ref, obs: o });
          } catch (e) {
            errors.push(`${ref}: ${redact(e instanceof Error ? e.message : String(e))}`);
          }
        }
        if (!tried.length) throw new Error(`Žiadny kód nevrátil dáta (${errors.join("; ")})`);
        tried.sort((a, b) => b.obs[b.obs.length - 1].date.localeCompare(a.obs[a.obs.length - 1].date));
        const best = tried[0];
        const prevRef = getMeta(db, `ref:${def.code}`);
        if (prevRef !== best.ref) {
          db.prepare("DELETE FROM observations WHERE indicator = ?").run(def.code);
          setMeta(db, `ref:${def.code}`, best.ref);
          logEvent(db, "info", "ingest", `${def.code}: používa sa kód ${best.ref} (posledný údaj ${best.obs[best.obs.length - 1].date})`, at);
        }
        obs = best.obs;
      } else {
        const start = startFor(db, def);
        obs = def.provider === "FRED" ? await fred(def.ref, key as string, start) : await ecb(def, start);
      }
      if (!obs.length && !lastObsDate(db, def.code)) throw new Error("Zdroj nevrátil žiadne pozorovania");
      const r = upsertObservations(db, def.code, def.provider, obs, at);
      setIndicatorStatus(db, def.code, at, null);
      if (r.revised) logEvent(db, "info", "ingest", `${def.code}: zrevidovaných ${r.revised} hodnôt`, at);
      report.ok.push(def.code);
      c.ok++;
    } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e));
      report.failed.push({ code: def.code, error: msg });
      setIndicatorStatus(db, def.code, at, msg);
      logEvent(db, "warn", "ingest", `${def.code}: ${msg}`, at);
      c.fail++;
      c.err = msg;
    }
  }

  // Supplements: the same series from its original publisher, which posts the latest day earlier than FRED.
  // Only dates the main provider does not have are added. Requires main-provider history to exist.
  counts.TREASURY = { ok: 0, fail: 0 };
  const treasury = deps.fetchTreasury ?? ((feed, ym) => fetchTreasuryMonth(feed, ym));
  const xmlCache = new Map<string, Promise<string>>();
  for (const def of INDICATORS.filter((i) => i.supplement)) {
    const sup = def.supplement!;
    const c = counts[sup.provider];
    if (!lastObsDate(db, def.code)) continue; // no history to extend -> nothing to supplement
    try {
      let obs: Obs[] = [];
      for (const ym of recentMonths(now)) {
        const k = `${sup.feed}|${ym}`;
        if (!xmlCache.has(k)) xmlCache.set(k, treasury(sup.feed, ym));
        obs = obs.concat(parseTreasuryXml(await xmlCache.get(k)!, sup.field));
      }
      const added = insertMissingObservations(db, def.code, sup.provider, obs, at);
      if (added) logEvent(db, "info", "ingest", `${def.code}: +${added} novších dní z US Treasury`, at);
      c.ok++;
    } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e));
      logEvent(db, "warn", "ingest", `${def.code} (US Treasury): ${msg}`, at);
      c.fail++;
      c.err = msg;
    }
  }

  for (const p of ["FRED", "ECB", "TREASURY"] as const) {
    const c = counts[p];
    let health: string;
    let detail: string | null = null;
    if (p === "TREASURY" && c.ok + c.fail === 0) continue;
    if (p === "FRED" && !key) { health = "unconfigured"; detail = "Chýba FRED_API_KEY"; }
    else if (c.fail === 0) health = "ok";
    else if (c.ok === 0) { health = "down"; detail = c.err ?? null; }
    else { health = "degraded"; detail = `${c.fail} zlyhaní, posledná chyba: ${c.err}`; }
    setProviderStatus(db, p, health, detail, at);
    report.providers[p] = health;
  }

  // Calendar: static central-bank dates + FRED release dates (the latter needs a key and may fail without breaking scoring).
  replaceCalendar(db, "STATIC", STATIC_CALENDAR.map((e) => ({ date: e.date, name: e.name, kind: e.kind, importance: e.importance, url: e.source })));
  if (key) {
    try {
      const today = at.slice(0, 10);
      const rd = await releases(key, today, addDays(today, 45));
      const events = rd.flatMap((r) => {
        const w = WATCHED_RELEASES.find((x) => r.name.toLowerCase().includes(x.match.toLowerCase()));
        return w ? [{ date: r.date, name: w.label, kind: "DATA", importance: w.importance, url: "https://fred.stlouisfed.org/releases/calendar" }] : [];
      });
      replaceCalendar(db, "FRED_RELEASES", events);
    } catch (e) {
      logEvent(db, "warn", "calendar", `Kalendár vydaní FRED zlyhal: ${redact(e instanceof Error ? e.message : String(e))}`, at);
    }
  }
  return report;
}
