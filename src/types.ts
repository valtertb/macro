export type Obs = { date: string; value: number }; // date = YYYY-MM-DD (UTC)
export type Data = Record<string, Obs[]>;

export type Symbol = "NQ" | "GC" | "EURUSD";
export type Regime =
  | "inflation_dominant"
  | "growth_dominant"
  | "monetary_easing"
  | "monetary_tightening"
  | "risk_off"
  | "mixed";

export type Classification = "strong_bearish" | "bearish" | "neutral" | "bullish" | "strong_bullish";
export type BiasStatus = "normal" | "provisional" | "insufficient";

export interface SignalInput {
  indicator: string;
  date: string;
  value: number;
  delta?: number;
  kind: "change" | "level" | "surprise";
}

export interface Signal {
  name: string;
  z: number; // robust z-score, natural direction (documented per signal in signals.ts)
  freshness: number; // 0..1
  quality: number; // 0..1 (source quality)
  inputs: SignalInput[];
  note?: string;
}

export interface FactorResult {
  code: string;
  label: string;
  group: string;
  weight: number;
  available: boolean;
  z: number | null; // asset-directional z (positive = supports higher price of the asset)
  score: number | null; // 10*tanh(z/2), in [-10, 10]
  contribution: number | null; // weight * score (after group haircut), uncorrected by coverage
  freshness: number;
  quality: number;
  inputs: SignalInput[];
  notes: string[];
}

export interface BiasResult {
  symbol: Symbol;
  calculatedAt: string;
  version: string;
  status: BiasStatus;
  rawScore: number | null;
  displayedScore: number | null;
  classification: Classification | null;
  confidence: number | null;
  confidenceParts: Record<string, number> | null;
  coverage: number;
  missingEssential: string[];
  regime: Regime;
  regimeCertainty: number;
  regimeReasons: string[];
  factors: FactorResult[];
  inputHash: string;
}
