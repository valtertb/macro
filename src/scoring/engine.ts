import { createHash } from "node:crypto";
import { ASSET_FACTORS, FACTOR_LABELS, MODEL, MODEL_VERSION } from "../config.ts";
import { score10 } from "../stats.ts";
import type { BiasResult, Classification, Data, FactorResult, Regime, Signal, SignalInput, Symbol } from "../types.ts";
import { classifyRegime } from "./regime.ts";
import type { RegimeInfo } from "./regime.ts";
import { buildDerived, computeSignals } from "./signals.ts";
import type { Signals } from "./signals.ts";

export interface Prepared {
  data: Data;
  signals: Signals;
  regime: RegimeInfo;
}

export function prepare(raw: Data, now: Date): Prepared {
  const data = buildDerived(raw);
  return { data, signals: computeSignals(data, now), regime: classifyRegime(data, now) };
}

interface Built {
  z: number | null;
  used: (Signal | null)[];
  notes: string[];
}

const single = (s: Signal | null, sign: number): Built => ({ z: s ? sign * s.z : null, used: [s], notes: s?.note ? [s.note] : [] });

/** Sign of the labor-data surprise for NQ depends on the regime ("good news is bad news" under inflation dominance). */
export function laborSignNQ(r: Regime): number {
  switch (r) {
    case "inflation_dominant": return -1;
    case "growth_dominant": return 1;
    case "monetary_easing": return 0.5;
    case "monetary_tightening": return -0.5;
    case "risk_off": return 0.5;
    default: return 0;
  }
}

function weightedAvg(items: [number | null, number][]): number | null {
  const av = items.filter((i): i is [number, number] => i[0] !== null);
  if (!av.length) return null;
  const w = av.reduce((s, [, x]) => s + x, 0);
  return av.reduce((s, [v, x]) => s + v * x, 0) / w;
}

type Builder = (s: Signals, r: RegimeInfo) => Built;

const BUILDERS: Record<Symbol, Record<string, Builder>> = {
  NQ: {
    fed_policy: (s) => single(s.usHawk, -1),
    yields: (s) => {
      const z = weightedAvg([[s.realYield ? s.realYield.z : null, 0.5], [s.nomYield ? s.nomYield.z : null, 0.5]]);
      const notes: string[] = [];
      let out = z === null ? null : -z;
      if (out !== null && out > 0 && s.riskStress && s.riskStress.z >= 1.5) {
        out = 0;
        notes.push("Pokles výnosov pri zvýšenom strese sa nepočíta ako býčí (možné riziko recesie, nie dezinflácia).");
      }
      return { z: out, used: [s.realYield, s.nomYield, s.riskStress], notes };
    },
    usd: (s) => single(s.usd, -1),
    surprise: (s, r) => {
      const sign = laborSignNQ(r.regime);
      const z = weightedAvg([
        [s.inflSurprise ? -s.inflSurprise.z : null, 0.5],
        [s.laborSurprise ? sign * s.laborSurprise.z : null, 0.5],
      ]);
      const notes = ["Modelové prekvapenie (voči kĺzavému priemeru), nie voči konsenzu."];
      if (sign === 0) notes.push("Znamienko dát o práci je v zmiešanom režime nejednoznačné — nezapočítava sa.");
      return { z, used: [s.inflSurprise, s.laborSurprise], notes };
    },
    risk: (s) => single(s.riskStress, -1),
  },
  GC: {
    fed_policy: (s) => single(s.usHawk, -1),
    real_yields: (s) => single(s.realYield, -1),
    usd: (s) => single(s.usd, -1),
    surprise: (s) => ({
      z: weightedAvg([
        [s.inflSurprise ? -s.inflSurprise.z : null, 0.5],
        [s.laborSurprise ? -s.laborSurprise.z : null, 0.5],
      ]),
      used: [s.inflSurprise, s.laborSurprise],
      notes: ["Kanál cez očakávania sadzieb (hypotéza). Modelové prekvapenie, nie konsenzus."],
    }),
    risk: (s) => {
      const b = single(s.riskStress, 0.5);
      b.notes.push("Safe-haven kanál je hypotéza; signál má polovičnú váhu.");
      return b;
    },
  },
  EURUSD: {
    policy_diff: (s) => {
      if (!s.usHawk || !s.ecbHawk) {
        return { z: null, used: [s.usHawk, s.ecbHawk], notes: ["Rozdiel politiky vyžaduje US aj eurozónu; jedna strana chýba."] };
      }
      return { z: (-s.usHawk.z + s.ecbHawk.z) / 2, used: [s.usHawk, s.ecbHawk], notes: ["Eurozóna: proxy zo zmeny 2Y AAA výnosu ECB, nie z cenotvorby sadzieb."] };
    },
    yield_diff: (s) => single(s.yieldDiffChg, -1),
    usd: (s) => {
      const b = single(s.usd, -1);
      b.notes.push("Široký index USD obsahuje aj EUR — čiastočná cirkularita, preto nie je plne nezávislý.");
      return b;
    },
    rel_surprise: (s) => {
      const us = weightedAvg([
        [s.inflSurprise ? -s.inflSurprise.z : null, 0.5],
        [s.laborSurprise ? -s.laborSurprise.z : null, 0.5],
      ]);
      if (us === null || !s.eaInflSurprise) {
        return { z: null, used: [s.inflSurprise, s.laborSurprise, s.eaInflSurprise], notes: ["Relatívne prekvapenie vyžaduje US aj eurozónu."] };
      }
      return { z: 0.5 * us + 0.5 * s.eaInflSurprise.z, used: [s.inflSurprise, s.laborSurprise, s.eaInflSurprise], notes: ["Modelové prekvapenie, nie konsenzus."] };
    },
    risk: (s) => single(s.riskStress, -0.5),
  },
};

