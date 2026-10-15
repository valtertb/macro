// All market data in this file is SYNTHETIC (see fixtures.ts). It tests logic, not markets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSET_FACTORS, MODEL } from "../src/config.ts";
import { classify, computeBias, prepare } from "../src/scoring/engine.ts";
import { classifyRegime } from "../src/scoring/regime.ts";
import { buildDerived } from "../src/scoring/signals.ts";
import { mad, median, robustZ, score10 } from "../src/stats.ts";
import type { Data, Symbol } from "../src/types.ts";
import { NOW, age, bump, makeData, without } from "./fixtures.ts";

const run = (d: Data, s: Symbol, prev = null as any) => computeBias(s, prepare(d, NOW), NOW, prev);
const factor = (r: ReturnType<typeof run>, code: string) => r.factors.find((f) => f.code === code)!;

test("stats: robust z-score, fallback, clip, insufficient history", () => {
  const h = Array.from({ length: 101 }, (_, i) => i); // median 50, MAD 25
  assert.equal(median(h), 50);
  assert.equal(mad(h), 25);
  assert.ok(Math.abs(robustZ(h, 50 + 1.4826 * 25, { minObs: 10 })! - 1) < 1e-9);
  assert.equal(robustZ(h, 1e6, { minObs: 10 }), 3); // clipped
  assert.equal(robustZ([1, 2, 3], 2, { minObs: 10 }), null); // insufficient -> unavailable, not zero
  assert.equal(robustZ(Array(100).fill(5), 7, { minObs: 10 }), null); // no dispersion -> unavailable
  const flatish = [...Array(60).fill(0), 1, -1, 1, -1]; // MAD = 0 but non-zero mean abs deviation
  assert.ok(robustZ(flatish, 1, { minObs: 10 })! > 0);
  assert.ok(Math.abs(score10(10)) <= 10 && score10(0) === 0 && score10(-2) < 0);
});

test("baseline synthetic data: all assets scored, bounded, weights sum to 1", () => {
  for (const s of ["NQ", "GC", "EURUSD"] as Symbol[]) {
    assert.ok(Math.abs(ASSET_FACTORS[s].reduce((a, f) => a + f.weight, 0) - 1) < 1e-9);
    const r = run(makeData(), s);
    assert.equal(r.status, "normal", `${s} status`);
    assert.ok(r.coverage > 0.999);
    assert.ok(r.displayedScore! >= -10 && r.displayedScore! <= 10);
    assert.ok(r.confidence! >= 0 && r.confidence! <= 100);
    assert.equal(r.displayedScore, Math.round(r.rawScore! * 10) / 10);
  }
});

test("reproducibility: same inputs give identical score and hash; changed inputs change the hash", () => {
  const a = run(makeData(), "GC");
  const b = run(makeData(), "GC");
  assert.equal(a.rawScore, b.rawScore);
  assert.equal(a.inputHash, b.inputHash);
  const c = run(bump(makeData(), "DFII10", 0.5), "GC");
  assert.notEqual(a.inputHash, c.inputHash);
});

test("signs: rising real yields hurt Gold", () => {
  const base = run(makeData(), "GC");
  const shock = run(bump(makeData(), "DFII10", 0.8), "GC");
  assert.ok(factor(shock, "real_yields").score! < -5, "strongly negative");
  assert.ok(factor(shock, "real_yields").score! < factor(base, "real_yields").score!);
  assert.ok(shock.rawScore! < base.rawScore!);
});

test("signs: hawkish US repricing hurts NQ and EUR/USD", () => {
  const d = bump(makeData(), "DGS2", 0.7);
  for (const s of ["NQ", "GC"] as Symbol[]) assert.ok(factor(run(d, s), "fed_policy").score! < factor(run(makeData(), s), "fed_policy").score!);
  assert.ok(factor(run(d, "EURUSD"), "policy_diff").score! < factor(run(makeData(), "EURUSD"), "policy_diff").score!);
});

test("signs: stronger USD is negative for NQ, Gold and EUR/USD", () => {
  const d = bump(makeData(), "DTWEXBGS", 4);
  for (const s of ["NQ", "GC", "EURUSD"] as Symbol[]) {
    assert.ok(factor(run(d, s), "usd").score! < -5, s);
  }
});

test("signs: risk stress hurts NQ and EUR/USD, helps Gold (haven hypothesis)", () => {
  const d = bump(bump(makeData(), "VIXCLS", 10), "BAMLH0A0HYM2", 1.0);
  assert.ok(factor(run(d, "NQ"), "risk").score! < -3);
  assert.ok(factor(run(d, "EURUSD"), "risk").score! < 0);
  assert.ok(factor(run(d, "GC"), "risk").score! > 0);
});

test("signs: hawkish euro-area repricing supports EUR/USD", () => {
  const up = factor(run(bump(makeData(), "EA2Y", 0.7), "EURUSD"), "policy_diff").score!;
  assert.ok(up > factor(run(makeData(), "EURUSD"), "policy_diff").score!);
});

