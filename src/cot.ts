/**
 * COT positioning panel. Context only — it does NOT enter the macro score:
 * the data is weekly, positions are as of Tuesday and published on Friday, and its value as an intraday signal
 * is unproven. Extremes (COT index ≥ 90 or ≤ 10) are flagged as crowded positioning.
 */
import type { CotRow } from "./providers/cftc.ts";
import { fetchCot } from "./providers/cftc.ts";
import { redact } from "./http.ts";
import type { Symbol } from "./types.ts";

export const COT_MARKETS: { symbol: Symbol; code: string; label: string }[] = [
  { symbol: "NQ", code: "209742", label: "Nasdaq mini (CME)" },
  { symbol: "GC", code: "088691", label: "Zlato (COMEX)" },
  { symbol: "EURUSD", code: "099741", label: "Euro FX (CME)" },
];

export const COT_LOOKBACK_WEEKS = 156; // 3 years
export const COT_MIN_WEEKS = 52;
export const COT_EXTREME_HIGH = 90;
export const COT_EXTREME_LOW = 10;
const STALE_DAYS = 11; // a normal report is 9 days old just before the next release

export interface CotGroup {
  net: number;
  change: number | null; // vs previous week
  pctOi: number; // net as % of open interest
  index: number | null; // 0..100 position of net within the lookback range
}

export interface CotSummary {
  symbol: Symbol;
  code: string;
  label: string;
  market: string;
  date: string; // positions as of (Tuesday)
  ageDays: number;
  stale: boolean;
  openInterest: number;
  weeks: number;
  spec: CotGroup;
  comm: CotGroup;
  small: CotGroup;
  signal: "crowded_long" | "crowded_short" | "none" | "insufficient";
  signalText: string;
  history: { date: string; specNet: number; commNet: number }[];
}

export interface CotResult {
  generatedAt: string;
  source: string;
  markets: CotSummary[];
  errors: { symbol: Symbol; error: string }[];
}

/** Williams-style COT index: where the latest value sits between the min and max of the lookback window (0..100). */
export function cotIndex(values: number[]): number | null {
  if (values.length < COT_MIN_WEEKS) return null;
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return null;
  return ((last - min) / (max - min)) * 100;
}

function group(rows: CotRow[], net: (r: CotRow) => number): CotGroup {
  const nets = rows.map(net);
  const last = rows[rows.length - 1];
  const n = nets[nets.length - 1];
  return {
    net: n,
    change: nets.length >= 2 ? n - nets[nets.length - 2] : null,
    pctOi: last.openInterest > 0 ? (n / last.openInterest) * 100 : 0,
    index: cotIndex(nets.slice(-COT_LOOKBACK_WEEKS)),
  };
}

export function summarize(symbol: Symbol, code: string, label: string, rows: CotRow[], now: Date): CotSummary {
  if (!rows.length) throw new Error("CFTC nevrátil žiadne riadky");
  const last = rows[rows.length - 1];
  const ageDays = Math.floor((now.getTime() - Date.parse(last.date + "T00:00:00Z")) / 86_400_000);
  const spec = group(rows, (r) => r.specLong - r.specShort);
  const comm = group(rows, (r) => r.commLong - r.commShort);
  const small = group(rows, (r) => r.smallLong - r.smallShort);
  let signal: CotSummary["signal"] = "none";
  let signalText = "Pozície špekulantov nie sú v extréme.";
  if (spec.index === null) {
    signal = "insufficient";
    signalText = `Málo histórie na COT index (potrebných ${COT_MIN_WEEKS} týždňov).`;
  } else if (spec.index >= COT_EXTREME_HIGH) {
    signal = "crowded_long";
    signalText = `Špekulanti sú extrémne long (index ${Math.round(spec.index)}/100): preplnený long, rastie riziko výplachu longov pri negatívnom impulze.`;
  } else if (spec.index <= COT_EXTREME_LOW) {
    signal = "crowded_short";
    signalText = `Špekulanti sú extrémne short (index ${Math.round(spec.index)}/100): preplnený short, rastie riziko short squeeze pri pozitívnom impulze.`;
  }
  return {
    symbol, code, label, market: last.market, date: last.date, ageDays, stale: ageDays > STALE_DAYS,
    openInterest: last.openInterest, weeks: rows.length, spec, comm, small, signal, signalText,
    history: rows.slice(-COT_LOOKBACK_WEEKS).map((r) => ({ date: r.date, specNet: r.specLong - r.specShort, commNet: r.commLong - r.commShort })),
  };
}

export type CotFetcher = (code: string, weeks: number) => Promise<CotRow[]>;

export async function loadCot(now: Date = new Date(), fetcher: CotFetcher = (c, w) => fetchCot(c, w)): Promise<CotResult> {
  const markets: CotSummary[] = [];
  const errors: { symbol: Symbol; error: string }[] = [];
  for (const m of COT_MARKETS) {
    try {
      markets.push(summarize(m.symbol, m.code, m.label, await fetcher(m.code, COT_LOOKBACK_WEEKS + 2), now));
    } catch (e) {
      errors.push({ symbol: m.symbol, error: redact(e instanceof Error ? e.message : String(e)) });
    }
  }
  return { generatedAt: now.toISOString(), source: "CFTC Commitments of Traders — Legacy, Futures Only", markets, errors };
}
