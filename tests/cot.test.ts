// Position numbers below are SYNTHETIC, except the parser sample, which mirrors the field names and string-typed values
// of a real CFTC Legacy Futures Only row (Nasdaq mini, report of 2026-10-06).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSite } from "../src/build-site.ts";
import { COT_EXTREME_HIGH, cotIndex, loadCot, summarize } from "../src/cot.ts";
import type { IngestDeps } from "../src/ingest.ts";
import { parseCot } from "../src/providers/cftc.ts";
import type { CotRow } from "../src/providers/cftc.ts";
import { NOW, makeData } from "./fixtures.ts";

const realShape = [{
  report_date_as_yyyy_mm_dd: "2026-10-06T00:00:00.000", market_and_exchange_names: "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE",
  open_interest_all: "283586", noncomm_positions_long_all: "86745", noncomm_positions_short_all: "28622",
  comm_positions_long_all: "148690", comm_positions_short_all: "217136", nonrept_positions_long_all: "42031", nonrept_positions_short_all: "31708",
}];

function weeks(n: number, specNet: (i: number) => number, end = "2026-10-06"): CotRow[] {
  const out: CotRow[] = [];
  const endMs = Date.parse(end + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const date = new Date(endMs - (n - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10);
    const sn = specNet(i);
    out.push({ date, market: "TEST", openInterest: 300000, specLong: 100000 + Math.max(sn, 0), specShort: 100000 - Math.min(sn, 0), commLong: 150000, commShort: 150000 + sn, smallLong: 40000, smallShort: 40000 });
  }
  return out;
}

test("parseCot: real CFTC row shape -> numbers, net positions match TradingAnalyzer screenshot", () => {
  const [r] = parseCot(realShape);
  assert.equal(r.date, "2026-10-06");
  assert.equal(r.openInterest, 283586);
  assert.equal(r.specLong - r.specShort, 58123); // "Velcí spekulanti: Čisté pozice 58 123"
  assert.equal(r.commLong - r.commShort, -68446); // "Komerční: -68 446"
  assert.equal(r.smallLong - r.smallShort, 10323);
  assert.throws(() => parseCot({ error: true }));
  assert.equal(parseCot([{ report_date_as_yyyy_mm_dd: "bad" }]).length, 0);
});

test("cotIndex: range position, needs 52 weeks, flat range is unavailable", () => {
  assert.equal(cotIndex(Array.from({ length: 51 }, (_, i) => i)), null);
  assert.equal(cotIndex([...Array.from({ length: 60 }, (_, i) => i), 59]), 100 * 59 / 59);
  assert.equal(cotIndex(Array.from({ length: 60 }, (_, i) => 60 - i)), 0);
  assert.equal(cotIndex(Array(60).fill(5)), null);
});

test("summarize: crowded long / short / none, weekly change, % OI, stale flag", () => {
  const rising = summarize("NQ", "209742", "Nasdaq", weeks(160, (i) => i * 100), NOW);
  assert.equal(rising.signal, "crowded_long");
  assert.ok(rising.spec.index! >= COT_EXTREME_HIGH);
  assert.equal(rising.spec.change, 100);
  assert.ok(Math.abs(rising.spec.pctOi - (159 * 100 / 300000) * 100) < 1e-9);
  assert.equal(rising.comm.index, 0); // commercials are the mirror image here
  assert.equal(rising.history.length, 156);
  assert.equal(rising.stale, false); // 9 days old on Thursday NOW

  const falling = summarize("GC", "088691", "Gold", weeks(160, (i) => -i * 100), NOW);
  assert.equal(falling.signal, "crowded_short");

  const middle = summarize("EURUSD", "099741", "Euro", weeks(160, (i) => (i === 159 ? 8000 : (i % 2 ? 1 : -1) * 15000)), NOW);
  assert.equal(middle.signal, "none");

  const short = summarize("NQ", "209742", "Nasdaq", weeks(30, (i) => i), NOW);
  assert.equal(short.signal, "insufficient");

  const old = summarize("NQ", "209742", "Nasdaq", weeks(160, (i) => i, "2026-09-22"), NOW);
  assert.equal(old.stale, true);
});

test("loadCot: one market failing does not hide the others", async () => {
  const r = await loadCot(NOW, async (code) => { if (code === "088691") throw new Error("HTTP 503"); return weeks(160, (i) => i); });
  assert.equal(r.markets.length, 2);
  assert.deepEqual(r.errors, [{ symbol: "GC", error: "HTTP 503" }]);
});

test("static site: cot.json is published and CFTC health appears in status", async () => {
  const syn = makeData();
  const deps: IngestDeps = {
    fetchFred: async (id) => syn[id],
    fetchEcb: async (def) => { if (!syn[def.code]) throw new Error("n/a"); return syn[def.code]; },
    fetchReleases: async () => [],
    fetchTreasury: async () => "<feed></feed>",
  };
  const dir = mkdtempSync(join(tmpdir(), "mb-cot-"));
  await buildSite({ env: { FRED_API_KEY: "k" }, outDir: join(dir, "site"), historyPath: join(dir, "h.json"), now: NOW, deps, cotFetcher: async () => weeks(160, (i) => i * 10) });
  const cot = JSON.parse(readFileSync(join(dir, "site/data/cot.json"), "utf8"));
  assert.equal(cot.markets.length, 3);
  assert.equal(cot.markets[0].symbol, "NQ");
  const st = JSON.parse(readFileSync(join(dir, "site/data/status.json"), "utf8"));
  assert.equal(st.providers.find((p: any) => p.provider === "CFTC").health, "ok");
  const html = readFileSync(join(dir, "site/index.html"), "utf8");
  assert.ok(html.includes('id="cot"'));
});
