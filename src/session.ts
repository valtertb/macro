/**
 * Session bias: turns the macro score into one clear, rule-based verdict per trading session.
 * Deterministic and documented — no LLM. It is a CONTEXT filter for the trader's own setups, not an entry signal.
 *
 *  London open 09:00 Bratislava -> EUR/USD
 *  NY open     15:30 Bratislava -> Gold, NQ
 */
import type { CotSummary } from "./cot.ts";
import type { BiasResult, Symbol } from "./types.ts";

export const SESSION_RULES = {
  noBias: 1.0, // |score| below this -> NO BIAS
  bias: 2.5, // lean below, bias above
  strong: 6.5,
  minConfidence: 60, // below -> one step weaker
};

export type Direction = "long" | "short" | "none";
export type Strength = "none" | "lean" | "bias" | "strong";

export interface SessionMarket {
  symbol: Symbol;
  name: string;
  direction: Direction;
  strength: Strength;
  verdict: string; // e.g. "SHORT BIAS"
  headline: string; // e.g. "Mierny short bias"
  score: number | null;
  confidence: number | null;
  reason: string;
  playbook: string;
  invalidation: string | null;
  warnings: string[];
  downgrades: string[];
}

export interface SessionBlock {
  id: "london" | "ny";
  title: string;
  openLocal: string; // HH:MM Bratislava
  markets: SessionMarket[];
  events: { time: string; name: string; when: "before" | "during" | "after" }[];
}

export interface SessionBias {
  date: string; // Bratislava date
  weekend: boolean;
  dataAsOf: string | null;
  sessions: SessionBlock[];
  rules: typeof SESSION_RULES;
}

const STEPS: Strength[] = ["none", "lean", "bias", "strong"];

export interface CalEvent { date: string; name: string; kind: string; importance: string }

/** Converts a wall-clock time in a time zone to a UTC Date (DST-aware via Intl). */
export function zonedToUtc(date: string, hm: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (asTz - guess));
}

