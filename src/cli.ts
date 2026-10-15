import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDICATORS } from "./config.ts";
import { openDb } from "./db.ts";
import { redact } from "./http.ts";
import { fetchEcbSeries } from "./providers/ecb.ts";
import { fetchFredSeries } from "./providers/fred.ts";
import { refreshAll } from "./refresh.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2];

async function checkSources(): Promise<number> {
  const key = process.env.FRED_API_KEY?.trim();
  let failures = 0;
  console.log("Kontrola zdrojov (nič sa neukladá). Každý riadok: OK/ZLYHALO, posledné pozorovanie.\n");
  for (const def of INDICATORS.filter((i) => i.provider !== "DERIVED")) {
    try {
      const start = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
      let obs;
      if (def.provider === "FRED") {
        if (!key) { console.log(`PRESKOČENÉ ${def.code.padEnd(14)} chýba FRED_API_KEY`); failures++; continue; }
        obs = await fetchFredSeries(def.ref, key, start);
      } else {
        obs = await fetchEcbSeries(def.ref, def.frequency, def.frequency === "monthly" ? "2025-01-01" : start);
      }
      const last = obs[obs.length - 1];
      if (!last) throw new Error("žiadne pozorovania");
      console.log(`OK        ${def.code.padEnd(14)} ${last.date}  ${last.value}  (${def.provider}, ${def.frequency})`);
    } catch (e) {
      failures++;
      console.log(`ZLYHALO   ${def.code.padEnd(14)} ${redact(e instanceof Error ? e.message : String(e))}`);
    }
  }
  console.log(failures ? `\n${failures} zdrojov zlyhalo — pozri správy vyššie.` : "\nVšetky zdroje odpovedajú.");
  return failures ? 1 : 0;
}

if (cmd === "check-sources") {
  process.exit(await checkSources());
} else if (cmd === "refresh") {
  const db = openDb(process.env.DB_PATH ?? join(ROOT, "data", "macro.sqlite"));
  const r = await refreshAll(db, process.env, { force: process.argv.includes("--force") });
  console.log(JSON.stringify({ ok: r.ingest.ok.length, failed: r.ingest.failed, skipped: r.ingest.skipped, providers: r.ingest.providers, snapshotsStored: r.score.stored }, null, 2));
} else {
  console.log("Použitie: npm run refresh | npm run check-sources");
  process.exit(cmd ? 1 : 0);
}
