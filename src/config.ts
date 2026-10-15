import type { Symbol } from "./types.ts";

export const MODEL_VERSION = "mvp-0.1.0";

export const SYMBOLS: Symbol[] = ["NQ", "GC", "EURUSD"];
export const SYMBOL_NAMES: Record<Symbol, string> = {
  NQ: "NQ (Nasdaq 100)",
  GC: "Zlato (GC / XAU)",
  EURUSD: "EUR/USD",
};

export type Frequency = "daily" | "weekly" | "monthly";

export interface IndicatorDef {
  code: string;
  name: string;
  unit: string;
  frequency: Frequency;
  provider: "FRED" | "ECB" | "DERIVED";
  /** FRED series id, or ECB "DATAFLOW/KEY" */
  ref: string;
  /** Warn (freshness starts decaying) when the latest observation is older than this many calendar days. */
  staleDays: number;
  /** Treat the indicator as unavailable when the latest observation is older than this. */
  expireDays: number;
  /** Source quality 0..1 (official daily = 1, documented proxy < 1). */
  quality: number;
  historyStart: string;
  derivedFrom?: string[];
  /** Used in the scoring engine. Context-only indicators are displayed but never scored. */
  scoring: boolean;
  note?: string;
  /** Third-party copyrighted series on FRED: used for scoring, but raw values are never published on the public site. */
  restricted?: boolean;
  /** Alternative refs for the SAME concept (e.g. after a provider renamed a dataset). The ref with the most recent data wins; series are never spliced. */
  altRefs?: string[];
  /**
   * Same series published earlier by its original source. Recent observations from it fill dates the main provider
   * does not have yet (definition and units are identical; values are never blended or interpolated).
   */
  supplement?: { provider: "TREASURY"; feed: "daily_treasury_yield_curve" | "daily_treasury_real_yield_curve"; field: string };
}

const D = { staleDays: 5, expireDays: 14 };
const M = { staleDays: 50, expireDays: 90 };