const localHM = (d: Date) => d.toLocaleTimeString("sk-SK", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit" });
export const bratislavaDate = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Bratislava" });

/** Release times: US data 08:30 ET, FOMC statement 14:00 ET, ECB decision 14:15 Frankfurt. */
function eventTime(e: CalEvent): Date {
  if (e.kind === "FOMC") return zonedToUtc(e.date, "14:00", "America/New_York");
  if (e.kind === "ECB") return zonedToUtc(e.date, "14:15", "Europe/Berlin");
  return zonedToUtc(e.date, "08:30", "America/New_York");
}

function affects(e: CalEvent, s: Symbol): boolean {
  if (e.kind === "ECB") return s === "EURUSD";
  return true; // US data and FOMC move all three
}

export function classifyDirection(score: number | null): { direction: Direction; strength: Strength } {
  if (score === null) return { direction: "none", strength: "none" };
  const a = Math.abs(score);
  const strength: Strength = a < SESSION_RULES.noBias ? "none" : a < SESSION_RULES.bias ? "lean" : a < SESSION_RULES.strong ? "bias" : "strong";
  return { direction: strength === "none" ? "none" : score > 0 ? "long" : "short", strength };
}

const SIDE = { long: "LONG", short: "SHORT", none: "" } as const;

export function marketVerdict(b: BiasResult, name: string, cot: CotSummary | undefined, events: CalEvent[], sessionOpen: Date): SessionMarket {
  const downgrades: string[] = [];
  const warnings: string[] = [];
  let { direction, strength } = classifyDirection(b.status === "insufficient" ? null : b.displayedScore);

  if (b.status === "insufficient") downgrades.push("Nedostatok dát, skóre sa nepočíta.");
  const step = (why: string) => {
    if (strength === "none") return;
    strength = STEPS[STEPS.indexOf(strength) - 1];
    if (strength === "none") direction = "none";
    downgrades.push(why);
  };
  if (b.status === "provisional") step("Provizórne skóre (chýba časť dát) → o stupeň slabšie.");
  if (b.confidence !== null && b.confidence < SESSION_RULES.minConfidence) step(`Nízka istota (${b.confidence}/100) → o stupeň slabšie.`);

  // Event risk on the session day
  for (const e of events.filter((x) => affects(x, b.symbol) && x.importance === "high")) {
    const t = eventTime(e);
    const mins = Math.round((t.getTime() - sessionOpen.getTime()) / 60000);
    if (mins <= 0 && mins > -180) warnings.push(`${e.name} o ${localHM(t)}, pred otvorením. Bias je platný až po aktualizácii stránky po dátach; pri prekvapení môže otočiť.`);
    else if (mins > 0 && mins <= 480) warnings.push(`${e.name} o ${localHM(t)}, počas session. Pred dátami opatrne, po nich sa bias prepočíta.`);
  }

  // COT crowding
  if (cot && !cot.stale && direction !== "none") {
    if ((cot.signal === "crowded_long" && direction === "long") || (cot.signal === "crowded_short" && direction === "short")) {
      warnings.push(`COT: špekulanti sú už extrémne ${direction === "long" ? "long" : "short"}, pozícia v smere biasu je preplnená. Ber zisky skôr a neprenášaj cez dáta.`);
    } else if ((cot.signal === "crowded_short" && direction === "long") || (cot.signal === "crowded_long" && direction === "short")) {
      warnings.push(`COT: špekulanti sú extrémne ${cot.signal === "crowded_short" ? "short" : "long"}, proti biasu. Pri impulze v smere biasu hrozí ${cot.signal === "crowded_short" ? "short squeeze" : "výplach longov"}, čo bias podporuje.`);
    }
  }

  const valid = b.factors.filter((f) => f.available && f.contribution !== null);
  const top = [...valid].sort((x, y) => Math.abs(y.contribution!) - Math.abs(x.contribution!));
  const withDir = direction === "none" ? top : top.filter((f) => Math.sign(f.contribution!) === (direction === "long" ? 1 : -1));
  const against = direction === "none" ? [] : top.filter((f) => Math.sign(f.contribution!) === (direction === "long" ? -1 : 1));
  const reason = direction === "none"
    ? (b.status === "insufficient" ? "Nedostatok dát." : `Faktory sa navzájom rušia (skóre ${fmt(b.displayedScore)}).${top[0] ? ` Najsilnejší: ${top[0].label} (${fmt(top[0].contribution!, 2)}).` : ""}`)
    : `Ťahá: ${withDir.slice(0, 2).map((f) => `${f.label} (${fmt(f.contribution!, 2)})`).join(", ") || "—"}.${against[0] ? ` Proti: ${against[0].label} (${fmt(against[0].contribution!, 2)}).` : ""}`;

  const playbook = direction === "none"
    ? "Makro nedáva výhodu. Obchoduj iba svoje A+ setupy podľa technickej štruktúry, alebo NO TRADE."
    : strength === "lean"
      ? `Mierna preferencia ${SIDE[direction]}. ${SIDE[direction]} setupy berieš normálne, ${direction === "long" ? "SHORT" : "LONG"} iba A+ s jasným potvrdením.`
      : `Preferuj ${SIDE[direction]}. ${direction === "long" ? "SHORT" : "LONG"} proti makru len výnimočne (A+ a znížené riziko).`;

  const invalidation = direction === "none" || !withDir[0]
    ? null
    : `Bias padá, ak sa otočí „${withDir[0].label}“ alebo skóre klesne pod ${SESSION_RULES.noBias.toFixed(1)} v absolútnej hodnote pri ďalšej aktualizácii.`;

  const headline = direction === "none" ? "Bez biasu"
    : strength === "lean" ? `Mierny ${SIDE[direction].toLowerCase()} bias` : strength === "strong" ? `Silný ${SIDE[direction].toLowerCase()} bias` : `${SIDE[direction][0]}${SIDE[direction].slice(1).toLowerCase()} bias`;

  return {
    symbol: b.symbol, name, direction, strength,
    verdict: direction === "none" ? "BEZ BIASU" : `${SIDE[direction]} BIAS`,
    headline, score: b.displayedScore, confidence: b.confidence, reason, playbook, invalidation, warnings, downgrades,
  };
}

const fmt = (x: number | null, d = 1) => (x === null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(d));

export function sessionBias(
  assets: { symbol: Symbol; name: string; bias: BiasResult }[],
  cot: CotSummary[],
  calendar: CalEvent[],
  now: Date,
): SessionBias {
  const date = bratislavaDate(now);
  const wd = new Date(date + "T12:00:00Z").getUTCDay();
  const weekend = wd === 0 || wd === 6;
  const todays = calendar.filter((e) => e.date === date);
  const get = (s: Symbol) => assets.find((a) => a.symbol === s);
  const latest = assets.flatMap((a) => a.bias.factors.flatMap((f) => f.inputs.map((i) => i.date))).sort().at(-1) ?? null;

  const block = (id: "london" | "ny", title: string, openHM: string, symbols: Symbol[]): SessionBlock => {
    const open = zonedToUtc(date, openHM, "Europe/Bratislava");
    return {
      id, title, openLocal: openHM,
      markets: symbols.flatMap((s) => {
        const a = get(s);
        return a ? [marketVerdict(a.bias, a.name, cot.find((c) => c.symbol === s), todays, open)] : [];
      }),
      events: todays.map((e) => {
        const t = eventTime(e);
        const mins = (t.getTime() - open.getTime()) / 60000;
        return { time: localHM(t), name: e.name, when: mins <= 0 ? "before" : mins <= 480 ? "during" : "after" } as const;
      }),
    };
  };

  return {
    date, weekend, dataAsOf: latest,
    sessions: [block("london", "London open", "09:00", ["EURUSD"]), block("ny", "NY open", "15:30", ["GC", "NQ"])],
    rules: SESSION_RULES,
  };
}
