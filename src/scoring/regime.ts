import { MODEL } from "../config.ts";
import { robustZ } from "../stats.ts";
import type { Data, Regime } from "../types.ts";
import { freshnessOf } from "./signals.ts";

export interface RegimeInfo {
  regime: Regime;
  certainty: number; // 0..1
  reasons: string[];
}

export const REGIME_LABELS: Record<Regime, string> = {
  inflation_dominant: "Dominuje inflácia",
  growth_dominant: "Dominuje spomalenie rastu",
  monetary_easing: "Uvoľňovanie politiky",
  monetary_tightening: "Sprísňovanie politiky",
  risk_off: "Risk-off / finančný stres",
  mixed: "Zmiešaný / neistý",
};

function lastFresh(data: Data, code: string, now: Date) {
  const s = data[code];
  if (!s?.length) return null;
  const o = s[s.length - 1];
  return freshnessOf(code, o.date, now) > 0 ? o : null;
}

/**
 * Transparent, rule-based regime classifier (no LLM). Rules are evaluated in order, first match wins.
 * Thresholds live in MODEL.regime and are hypotheses, not validated parameters.
 */
export function classifyRegime(data: Data, now: Date): RegimeInfo {
  const R = MODEL.regime;
  const reasons: string[] = [];

  const vix = lastFresh(data, "VIXCLS", now);
  if (vix && vix.value >= R.vixRiskOff) {
    return { regime: "risk_off", certainty: 0.8, reasons: [`VIX nad prahom ${R.vixRiskOff} (${vix.date})`] };
  }
  const hy = data.BAMLH0A0HYM2;
  if (hy?.length && lastFresh(data, "BAMLH0A0HYM2", now)) {
    const vals = hy.map((o) => o.value);
    const z = robustZ(vals.slice(-MODEL.windowDaily - 1, -1), vals[vals.length - 1], { minObs: MODEL.minObsDaily, clip: 5 });
    if (z !== null && z >= R.hyZRiskOff) {
      return { regime: "risk_off", certainty: 0.7, reasons: [`HY OAS z-skóre ${z.toFixed(2)} ≥ ${R.hyZRiskOff}`] };
    }
  }

  let available = 0;

  const cpi = data.CPILFESL;
  if (cpi && cpi.length >= 4 && lastFresh(data, "CPILFESL", now)) {
    available++;
    const ann = (Math.pow(cpi[cpi.length - 1].value / cpi[cpi.length - 4].value, 4) - 1) * 100;
    reasons.push(`Core CPI 3m anualizovane ${ann.toFixed(2)} %`);
    if (ann >= R.coreCpi3mAnnInflation) {
      return { regime: "inflation_dominant", certainty: 0.8, reasons };
    }
  }

  const ur = data.UNRATE;
  if (ur && ur.length >= 7 && lastFresh(data, "UNRATE", now)) {
    available++;
    const rise = ur[ur.length - 1].value - ur[ur.length - 7].value;
    reasons.push(`Nezamestnanosť zmena za 6 mes. ${rise >= 0 ? "+" : ""}${rise.toFixed(2)} pp`);
    if (rise >= R.unrateRise6m) {
      return { regime: "growth_dominant", certainty: 0.7, reasons };
    }
  }

  const sp = data.US_2Y_FF;
  if (sp?.length && lastFresh(data, "US_2Y_FF", now)) {
    available++;
    const v = sp[sp.length - 1].value;
    reasons.push(`US 2Y − Fed Funds ${v >= 0 ? "+" : ""}${v.toFixed(2)} pp`);
    if (v <= -R.policySpread) return { regime: "monetary_easing", certainty: 0.6, reasons };
    if (v >= R.policySpread) return { regime: "monetary_tightening", certainty: 0.6, reasons };
  }

  if (available < 2) {
    return { regime: "mixed", certainty: 0.3, reasons: [...reasons, "Nedostatok vstupov na spoľahlivú klasifikáciu režimu"] };
  }
  return { regime: "mixed", certainty: 0.3, reasons: [...reasons, "Žiadne pravidlo režimu nebolo splnené"] };
}
