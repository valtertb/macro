/**
 * SYNTHETIC TEST FIXTURES — generated pseudo-random data, used ONLY by automated tests.
 * Nothing here is a real market observation and it must never be written to a production database.
 */
import type { Data, Obs } from "../src/types.ts";

export const NOW = new Date("2026-10-15T12:00:00Z"); // a Thursday

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

function businessDaysBack(end: Date, n: number): string[] {
  const out: string[] = [];
  const d = new Date(end);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

function monthsBack(lastMonth: string, n: number): string[] {
  const out: string[] = [];
  let [y, m] = lastMonth.split("-").map(Number);
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out.reverse();
}

function walk(dates: string[], start: number, step: number, r: () => number, lo = -Infinity, hi = Infinity): Obs[] {
  let v = start;
  return dates.map((date) => {
    v = Math.min(hi, Math.max(lo, v + gauss(r) * step));
    return { date, value: v };
  });
}

export function makeData(seed = 7): Data {
  const r = rng(seed);
  const days = businessDaysBack(NOW, 900);
  const months = monthsBack("2026-09", 100);
  let cpi = 300;
  const cpiS = months.map((date) => { cpi *= 1 + (0.0025 + gauss(r) * 0.0008); return { date, value: cpi }; });
  let pay = 150000;
  const payS = months.map((date) => { pay += 150 + gauss(r) * 70; return { date, value: pay }; });
  let hicp = 2.5;
  const hicpS = months.map((date) => { hicp += gauss(r) * 0.12; return { date, value: hicp }; });
  return {
    DFF: walk(days, 4.0, 0.01, r, 3, 5),
    DGS2: walk(days, 4.0, 0.04, r, 1, 6),
    DGS10: walk(days, 4.3, 0.045, r, 1, 7),
    DFII10: walk(days, 1.9, 0.04, r, -1, 4),
    DTWEXBGS: walk(days, 120, 0.25, r, 90, 150),
    VIXCLS: walk(days, 17, 0.9, r, 10, 28),
    BAMLH0A0HYM2: walk(days, 3.0, 0.04, r, 2, 6),
    CPILFESL: cpiS,
    PAYEMS: payS,
    UNRATE: walk(months, 4.2, 0.05, r, 3, 5),
    EA2Y: walk(days, 2.3, 0.04, r, 0, 5),
    EA10Y: walk(days, 2.9, 0.04, r, 0, 5),
    EA_HICP_CORE: hicpS,
  };
}

/** Adds `delta` to the last `n` observations (so the n-observation change moves by exactly `delta`). */
export function bump(data: Data, code: string, delta: number, n = 5): Data {
  const s = data[code].map((o) => ({ ...o }));
  for (let i = s.length - n; i < s.length; i++) s[i].value += delta;
  return { ...data, [code]: s };
}

export function without(data: Data, ...codes: string[]): Data {
  const out = { ...data };
  for (const c of codes) delete out[c];
  return out;
}

/** Shifts all dates of a series back by `days` (simulates a stale feed). */
export function age(data: Data, code: string, days: number): Data {
  const s = data[code].map((o) => ({ ...o, date: new Date(Date.parse(o.date + "T00:00:00Z") - days * 86400000).toISOString().slice(0, 10) }));
  return { ...data, [code]: s };
}
