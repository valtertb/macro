import { INDICATORS_BY_CODE, MODEL } from "../config.ts";
import {
  changes,
  deviationFromTrailingMean,
  diffSeries,
  joinSeries,
  pctChange,
  robustZ,
} from "../stats.ts";
import type { Data, Signal, SignalInput } from "../types.ts";

const DAY = 86_400_000;

export function ageDays(date: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(date + "T00:00:00Z")) / DAY);
}

/** 1 = fresh, decays linearly to 0 between staleDays and expireDays; 0 means "treat as unavailable". */
export function freshnessOf(code: string, date: string, now: Date): number {
  const d = INDICATORS_BY_CODE[code];
  if (!d) return 0;
  const age = ageDays(date, now);
  if (age <= d.staleDays) return 1;
  if (age >= d.expireDays) return 0;
  return 1 - (age - d.staleDays) / (d.expireDays - d.staleDays);
}

/** Adds derived indicators. A derived series exists only if all its sources exist. */
export function buildDerived(raw: Data): Data {
  const out: Data = { ...raw };
  if (raw.DGS2?.length && raw.DFF?.length) out.US_2Y_FF = joinSeries(raw.DGS2, raw.DFF, (a, b) => a - b);
  if (raw.DGS10?.length && raw.EA10Y?.length) out.US10_EA10 = joinSeries(raw.DGS10, raw.EA10Y, (a, b) => a - b);
  if (raw.CPILFESL?.length) out.CORE_CPI_MOM = pctChange(raw.CPILFESL);
  if (raw.PAYEMS?.length) out.NFP_CHG = diffSeries(raw.PAYEMS);
  return out;
}

interface Part {
  z: number;
  freshness: number;
  quality: number;
  inputs: SignalInput[];
}

type Kind = "change" | "level" | "surprise";

function part(data: Data, code: string, kind: Kind, now: Date): Part | null {
  const def = INDICATORS_BY_CODE[code];
  const s = data[code];
  if (!def || !s || !s.length) return null;
  const last = s[s.length - 1];
  const freshness = freshnessOf(code, last.date, now);
  if (freshness <= 0) return null; // expired -> unavailable, never silently reused
  const values = s.map((o) => o.value);
  let z: number | null = null;
  let delta: number | undefined;
  if (kind === "change") {
    const ch = changes(values, MODEL.lag);
    if (!ch.length) return null;
    delta = ch[ch.length - 1];
    z = robustZ(ch.slice(-MODEL.windowDaily - 1, -1), delta, { minObs: MODEL.minObsDaily, clip: MODEL.clip });
  } else if (kind === "level") {
    z = robustZ(values.slice(-MODEL.windowDaily - 1, -1), last.value, { minObs: MODEL.minObsDaily, clip: MODEL.clip });
  } else {
    const dev = deviationFromTrailingMean(values, MODEL.surpriseTrail);
    if (!dev.length) return null;
    delta = dev[dev.length - 1];
    z = robustZ(dev.slice(-MODEL.windowMonthly - 1, -1), delta, { minObs: MODEL.minObsMonthly, clip: MODEL.clip });
  }
  if (z === null) return null;
  return { z, freshness, quality: def.quality, inputs: [{ indicator: code, date: last.date, value: last.value, delta, kind }] };
}

function combine(name: string, items: [Part | null, number][], note?: string): Signal | null {
  const av = items.filter((it): it is [Part, number] => it[0] !== null);
  if (!av.length) return null;
  const wsum = av.reduce((s, [, w]) => s + w, 0);
  const partial = av.length < items.length;
  return {
    name,
    z: av.reduce((s, [p, w]) => s + p.z * w, 0) / wsum,
    freshness: Math.min(...av.map(([p]) => p.freshness)),
    quality: av.reduce((s, [p, w]) => s + p.quality * w, 0) / wsum,
    inputs: av.flatMap(([p]) => p.inputs),
    note: partial ? "Čiastočné vstupy: signál je počítaný len z dostupnej časti." : note,
  };
}

export type Signals = Record<string, Signal | null>;

/**
 * Asset-neutral signals in their NATURAL direction:
 *  usHawk       + = US policy more hawkish (2Y above funds rate and 2Y yield rising)
 *  realYield    + = US real yields rising (level and 5-obs change)
 *  nomYield     + = US 10Y yield rising
 *  usd          + = broad USD strengthening
 *  riskStress   + = more stress (high VIX level, widening HY spreads)
 *  inflSurprise + = core CPI m/m hotter than trailing 6-month mean (MODEL-based, not consensus)
 *  laborSurprise+ = payroll change stronger than trailing 6-month mean (MODEL-based, not consensus)
 *  ecbHawk      + = euro-area 2Y yield rising (proxy for ECB repricing)
 *  yieldDiffChg + = US-EA 10Y spread widening
 *  eaInflSurprise + = euro-area core HICP above trailing mean (MODEL-based)
 */
export function computeSignals(data: Data, now: Date): Signals {
  const p = (code: string, kind: Kind) => part(data, code, kind, now);
  return {
    usHawk: combine("usHawk", [[p("US_2Y_FF", "level"), 0.5], [p("DGS2", "change"), 0.5]]),
    realYield: combine("realYield", [[p("DFII10", "change"), 0.7], [p("DFII10", "level"), 0.3]]),
    nomYield: combine("nomYield", [[p("DGS10", "change"), 1]]),
    usd: combine("usd", [[p("DTWEXBGS", "change"), 1]]),
    riskStress: combine("riskStress", [[p("VIXCLS", "level"), 0.5], [p("BAMLH0A0HYM2", "change"), 0.5]]),
    inflSurprise: combine("inflSurprise", [[p("CORE_CPI_MOM", "surprise"), 1]], "Modelové prekvapenie (voči kĺzavému priemeru), nie voči konsenzu analytikov."),
    laborSurprise: combine("laborSurprise", [[p("NFP_CHG", "surprise"), 1]], "Modelové prekvapenie (voči kĺzavému priemeru), nie voči konsenzu analytikov."),
    ecbHawk: combine("ecbHawk", [[p("EA2Y", "change"), 1]]),
    yieldDiffChg: combine("yieldDiffChg", [[p("US10_EA10", "change"), 1]]),
    eaInflSurprise: combine("eaInflSurprise", [[p("EA_HICP_CORE", "surprise"), 1]], "Modelové prekvapenie (voči kĺzavému priemeru), nie voči konsenzu analytikov."),
  };
}