export const INDICATORS: IndicatorDef[] = [
  // ---- FRED (US) ----
  { code: "DFF", name: "Fed Funds Rate (efektívna)", unit: "%", frequency: "daily", provider: "FRED", ref: "DFF", ...D, quality: 1, historyStart: "2016-01-01", scoring: true },
  { code: "DGS2", name: "US 2Y výnos (CMT)", unit: "%", frequency: "daily", provider: "FRED", ref: "DGS2", ...D, quality: 1, historyStart: "2016-01-01", scoring: true, supplement: { provider: "TREASURY", feed: "daily_treasury_yield_curve", field: "BC_2YEAR" }, note: "Uzávierka dňa. Najnovší deň priamo z US Treasury (večer v deň obchodovania), história z FRED. Nie real-time." },
  { code: "DGS10", name: "US 10Y výnos (CMT)", unit: "%", frequency: "daily", provider: "FRED", ref: "DGS10", ...D, quality: 1, historyStart: "2016-01-01", scoring: true, supplement: { provider: "TREASURY", feed: "daily_treasury_yield_curve", field: "BC_10YEAR" }, note: "Uzávierka dňa. Najnovší deň priamo z US Treasury, história z FRED." },
  { code: "DFII10", name: "US 10Y reálny výnos (TIPS)", unit: "%", frequency: "daily", provider: "FRED", ref: "DFII10", ...D, quality: 1, historyStart: "2016-01-01", scoring: true, supplement: { provider: "TREASURY", feed: "daily_treasury_real_yield_curve", field: "TC_10YEAR" }, note: "Uzávierka dňa. Najnovší deň priamo z US Treasury, história z FRED." },
  { code: "DTWEXBGS", name: "Široký index USD (Fed, nominálny)", unit: "index", frequency: "daily", provider: "FRED", ref: "DTWEXBGS", staleDays: 10, expireDays: 30, quality: 0.7, historyStart: "2016-01-01", scoring: true, note: "Nie je to DXY. Fed H.10 index s oneskorením; obsahuje aj EUR (čiastočná cirkularita pre EUR/USD)." },
  { code: "VIXCLS", name: "VIX (uzávierka)", unit: "index", frequency: "daily", provider: "FRED", ref: "VIXCLS", ...D, quality: 0.9, historyStart: "2016-01-01", scoring: true, restricted: true, note: "Dáta © CBOE cez FRED. Hodnoty sa na webe nezverejňujú, iba vstupujú do skóre." },
  { code: "BAMLH0A0HYM2", name: "US High Yield OAS", unit: "%", frequency: "daily", provider: "FRED", ref: "BAMLH0A0HYM2", ...D, quality: 0.9, historyStart: "2016-01-01", scoring: true, restricted: true, note: "Dáta © ICE BofA cez FRED (história obmedzená licenciou). Hodnoty sa na webe nezverejňujú, iba vstupujú do skóre." },
  { code: "CPILFESL", name: "US Core CPI (index, SA)", unit: "index", frequency: "monthly", provider: "FRED", ref: "CPILFESL", ...M, quality: 1, historyStart: "2010-01-01", scoring: true },
  { code: "PAYEMS", name: "US Nonfarm Payrolls (úroveň, tis.)", unit: "tis.", frequency: "monthly", provider: "FRED", ref: "PAYEMS", ...M, quality: 1, historyStart: "2010-01-01", scoring: true },
  { code: "UNRATE", name: "US miera nezamestnanosti", unit: "%", frequency: "monthly", provider: "FRED", ref: "UNRATE", ...M, quality: 1, historyStart: "2010-01-01", scoring: true },
  // ---- ECB (eurozone) — kľúče ešte neboli overené živým volaním; pozri `npm run check-sources` ----
  { code: "EA2Y", name: "Eurozóna 2Y výnos (AAA krivka ECB)", unit: "%", frequency: "daily", provider: "ECB", ref: "YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y", ...D, quality: 0.7, historyStart: "2016-01-01", scoring: true, note: "Proxy: AAA krivka eurozóny, NIE nemecký Bund." },
  { code: "EA10Y", name: "Eurozóna 10Y výnos (AAA krivka ECB)", unit: "%", frequency: "daily", provider: "ECB", ref: "YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", ...D, quality: 0.7, historyStart: "2016-01-01", scoring: true, note: "Proxy: AAA krivka eurozóny, NIE nemecký Bund." },
  { code: "EA_HICP_CORE", name: "Eurozóna core HICP (r/r)", unit: "%", frequency: "monthly", provider: "ECB", ref: "ICP/M.U2.N.XEF000.4.ANR", altRefs: ["HICP/M.U2.N.XEF000.4D0.ANR", "HICP/M.U2.N.XEF000.4F0.ANR", "HICP/M.U2.N.XEF000.4.ANR"], ...M, expireDays: 100, quality: 1, historyStart: "2010-01-01", scoring: true, note: "ECB v 2026 presunula HICP do nového datasetu; použije sa kód s najnovšími dátami." },
  { code: "EA_DFR", name: "ECB depozitná sadzba", unit: "%", frequency: "daily", provider: "ECB", ref: "FM/D.U2.EUR.4F.KR.DFR.LEV", ...D, expireDays: 400, quality: 1, historyStart: "2016-01-01", scoring: false, note: "Iba kontext (sadzba sa mení zriedka)." },
  { code: "EURUSD_REF", name: "EUR/USD referenčný kurz ECB", unit: "USD", frequency: "daily", provider: "ECB", ref: "EXR/D.USD.EUR.SP00.A", ...D, quality: 1, historyStart: "2016-01-01", scoring: false, note: "Iba kontext; do skóre nevstupuje (vyhýbame sa cirkularite)." },
  // ---- Derived ----
  { code: "US_2Y_FF", name: "US 2Y − Fed Funds", unit: "pp", frequency: "daily", provider: "DERIVED", ref: "DGS2-DFF", ...D, quality: 1, historyStart: "2016-01-01", derivedFrom: ["DGS2", "DFF"], scoring: true, note: "Proxy trhových očakávaní politiky Fedu (záporné = trh cenuje znižovanie sadzieb). Nie sú to pravdepodobnosti." },
  { code: "US10_EA10", name: "US 10Y − EA 10Y", unit: "pp", frequency: "daily", provider: "DERIVED", ref: "DGS10-EA10Y", ...D, quality: 0.7, historyStart: "2016-01-01", derivedFrom: ["DGS10", "EA10Y"], scoring: true, note: "Rôzne konvencie kriviek; používajú sa iba zmeny, nie úroveň." },
  { code: "CORE_CPI_MOM", name: "US Core CPI m/m", unit: "%", frequency: "monthly", provider: "DERIVED", ref: "pct(CPILFESL)", ...M, quality: 1, historyStart: "2010-01-01", derivedFrom: ["CPILFESL"], scoring: true },
  { code: "NFP_CHG", name: "US NFP mesačná zmena", unit: "tis.", frequency: "monthly", provider: "DERIVED", ref: "diff(PAYEMS)", ...M, quality: 1, historyStart: "2010-01-01", derivedFrom: ["PAYEMS"], scoring: true },
];

export const INDICATORS_BY_CODE: Record<string, IndicatorDef> = Object.fromEntries(INDICATORS.map((i) => [i.code, i]));