export function classify(score: number, prev?: Classification | null): Classification {
  const a = MODEL.boundaryNeutral;
  const b = MODEL.boundaryStrong;
  const h = MODEL.hysteresis;
  const raw: Classification =
    score <= -b ? "strong_bearish" : score <= -a ? "bearish" : score < a ? "neutral" : score < b ? "bullish" : "strong_bullish";
  if (!prev || prev === raw) return raw;
  const ranges: Record<Classification, [number, number]> = {
    strong_bearish: [-Infinity, -b],
    bearish: [-b, -a],
    neutral: [-a, a],
    bullish: [a, b],
    strong_bullish: [b, Infinity],
  };
  const [lo, hi] = ranges[prev];
  return score > lo - h && score < hi + h ? prev : raw;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function computeBias(symbol: Symbol, prep: Prepared, now: Date, prevClass?: Classification | null): BiasResult {
  const specs = ASSET_FACTORS[symbol];
  const factors: FactorResult[] = specs.map((spec) => {
    const built = BUILDERS[symbol][spec.code](prep.signals, prep.regime);
    const used = built.used.filter((x): x is Signal => x !== null);
    const z = built.z;
    const available = z !== null && used.length > 0;
    return {
      code: spec.code,
      label: FACTOR_LABELS[spec.code] ?? spec.code,
      group: spec.group,
      weight: spec.weight,
      available,
      z: available ? z : null,
      score: available ? score10(z as number) : null,
      contribution: null,
      freshness: used.length ? Math.min(...used.map((u) => u.freshness)) : 0,
      quality: used.length ? used.reduce((s, u) => s + u.quality, 0) / used.length : 0,
      inputs: dedupeInputs(used.flatMap((u) => u.inputs)),
      notes: [...new Set([...built.notes, ...used.map((u) => u.note).filter((n): n is string => !!n)])],
    };
  });

  const valid = factors.filter((f) => f.available);
  // Double-counting protection: if all valid factors of a group agree in sign, scale their contributions.
  const groups = new Map<string, FactorResult[]>();
  for (const f of valid) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const f of valid) f.contribution = f.weight * (f.score as number);
  for (const [, g] of groups) {
    if (g.length >= 2) {
      const pos = g.every((f) => (f.score as number) > 0);
      const neg = g.every((f) => (f.score as number) < 0);
      if (pos || neg) {
        for (const f of g) {
          f.contribution = (f.contribution as number) * MODEL.groupHaircut;
          f.notes.push(`Korelovaná skupina „${f.group}": príspevok znížený koeficientom ${MODEL.groupHaircut} (ochrana pred dvojitým započítaním).`);
        }
      }
    }
  }

  const coverage = valid.reduce((s, f) => s + f.weight, 0);
  const missingEssential = specs.filter((s) => s.essential && !valid.some((f) => f.code === s.code)).map((s) => s.code);
  const EPS = 1e-9; // floating-point safety for weight sums such as 0.3 + 0.25 + 0.1 + 0.2
  const status =
    missingEssential.length > 0 || coverage < MODEL.coverageProvisional - EPS
      ? "insufficient"
      : coverage < MODEL.coverageNormal - EPS
        ? "provisional"
        : "normal";

  let rawScore: number | null = null;
  let displayedScore: number | null = null;
  let classification: Classification | null = null;
  let confidence: number | null = null;
  let confidenceParts: Record<string, number> | null = null;

  if (status !== "insufficient") {
    const sum = valid.reduce((s, f) => s + (f.contribution as number), 0);
    rawScore = clip(sum / coverage, -10, 10);
    displayedScore = round1(rawScore);
    classification = classify(displayedScore, prevClass);

    const wsum = coverage;
    const freshness = valid.reduce((s, f) => s + f.weight * f.freshness, 0) / wsum;
    const quality = valid.reduce((s, f) => s + f.weight * f.quality, 0) / wsum;
    const num = Math.abs(valid.reduce((s, f) => s + f.weight * (f.score as number), 0));
    const den = valid.reduce((s, f) => s + f.weight * Math.abs(f.score as number), 0);
    const agreement = den > 0 ? num / den : 0.5;
    const parts = {
      coverage: coverage * 100,
      freshness: freshness * 100,
      agreement: agreement * 100,
      sourceQuality: quality * 100,
      regimeCertainty: prep.regime.certainty * 100,
    };
    const w = MODEL.confidenceWeights;
    let c =
      w.coverage * parts.coverage + w.freshness * parts.freshness + w.agreement * parts.agreement +
      w.sourceQuality * parts.sourceQuality + w.regimeCertainty * parts.regimeCertainty;
    if (status === "provisional") c *= 0.8;
    confidence = Math.round(clip(c, 0, 100));
    confidenceParts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)]));
  }

  const hashInputs = dedupeInputs(factors.flatMap((f) => f.inputs))
    .map((i) => [i.indicator, i.date, i.value] as const)
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const inputHash = createHash("sha1").update(JSON.stringify([MODEL_VERSION, symbol, hashInputs])).digest("hex");

  return {
    symbol,
    calculatedAt: now.toISOString(),
    version: MODEL_VERSION,
    status,
    rawScore,
    displayedScore,
    classification,
    confidence,
    confidenceParts,
    coverage,
    missingEssential,
    regime: prep.regime.regime,
    regimeCertainty: prep.regime.certainty,
    regimeReasons: prep.regime.reasons,
    factors,
    inputHash,
  };
}

function dedupeInputs(inputs: SignalInput[]): SignalInput[] {
  const seen = new Set<string>();
  const out: SignalInput[] = [];
  for (const i of inputs) {
    const k = `${i.indicator}|${i.kind}|${i.date}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(i);
    }
  }
  return out;
}
