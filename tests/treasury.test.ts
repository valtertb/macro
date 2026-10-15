// SYNTHETIC data only. The XML is hand-written in the shape of the documented Treasury feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getSeries, lastObsProvider, openDb } from "../src/db.ts";
import type { IngestDeps } from "../src/ingest.ts";
import { parseTreasuryXml, recentMonths } from "../src/providers/treasury.ts";
import { refreshAll } from "../src/refresh.ts";
import { buildDerived } from "../src/scoring/signals.ts";
import { asOfJoin } from "../src/stats.ts";
import { NOW, makeData, treasuryXml } from "./fixtures.ts";

test("treasury parser: namespaced fields, null values skipped, sorted, bad payload rejected", () => {
  const xml = treasuryXml([
    { date: "2026-10-14", fields: { BC_2YEAR: 4.82, BC_10YEAR: 5.19 } },
    { date: "2026-10-13", fields: { BC_2YEAR: 4.8, BC_10YEAR: null } },
  ]);
  assert.deepEqual(parseTreasuryXml(xml, "BC_2YEAR"), [{ date: "2026-10-13", value: 4.8 }, { date: "2026-10-14", value: 4.82 }]);
  assert.deepEqual(parseTreasuryXml(xml, "BC_10YEAR"), [{ date: "2026-10-14", value: 5.19 }]);
  assert.deepEqual(parseTreasuryXml(treasuryXml([]), "BC_2YEAR"), []);
  assert.throws(() => parseTreasuryXml("<html>maintenance</html>", "BC_2YEAR"));
  assert.deepEqual(recentMonths(new Date("2026-01-05T00:00:00Z")), ["202512", "202601"]);
});

test("asOfJoin carries a step series forward at most maxGap days, never interpolates", () => {
  const a = [{ date: "2026-10-13", value: 4 }, { date: "2026-10-14", value: 4.1 }, { date: "2026-10-30", value: 4.2 }];
  const b = [{ date: "2026-10-13", value: 3.5 }];
  assert.deepEqual(asOfJoin(a, b, (x, y) => x - y, 5).map((o) => [o.date, +o.value.toFixed(2)]), [["2026-10-13", 0.5], ["2026-10-14", 0.6]]);
});

test("supplement: Treasury fills only newer dates, never overwrites FRED, source is visible", async () => {
  const syn = makeData();
  const fredLag = Object.fromEntries(Object.entries(syn).map(([k, v]) => [k, ["DGS2", "DGS10", "DFII10", "DFF"].includes(k) ? v.slice(0, -1) : v]));
  const lastDay = syn.DGS2.at(-1)!.date;
  const prevDay = syn.DGS2.at(-2)!.date;
  const xmlNominal = treasuryXml([
    { date: prevDay, fields: { BC_2YEAR: 99, BC_10YEAR: 99 } }, // conflicting value on a date FRED already has -> must be ignored
    { date: lastDay, fields: { BC_2YEAR: syn.DGS2.at(-1)!.value, BC_10YEAR: syn.DGS10.at(-1)!.value } },
  ]);
  const xmlReal = treasuryXml([{ date: lastDay, fields: { TC_10YEAR: syn.DFII10.at(-1)!.value } }]);
  const deps: IngestDeps = {
    fetchFred: async (id) => fredLag[id],
    fetchEcb: async (def) => { if (!syn[def.code]) throw new Error("n/a"); return syn[def.code]; },
    fetchReleases: async () => [],
    fetchTreasury: async (feed) => (feed === "daily_treasury_yield_curve" ? xmlNominal : xmlReal),
  };
  const db = openDb(":memory:");
  const r = await refreshAll(db, { FRED_API_KEY: "k" }, { now: NOW, deps });
  assert.equal(r.ingest.providers.TREASURY, "ok");
  for (const code of ["DGS2", "DGS10", "DFII10"]) {
    const s = getSeries(db, code);
    assert.equal(s.at(-1)!.date, lastDay, code);
    assert.equal(lastObsProvider(db, code), "TREASURY");
  }
  assert.equal(getSeries(db, "DGS2").find((o) => o.date === prevDay)!.value, syn.DGS2.at(-2)!.value); // FRED kept
  assert.equal(lastObsProvider(db, "DFF"), "FRED");
  // 2Y - fed funds uses the last known fed funds level for the newest yield date
  const derived = buildDerived({ DGS2: getSeries(db, "DGS2"), DFF: getSeries(db, "DFF") });
  assert.equal(derived.US_2Y_FF.at(-1)!.date, lastDay);
});

test("supplement failure is visible but does not break FRED data or scoring", async () => {
  const syn = makeData();
  const deps: IngestDeps = {
    fetchFred: async (id) => syn[id],
    fetchEcb: async (def) => { if (!syn[def.code]) throw new Error("n/a"); return syn[def.code]; },
    fetchReleases: async () => [],
    fetchTreasury: async () => { throw new Error("HTTP 503 home.treasury.gov"); },
  };
  const db = openDb(":memory:");
  const r = await refreshAll(db, { FRED_API_KEY: "k" }, { now: NOW, deps });
  assert.equal(r.ingest.providers.TREASURY, "down");
  assert.equal(r.ingest.providers.FRED, "ok");
  assert.deepEqual(r.score.stored, { NQ: true, GC: true, EURUSD: true });
  const snap = JSON.parse((db.prepare("SELECT payload_json FROM bias_snapshots WHERE symbol='GC'").get() as any).payload_json);
  assert.equal(snap.bias.status, "normal");
});
