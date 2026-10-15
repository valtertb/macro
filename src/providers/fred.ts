import { fetchText } from "../http.ts";
import type { FetchOpts } from "../http.ts";
import type { Obs } from "../types.ts";

const BASE = "https://api.stlouisfed.org/fred";
// FRED documents 120 requests / 60 s per key; we stay well below that.
const FRED_OPTS: FetchOpts = { minIntervalMs: 600 };

/** FRED marks missing observations with "." — those are skipped, never interpolated. */
export function parseFredObservations(json: unknown): Obs[] {
  const rows = (json as { observations?: { date: string; value: string }[] })?.observations;
  if (!Array.isArray(rows)) throw new Error("Neočakávaná odpoveď FRED (chýba pole observations)");
  const out: Obs[] = [];
  for (const r of rows) {
    if (r.value === "." || r.value === "" || r.value == null) continue;
    const v = Number(r.value);
    if (Number.isFinite(v) && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) out.push({ date: r.date, value: v });
  }
  return out;
}

export async function fetchFredSeries(id: string, apiKey: string, start: string, opts: FetchOpts = {}): Promise<Obs[]> {
  const url = `${BASE}/series/observations?series_id=${encodeURIComponent(id)}&api_key=${apiKey}&file_type=json&observation_start=${start}`;
  const text = await fetchText(url, { ...FRED_OPTS, ...opts });
  return parseFredObservations(JSON.parse(text));
}

export interface ReleaseDate {
  date: string;
  name: string;
}

export function parseFredReleaseDates(json: unknown): ReleaseDate[] {
  const rows = (json as { release_dates?: { release_name?: string; date: string }[] })?.release_dates;
  if (!Array.isArray(rows)) throw new Error("Neočakávaná odpoveď FRED (chýba pole release_dates)");
  return rows.filter((r) => r.release_name && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => ({ date: r.date, name: r.release_name as string }));
}

export async function fetchFredReleaseDates(apiKey: string, from: string, to: string, opts: FetchOpts = {}): Promise<ReleaseDate[]> {
  const url =
    `${BASE}/releases/dates?api_key=${apiKey}&file_type=json&realtime_start=${from}&realtime_end=${to}` +
    `&include_release_dates_with_no_data=true&order_by=release_date&sort_order=asc&limit=1000`;
  const text = await fetchText(url, { ...FRED_OPTS, ...opts });
  return parseFredReleaseDates(JSON.parse(text));
}
