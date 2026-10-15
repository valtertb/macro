import { INDICATORS_BY_CODE, MODEL, SYMBOL_NAMES } from "../config.ts";
import type { BiasResult, Classification, FactorResult, SignalInput } from "../types.ts";
import { REGIME_LABELS } from "./regime.ts";

export const CLASS_LABELS: Record<Classification, string> = {
  strong_bearish: "Silno medvedí",
  bearish: "Medvedí",
  neutral: "Neutrálne",
  bullish: "Býčie",
  strong_bullish: "Silno býčie",
};

export interface Catalyst {
  date: string;
  name: string;
  importance: string;
  source: string;
}

export interface Explanation {
  summary: string;
  bullish: string[];
  bearish: string[];
  conflicts: string[];
  catalysts: string[];
  invalidation: string[];
  confidence: string;
  caveats: string[];
}

const sgn = (x: number, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

export function evidenceLine(i: SignalInput): string {
  const def = INDICATORS_BY_CODE[i.indicator];
  const name = def?.name ?? i.indicator;
  const unit = def?.unit ?? "";
  const src = def?.provider === "DERIVED" ? "odvodené" : (def?.provider ?? "");
  if (def?.restricted) return `${name}: hodnota sa nezverejňuje (licencia zdroja), vstupuje do skóre (k ${i.date}, ${src})`;
  const what =
    i.kind === "change" ? `zmena za ${MODEL.lag} pozorovaní ${i.delta !== undefined ? sgn(i.delta) : "n/a"} ${unit}`
    : i.kind === "surprise" ? `odchýlka od priemeru ${MODEL.surpriseTrail} mes. ${i.delta !== undefined ? sgn(i.delta) : "n/a"} ${unit}`
    : `úroveň ${i.value.toFixed(2)} ${unit}`;
  return `${name}: ${what} (k ${i.date}, ${src})`;
}

function driverLine(f: FactorResult): string {
  const ev = f.inputs.slice(0, 3).map(evidenceLine).join("; ");
  return `${f.label}: skóre ${sgn(f.score as number, 1)}, príspevok ${sgn(f.contribution as number)} — ${ev}`;
}

export function explain(b: BiasResult, catalysts: Catalyst[]): Explanation {
  const name = SYMBOL_NAMES[b.symbol];
  const valid = b.factors.filter((f) => f.available);
  const caveats = [
    "Dáta sú denné/mesačné z verejných zdrojov (nie real-time). Skóre je makro kontext dňa, nie intraday signál ani garancia výsledku.",
  ];
  for (const f of valid) {
    for (const i of f.inputs) {
      const def = INDICATORS_BY_CODE[i.indicator];
      if (def && f.freshness < 1) caveats.push(`Zastaraný vstup: ${def.name} (posledný záznam ${i.date}).`);
    }
    for (const n of f.notes) if (!caveats.includes(n)) caveats.push(n);
  }
  for (const f of b.factors.filter((x) => !x.available)) caveats.push(`Nedostupný faktor: ${f.label}. ${f.notes[0] ?? ""}`.trim());
  const uniqCaveats = [...new Set(caveats)];

  if (b.status === "insufficient" || b.displayedScore === null || b.classification === null) {
    const miss = b.missingEssential.length ? ` Chýbajú kľúčové faktory: ${b.missingEssential.join(", ")}.` : "";
    return {
      summary: `Nedostatok dát pre ${name}: pokrytie ${(b.coverage * 100).toFixed(0)} % (potrebných ≥ ${(MODEL.coverageProvisional * 100).toFixed(0)} %).${miss} Definitívne skóre sa nezobrazuje.`,
      bullish: [], bearish: [], conflicts: [],
      catalysts: catalysts.map(catalystLine),
      invalidation: [],
      confidence: "Istotu nie je možné vyhodnotiť bez dostatočného pokrytia dát.",
      caveats: uniqCaveats,
    };
  }

  const byContribution = [...valid].sort((a, b2) => (b2.contribution as number) - (a.contribution as number));
  const top = [...valid].sort((a, b2) => Math.abs(b2.contribution as number) - Math.abs(a.contribution as number))[0];
  const bullish = byContribution.filter((f) => (f.contribution as number) > 0).slice(0, 3).map(driverLine);
  const bearish = byContribution.filter((f) => (f.contribution as number) < 0).reverse().slice(0, 3).map(driverLine);

  const conflicts: string[] = [];
  const strongPos = valid.filter((f) => (f.score as number) >= 2);
  const strongNeg = valid.filter((f) => (f.score as number) <= -2);
  for (const p of strongPos) for (const n of strongNeg) conflicts.push(`„${p.label}" (${sgn(p.score as number, 1)}) je v rozpore s „${n.label}" (${sgn(n.score as number, 1)}).`);

  const invalidation = [...valid]
    .sort((a, b2) => Math.abs(b2.contribution as number) - Math.abs(a.contribution as number))
    .slice(0, 2)
    .map((f) => {
      const swing = (2 * Math.abs(f.contribution as number)) / b.coverage;
      return `Ak sa „${f.label}" otočí do opačného smeru, skóre sa môže posunúť až o ~${swing.toFixed(1)} bodu (váha ${(f.weight * 100).toFixed(0)} %).`;
    });

  const cp = b.confidenceParts!;
  const confText = `Istota ${b.confidence}/100 (pokrytie ${cp.coverage}, aktuálnosť ${cp.freshness}, zhoda faktorov ${cp.agreement}, kvalita zdrojov ${cp.sourceQuality}, istota režimu ${cp.regimeCertainty}).` +
    (b.status === "provisional" ? " Skóre je provizórne (pokrytie pod 85 %), istota je znížená." : "") +
    " Nejde o pravdepodobnosť ziskového obchodu.";

  return {
    summary: `Makro bias pre ${name}: ${CLASS_LABELS[b.classification]} (${sgn(b.displayedScore, 1)} / 10). Režim: ${REGIME_LABELS[b.regime]}. Najväčší vplyv má faktor „${top.label}" (${sgn(top.contribution as number)}).${b.status === "provisional" ? " Skóre je PROVIZÓRNE." : ""}`,
    bullish, bearish, conflicts,
    catalysts: catalysts.map(catalystLine),
    invalidation,
    confidence: confText,
    caveats: uniqCaveats,
  };
}

function catalystLine(c: Catalyst): string {
  return `${c.date} — ${c.name}${c.importance === "high" ? " (vysoká dôležitosť)" : ""}`;
}
