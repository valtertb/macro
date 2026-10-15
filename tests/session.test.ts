// SYNTHETIC inputs — tests the deterministic session-bias rules only.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CotSummary } from "../src/cot.ts";
import { classifyDirection, marketVerdict, sessionBias, zonedToUtc } from "../src/session.ts";
import type { BiasResult } from "../src/types.ts";

function bias(score: number | null, opts: Partial<BiasResult> = {}): BiasResult {
  return {
    symbol: "GC", calculatedAt: "2026-10-15T06:00:00Z", version: "t", status: "normal",
    rawScore: score, displayedScore: score, classification: null, confidence: 80, confidenceParts: null,
    coverage: 1, missingEssential: [], regime: "mixed", regimeCertainty: 0.3, regimeReasons: [], inputHash: "x",
    factors: [
      { code: "real_yields", label: "Reálne výnosy USA", group: "rates", weight: 0.3, available: true, z: -1, score: -5, contribution: score !== null && score < 0 ? -1.5 : 1.5, freshness: 1, quality: 1, inputs: [{ indicator: "DFII10", date: "2026-10-14", value: 2, kind: "change" }], notes: [] },
      { code: "usd", label: "Sila USD", group: "usd", weight: 0.25, available: true, z: 0.2, score: 1, contribution: 0.25, freshness: 1, quality: 1, inputs: [], notes: [] },
    ],
    ...opts,
  };
}
const cot = (signal: CotSummary["signal"], stale = false) => ({ signal, stale } as CotSummary);
const OPEN_NY = zonedToUtc("2026-10-15", "15:30", "Europe/Bratislava");

test("zonedToUtc handles both DST regimes", () => {
  assert.equal(zonedToUtc("2026-10-15", "08:30", "America/New_York").toISOString(), "2026-10-15T12:30:00.000Z"); // EDT
  assert.equal(zonedToUtc("2026-11-05", "08:30", "America/New_York").toISOString(), "2026-11-05T13:30:00.000Z"); // EST
  assert.equal(zonedToUtc("2026-10-15", "09:00", "Europe/Bratislava").toISOString(), "2026-10-15T07:00:00.000Z"); // CEST
  assert.equal(zonedToUtc("2026-10-28", "09:00", "Europe/Bratislava").toISOString(), "2026-10-28T08:00:00.000Z"); // CET
});

test("thresholds: none / lean / bias / strong and sign", () => {
  assert.deepEqual(classifyDirection(0.9), { direction: "none", strength: "none" });
  assert.deepEqual(classifyDirection(-1.7), { direction: "short", strength: "lean" });
  assert.deepEqual(classifyDirection(3), { direction: "long", strength: "bias" });
  assert.deepEqual(classifyDirection(-7), { direction: "short", strength: "strong" });
  assert.deepEqual(classifyDirection(null), { direction: "none", strength: "none" });
});

test("verdict: clear text, reason names drivers, playbook matches direction", () => {
  const v = marketVerdict(bias(-3.2), "Zlato", undefined, [], OPEN_NY);
  assert.equal(v.verdict, "SHORT BIAS");
  assert.equal(v.strength, "bias");
  assert.match(v.reason, /Reálne výnosy USA/);
  assert.match(v.playbook, /Preferuj SHORT/);
  assert.ok(v.invalidation);
  const n = marketVerdict(bias(0.4), "Zlato", undefined, [], OPEN_NY);
  assert.equal(n.verdict, "BEZ BIASU");
  assert.match(n.playbook, /NO TRADE/);
});

test("downgrades: low confidence and provisional each weaken one step; insufficient = no bias", () => {
  assert.equal(marketVerdict(bias(-3.2, { confidence: 50 }), "Z", undefined, [], OPEN_NY).strength, "lean");
  const lean = marketVerdict(bias(-1.7, { confidence: 50 }), "Z", undefined, [], OPEN_NY);
  assert.equal(lean.direction, "none");
  assert.equal(lean.downgrades.length, 1);
  assert.equal(marketVerdict(bias(-3.2, { status: "provisional", confidence: 50 }), "Z", undefined, [], OPEN_NY).direction, "none");
  const ins = marketVerdict(bias(null, { status: "insufficient", confidence: null }), "Z", undefined, [], OPEN_NY);
  assert.equal(ins.verdict, "BEZ BIASU");
  assert.match(ins.downgrades[0], /Nedostatok dát/);
});

test("event risk: US CPI before NY open, FOMC during/after, ECB only for EUR/USD", () => {
  const ev = [
    { date: "2026-10-15", name: "US CPI", kind: "DATA", importance: "high" },
    { date: "2026-10-15", name: "ECB rozhodnutie", kind: "ECB", importance: "high" },
  ];
  const gold = marketVerdict(bias(-3), "Zlato", undefined, ev, OPEN_NY);
  assert.equal(gold.warnings.length, 1);
  assert.match(gold.warnings[0], /US CPI o 14:30, pred otvorením/);
  const openLdn = zonedToUtc("2026-10-15", "09:00", "Europe/Bratislava");
  const eur = marketVerdict({ ...bias(2), symbol: "EURUSD" }, "EUR/USD", undefined, ev, openLdn);
  assert.equal(eur.warnings.length, 2);
  assert.ok(eur.warnings.some((w) => /ECB rozhodnutie o 14:15, počas session/.test(w)));
});

test("COT: crowded with the bias warns about crowding; crowded against supports a squeeze; stale ignored", () => {
  assert.match(marketVerdict(bias(-3), "Z", cot("crowded_short"), [], OPEN_NY).warnings[0], /preplnená/);
  assert.match(marketVerdict(bias(-3), "Z", cot("crowded_long"), [], OPEN_NY).warnings[0], /výplach longov/);
  assert.equal(marketVerdict(bias(-3), "Z", cot("crowded_long", true), [], OPEN_NY).warnings.length, 0);
  assert.equal(marketVerdict(bias(0.2), "Z", cot("crowded_long"), [], OPEN_NY).warnings.length, 0);
});

test("sessionBias: London = EUR/USD, NY = Gold + NQ, weekend flag, events labelled", () => {
  const assets = [
    { symbol: "NQ" as const, name: "NQ", bias: { ...bias(-2.2), symbol: "NQ" as const } },
    { symbol: "GC" as const, name: "Zlato", bias: bias(-1.7) },
    { symbol: "EURUSD" as const, name: "EUR/USD", bias: { ...bias(0.2), symbol: "EURUSD" as const } },
  ];
  const s = sessionBias(assets, [], [{ date: "2026-10-15", name: "US CPI", kind: "DATA", importance: "high" }], new Date("2026-10-15T05:00:00Z"));
  assert.equal(s.date, "2026-10-15");
  assert.equal(s.weekend, false);
  assert.deepEqual(s.sessions.map((b) => b.markets.map((m) => m.symbol)), [["EURUSD"], ["GC", "NQ"]]);
  assert.equal(s.sessions[0].events[0].when, "during"); // 14:30 is during the London-to-NY day for the 09:00 block
  assert.equal(s.sessions[1].events[0].when, "before");
  assert.equal(s.dataAsOf, "2026-10-14");
  assert.equal(sessionBias(assets, [], [], new Date("2026-10-17T08:00:00Z")).weekend, true);
});