export interface FactorSpec {
  code: string;
  weight: number;
  group: string;
  essential?: boolean;
}

/** Initial weights from the project spec. They are HYPOTHESES, not empirically validated. Sum per asset = 1. */
export const ASSET_FACTORS: Record<Symbol, FactorSpec[]> = {
  NQ: [
    { code: "fed_policy", weight: 0.3, group: "rates", essential: true },
    { code: "yields", weight: 0.25, group: "rates" },
    { code: "usd", weight: 0.1, group: "usd" },
    { code: "surprise", weight: 0.2, group: "surprise" },
    { code: "risk", weight: 0.15, group: "risk" },
  ],
  GC: [
    { code: "fed_policy", weight: 0.2, group: "rates" },
    { code: "real_yields", weight: 0.3, group: "rates", essential: true },
    { code: "usd", weight: 0.25, group: "usd" },
    { code: "surprise", weight: 0.1, group: "surprise" },
    { code: "risk", weight: 0.15, group: "risk" },
  ],
  EURUSD: [
    { code: "policy_diff", weight: 0.3, group: "rates", essential: true },
    { code: "yield_diff", weight: 0.15, group: "rates" },
    { code: "usd", weight: 0.3, group: "usd" },
    { code: "rel_surprise", weight: 0.2, group: "surprise" },
    { code: "risk", weight: 0.05, group: "risk" },
  ],
};

export const FACTOR_LABELS: Record<string, string> = {
  fed_policy: "Politika Fedu (trhové očakávania)",
  yields: "Výnosy (nominálne + reálne)",
  real_yields: "Reálne výnosy USA",
  usd: "Sila USD (široký index)",
  surprise: "Makro prekvapenia (model, nie konsenzus)",
  risk: "Rizikový sentiment",
  policy_diff: "Politika Fed vs ECB",
  yield_diff: "Rozdiel výnosov USA − eurozóna",
  rel_surprise: "Relatívne prekvapenia USA vs eurozóna (model)",
};

export const MODEL = {
  lag: 5, // observations used for "recent change" signals
  windowDaily: 750,
  minObsDaily: 120,
  windowMonthly: 60,
  minObsMonthly: 24,
  surpriseTrail: 6, // months used as the trailing "expectation" for model-based surprises
  clip: 3,
  coverageNormal: 0.85,
  coverageProvisional: 0.7,
  /** If all valid factors in a group agree in sign, their contributions are scaled by this haircut (double-count protection). */
  groupHaircut: 0.85,
  /** Classification boundaries on the continuous score (midpoints of the documented bands). */
  boundaryNeutral: 2.5,
  boundaryStrong: 6.5,
  hysteresis: 0.4,
  confidenceWeights: { coverage: 0.3, freshness: 0.25, agreement: 0.2, sourceQuality: 0.15, regimeCertainty: 0.1 },
  regime: {
    vixRiskOff: 30,
    hyZRiskOff: 2,
    coreCpi3mAnnInflation: 3.5,
    unrateRise6m: 0.3,
    policySpread: 0.25,
  },
};

/**
 * Static central-bank calendar. Verified on 2026-10-15 against federalreserve.gov and ecb.europa.eu
 * (the ECB page listed only upcoming 2026 meetings). The decision date is the LAST day of a meeting.
 * Re-verify yearly — this list is manual and will not update itself.
 */
export const STATIC_CALENDAR = [
  { date: "2026-10-28", name: "FOMC rozhodnutie", kind: "FOMC", importance: "high", source: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
  { date: "2026-12-09", name: "FOMC rozhodnutie (+ SEP)", kind: "FOMC", importance: "high", source: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" },
  { date: "2026-10-29", name: "ECB rozhodnutie o sadzbách", kind: "ECB", importance: "high", source: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html" },
  { date: "2026-12-17", name: "ECB rozhodnutie o sadzbách", kind: "ECB", importance: "high", source: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html" },
];

/** FRED release names worth surfacing as catalysts (matched case-insensitively as substrings). */
export const WATCHED_RELEASES: { match: string; label: string; importance: "high" | "medium" }[] = [
  { match: "Consumer Price Index", label: "US CPI", importance: "high" },
  { match: "Employment Situation", label: "US NFP / zamestnanosť", importance: "high" },
  { match: "Personal Income and Outlays", label: "US PCE", importance: "high" },
  { match: "Gross Domestic Product", label: "US HDP", importance: "high" },
  { match: "Producer Price Index", label: "US PPI", importance: "medium" },
  { match: "Advance Monthly Sales for Retail", label: "US maloobchodné tržby", importance: "medium" },
  { match: "Unemployment Insurance Weekly Claims", label: "US týždenné žiadosti o podporu", importance: "medium" },
];
