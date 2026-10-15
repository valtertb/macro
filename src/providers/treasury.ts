import { fetchText } from "../http.ts";
import type { FetchOpts } from "../http.ts";
import type { Obs } from "../types.ts";

/**
 * Official US Treasury daily interest-rate XML feed (free, no key):
 * https://home.treasury.gov/treasury-daily-interest-rate-xml-feed
 * Publishes the par yield curve (BC_* fields) and par real yield curve (TC_* fields) at the end of each business day,
 * typically about a day before the same values appear on FRED (DGS2 / DGS10 / DFII10 are these same Treasury series).
 */
const BASE = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";

export type TreasuryFeed = "daily_treasury_yield_curve" | "daily_treasury_real_yield_curve";

/** Extracts one field from every <entry>. Namespace prefixes are ignored; null/empty values are skipped (never filled). */
export function parseTreasuryXml(xml: string, field: string): Obs[] {
  const out: Obs[] = [];
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
  const tag = (name: string) => new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`);
  for (const e of entries) {
    const d = e.match(tag("NEW_DATE"))?.[1]?.trim();
    const v = e.match(tag(field))?.[1]?.trim();
    if (!d || !v) continue;
    const date = d.slice(0, 10);
    const num = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(num)) out.push({ date, value: num });
  }
  if (!entries.length && !/<feed[\s>]/.test(xml)) throw new Error("Neočakávaná odpoveď US Treasury (nie je to XML feed)");
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchTreasuryMonth(feed: TreasuryFeed, yyyymm: string, opts: FetchOpts = {}): Promise<string> {
  return fetchText(`${BASE}?data=${feed}&field_tdr_date_value_month=${yyyymm}`, { minIntervalMs: 500, ...opts });
}

/** Months to fetch: the current and the previous one (covers month boundaries and late revisions). */
export function recentMonths(now: Date): string[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const fmt = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return [fmt(prev), fmt(new Date(Date.UTC(y, m, 1)))];
}
