import type { Obs } from "./types.ts";

export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mad(a: number[], med: number = median(a)): number {
  return median(a.map((x) => Math.abs(x - med)));
}

/**
 * Robust z-score: (x - median) / (1.4826 * MAD), clipped to [-clip, clip].
 * Fallback when MAD == 0: 1.2533 * mean absolute deviation (documented).
 * Returns null when history is too short or has no dispersion (factor unavailable, never silently 0).
 */
export function robustZ(
  history: number[],
  x: number,
  opts: { minObs?: number; clip?: number } = {},
): number | null {
  const minObs = opts.minObs ?? 60;
  const clip = opts.clip ?? 3;
  const h = history.filter(Number.isFinite);
  if (h.length < minObs || !Number.isFinite(x)) return null;
  const med = median(h);
  let scale = 1.4826 * mad(h, med);
  if (!(scale > 0)) {
    const meanAbs = h.reduce((s, v) => s + Math.abs(v - med), 0) / h.length;
    scale = 1.2533 * meanAbs;
    if (!(scale > 0)) return null;
  }
  return Math.max(-clip, Math.min(clip, (x - med) / scale));
}

/** Maps a z-score to a factor score in [-10, 10]. */
export const score10 = (z: number): number => 10 * Math.tanh(z / 2);

/** v[i] - v[i-lag] for i >= lag (lag counted in observations, not calendar days). */
export function changes(values: number[], lag: number): number[] {
  const out: number[] = [];
  for (let i = lag; i < values.length; i++) out.push(values[i] - values[i - lag]);
  return out;
}

/** Inner-join two series on date and combine values. Result is sorted by date. */
export function joinSeries(a: Obs[], b: Obs[], op: (x: number, y: number) => number): Obs[] {
  const bm = new Map(b.map((o) => [o.date, o.value]));
  const out: Obs[] = [];
  for (const o of a) {
    const y = bm.get(o.date);
    if (y !== undefined) out.push({ date: o.date, value: op(o.value, y) });
  }
  return out;
}

/**
 * As-of join: for each date in `a`, use the latest `b` observation on or before that date, but only if it is at most
 * `maxGapDays` old. Meant for step-like series such as a policy rate (carrying the last known level, never interpolating).
 */
export function asOfJoin(a: Obs[], b: Obs[], op: (x: number, y: number) => number, maxGapDays: number): Obs[] {
  const out: Obs[] = [];
  let j = -1;
  for (const o of a) {
    while (j + 1 < b.length && b[j + 1].date <= o.date) j++;
    if (j < 0) continue;
    const gap = (Date.parse(o.date) - Date.parse(b[j].date)) / 86_400_000;
    if (gap <= maxGapDays) out.push({ date: o.date, value: op(o.value, b[j].value) });
  }
  return out;
}

/** Percent change vs previous observation, in percent. */
export function pctChange(s: Obs[]): Obs[] {
  const out: Obs[] = [];
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].value !== 0) out.push({ date: s[i].date, value: (s[i].value / s[i - 1].value - 1) * 100 });
  }
  return out;
}

export function diffSeries(s: Obs[]): Obs[] {
  const out: Obs[] = [];
  for (let i = 1; i < s.length; i++) out.push({ date: s[i].date, value: s[i].value - s[i - 1].value });
  return out;
}

/** dev[i] = v[i] - mean(v[i-n .. i-1]) for i >= n. Index k of the result corresponds to input index k+n. */
export function deviationFromTrailingMean(values: number[], n: number): number[] {
  const out: number[] = [];
  for (let i = n; i < values.length; i++) {
    let sum = 0;
    for (let j = i - n; j < i; j++) sum += values[j];
    out.push(values[i] - sum / n);
  }
  return out;
}
