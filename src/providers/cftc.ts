import { fetchText } from "../http.ts";
import type { FetchOpts } from "../http.ts";

/**
 * CFTC Commitments of Traders — Legacy, Futures Only (official, free, no key).
 * Public Reporting Environment (Socrata): https://publicreporting.cftc.gov/resource/6dca-aqww.json
 * Positions are as of Tuesday; CFTC normally publishes them on Friday 15:30 ET.
 */
const BASE = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

export interface CotRow {
  date: string; // report date (positions as of this Tuesday)
  market: string;
  openInterest: number;
  specLong: number; // non-commercial
  specShort: number;
  commLong: number; // commercial
  commShort: number;
  smallLong: number; // non-reportable
  smallShort: number;
}

const FIELDS = [
  "report_date_as_yyyy_mm_dd", "market_and_exchange_names", "open_interest_all",
  "noncomm_positions_long_all", "noncomm_positions_short_all",
  "comm_positions_long_all", "comm_positions_short_all",
  "nonrept_positions_long_all", "nonrept_positions_short_all",
];

export function parseCot(json: unknown): CotRow[] {
  if (!Array.isArray(json)) throw new Error("Neočakávaná odpoveď CFTC (nie je to pole)");
  const out: CotRow[] = [];
  for (const r of json as Record<string, string>[]) {
    const date = String(r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    const n = (k: string) => Number(r[k]);
    const row: CotRow = {
      date,
      market: String(r.market_and_exchange_names ?? "").trim(),
      openInterest: n("open_interest_all"),
      specLong: n("noncomm_positions_long_all"),
      specShort: n("noncomm_positions_short_all"),
      commLong: n("comm_positions_long_all"),
      commShort: n("comm_positions_short_all"),
      smallLong: n("nonrept_positions_long_all"),
      smallShort: n("nonrept_positions_short_all"),
    };
    const nums = [row.openInterest, row.specLong, row.specShort, row.commLong, row.commShort, row.smallLong, row.smallShort];
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && nums.every(Number.isFinite)) out.push(row);
  }
  // one row per report date, oldest first
  const byDate = new Map(out.map((r) => [r.date, r]));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchCot(contractCode: string, weeks: number, opts: FetchOpts = {}): Promise<CotRow[]> {
  const q = new URLSearchParams({
    cftc_contract_market_code: contractCode,
    $select: FIELDS.join(","),
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: String(weeks),
  });
  const text = await fetchText(`${BASE}?${q}`, { minIntervalMs: 500, ...opts });
  return parseCot(JSON.parse(text));
}
