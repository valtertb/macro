import { fetchText } from "../http.ts";
import type { FetchOpts } from "../http.ts";
import type { Frequency } from "../config.ts";
import type { Obs } from "../types.ts";

const BASE = "https://data-api.ecb.europa.eu/service/data";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parses ECB Data Portal "csvdata" output. Daily periods are YYYY-MM-DD, monthly YYYY-MM (mapped to the 1st of the month).
 * Quarterly/annual periods are rejected — we never invent a date for them.
 */
export function parseEcbCsv(csv: string): Obs[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const ti = header.indexOf("TIME_PERIOD");
  const vi = header.indexOf("OBS_VALUE");
  if (ti < 0 || vi < 0) throw new Error("Neočakávaný formát ECB CSV (chýba TIME_PERIOD/OBS_VALUE)");
  const out: Obs[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const raw = cols[ti];
    const v = Number(cols[vi]);
    if (!raw || cols[vi] === "" || !Number.isFinite(v)) continue;
    let date: string | null = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) date = raw;
    else if (/^\d{4}-\d{2}$/.test(raw)) date = `${raw}-01`;
    if (date) out.push({ date, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchEcbSeries(ref: string, frequency: Frequency, start: string, opts: FetchOpts = {}): Promise<Obs[]> {
  const [flow, key] = ref.split("/");
  const startPeriod = frequency === "monthly" ? start.slice(0, 7) : start;
  const url = `${BASE}/${flow}/${key}?format=csvdata&startPeriod=${startPeriod}`;
  const text = await fetchText(url, { minIntervalMs: 300, ...opts });
  return parseEcbCsv(text);
}