test("NQ: yields falling during stress is NOT scored bullish", () => {
  const stressed = bump(bump(bump(makeData(), "VIXCLS", 9), "BAMLH0A0HYM2", 1.2), "DFII10", -0.8);
  const nq = run(bump(stressed, "DGS10", -0.8), "NQ");
  assert.equal(factor(nq, "yields").z, 0);
  assert.ok(factor(nq, "yields").notes.some((n) => n.includes("stres")));
  // while a calm yield fall is bullish
  // (the synthetic VIX happens to end high, so lower it to make the scenario genuinely calm)
  const calmData = bump(bump(bump(makeData(), "DFII10", -0.8), "DGS10", -0.8), "VIXCLS", -8, 30);
  assert.ok(prepare(calmData, NOW).signals.riskStress!.z < 1.5);
  assert.ok(factor(run(calmData, "NQ"), "yields").score! > 5);
});

test("missing essential factor suppresses the score (Gold without real yields, EUR/USD without EA data)", () => {
  const gc = run(without(makeData(), "DFII10"), "GC");
  assert.equal(gc.status, "insufficient");
  assert.equal(gc.displayedScore, null);
  assert.deepEqual(gc.missingEssential, ["real_yields"]);
  assert.equal(gc.confidence, null);
  const eu = run(without(makeData(), "EA2Y"), "EURUSD");
  assert.equal(eu.status, "insufficient");
  assert.equal(eu.displayedScore, null);
});

test("partial coverage: provisional band, reduced confidence, no zero-filling", () => {
  const full = run(makeData(), "NQ");
  const part = run(without(makeData(), "CPILFESL", "PAYEMS"), "NQ"); // loses surprise (20 %) -> coverage 80 %
  assert.equal(part.status, "provisional");
  assert.ok(Math.abs(part.coverage - 0.8) < 1e-9);
  assert.ok(part.confidence! < full.confidence!);
  assert.equal(factor(part, "surprise").score, null);
  // renormalised by coverage rather than treating the missing factor as 0
  const manual = part.factors.filter((f) => f.available).reduce((s, f) => s + f.contribution!, 0) / 0.8;
  assert.ok(Math.abs(part.rawScore! - Math.max(-10, Math.min(10, manual))) < 1e-9);
  const low = run(without(makeData(), "CPILFESL", "PAYEMS", "VIXCLS", "BAMLH0A0HYM2"), "NQ"); // coverage 65 %
  assert.equal(low.status, "insufficient");
  assert.equal(low.displayedScore, null);
});

test("stale data: expired feed makes dependent factors unavailable; merely old feed lowers confidence", () => {
  const expired = run(age(makeData(), "DGS2", 30), "NQ");
  assert.equal(expired.status, "insufficient"); // fed_policy is essential for NQ
  assert.equal(factor(expired, "fed_policy").available, false);
  const fresh = run(makeData(), "NQ");
  const oldish = run(age(makeData(), "DTWEXBGS", 20), "NQ"); // stale (10d) but not expired (30d)
  assert.equal(factor(oldish, "usd").available, true);
  assert.ok(factor(oldish, "usd").freshness < 1 && factor(oldish, "usd").freshness > 0);
  assert.ok(oldish.confidence! < fresh.confidence!);
});

test("double-counting protection: agreeing rate factors get the group haircut", () => {
  const d = bump(bump(makeData(), "DFII10", 0.8), "DGS2", 0.8);
  const r = run(d, "GC");
  const a = factor(r, "fed_policy");
  const b = factor(r, "real_yields");
  assert.ok(a.score! < 0 && b.score! < 0);
  assert.ok(Math.abs(a.contribution! - a.weight * a.score! * MODEL.groupHaircut) < 1e-12);
  assert.ok(a.notes.some((n) => n.includes("dvojitým")));
});

test("classification boundaries and hysteresis", () => {
  assert.equal(classify(0, null), "neutral");
  assert.equal(classify(2.6, null), "bullish");
  assert.equal(classify(-7, null), "strong_bearish");
  assert.equal(classify(7, null), "strong_bullish");
  assert.equal(classify(2.6, "neutral"), "neutral"); // inside hysteresis band
  assert.equal(classify(3.0, "neutral"), "bullish");
  assert.equal(classify(2.3, "bullish"), "bullish");
  assert.equal(classify(1.9, "bullish"), "neutral");
});

test("regime classifier: transparent rules, mixed when evidence is thin", () => {
  const d = buildDerived(makeData());
  assert.equal(classifyRegime(bump(d, "VIXCLS", 30), NOW).regime, "risk_off");
  assert.equal(classifyRegime({}, NOW).regime, "mixed");
  assert.equal(classifyRegime({}, NOW).certainty, 0.3);
  // hot core CPI: +1 % per month for the last 3 months
  const hot = { ...d, CPILFESL: d.CPILFESL.map((o, i, a) => (i >= a.length - 3 ? { ...o, value: o.value * (1 + 0.01 * (i - (a.length - 4))) } : o)) };
  assert.equal(classifyRegime(hot as Data, NOW).regime, "inflation_dominant");
  // rising unemployment
  const ur = { ...d, UNRATE: d.UNRATE.map((o, i, a) => (i >= a.length - 6 ? { ...o, value: d.UNRATE[a.length - 7].value + 0.5 } : o)) };
  assert.ok(["growth_dominant", "risk_off", "inflation_dominant"].includes(classifyRegime(ur as Data, NOW).regime));
});

test("derived series exist only when sources exist; no interpolation", () => {
  const d = buildDerived(without(makeData(), "EA10Y"));
  assert.equal(d.US10_EA10, undefined);
  assert.ok(d.US_2Y_FF.length > 0);
});
