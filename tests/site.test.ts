// All market data in this file is SYNTHETIC (see fixtures.ts).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSite } from "../src/build-site.ts";
import type { IngestDeps } from "../src/ingest.ts";
import { NOW, makeData } from "./fixtures.ts";

const synthetic = makeData();
const deps: IngestDeps = {
  fetchFred: async (id) => { if (!synthetic[id]) throw new Error("no synthetic " + id); return synthetic[id]; },
  fetchEcb: async (def) => { if (!synthetic[def.code]) throw new Error("synthetic: " + def.code + " not available"); return synthetic[def.code]; },
  fetchReleases: async () => [{ date: "2026-10-22", name: "Consumer Price Index" }],
};

test("static site: files written, scores present, history appended only on change, restricted values never published", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-site-"));
  const out = join(dir, "site");
  const hist = join(dir, "data", "history.json");
  const env = { FRED_API_KEY: "SECRET_KEY_ABC", GITHUB_REPOSITORY: "valter/macro-bias" };

  const r1 = await buildSite({ env, outDir: out, historyPath: hist, now: NOW, deps });
  for (const f of ["index.html", ".nojekyll", "data/current.json", "data/status.json", "data/calendar.json", "data/history-GC.json"]) {
    assert.ok(existsSync(join(out, f)), f);
  }
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(html.includes("window.MB_STATIC = true"));
  assert.ok(html.includes('"valter/macro-bias"'));

  const cur = JSON.parse(readFileSync(join(out, "data/current.json"), "utf8"));
  assert.equal(cur.assets.length, 3);
  for (const a of cur.assets) assert.equal(a.bias.status, "normal", a.symbol);
  assert.equal(r1.history.GC!.length, 1);

  // No secret anywhere in the published output
  const all = ["index.html", "data/current.json", "data/status.json", "data/calendar.json"].map((f) => readFileSync(join(out, f), "utf8")).join("");
  assert.ok(!all.includes("SECRET_KEY_ABC"));

  // Restricted series (VIX, ICE HY OAS): no raw values in published JSON
  const vixLast = synthetic.VIXCLS.at(-1)!.value;
  const hyLast = synthetic.BAMLH0A0HYM2.at(-1)!.value;
  assert.ok(!all.includes(String(vixLast)) && !all.includes(String(hyLast)));
  const st = JSON.parse(readFileSync(join(out, "data/status.json"), "utf8"));
  assert.equal(st.indicators.find((i: any) => i.code === "VIXCLS").lastValue, null);
  assert.ok(st.indicators.find((i: any) => i.code === "DGS10").lastValue !== null);
  const gcRisk = cur.assets.find((a: any) => a.symbol === "GC").bias.factors.find((f: any) => f.code === "risk");
  assert.ok(gcRisk.inputs.every((i: any) => i.value === null && i.delta === undefined));
  assert.ok(cur.assets.every((a: any) => !JSON.stringify(a.explanation).includes(vixLast.toFixed(2))));

  // Same inputs -> history unchanged; history persisted across builds
  const r2 = await buildSite({ env, outDir: out, historyPath: hist, now: new Date(NOW.getTime() + 3600_000), deps });
  assert.equal(r2.history.GC!.length, 1);
  // Changed input -> appended
  const moved = { ...synthetic, DFII10: synthetic.DFII10.map((o, i, a) => (i === a.length - 1 ? { ...o, value: o.value + 0.3 } : o)) };
  const deps2: IngestDeps = { ...deps, fetchFred: async (id) => moved[id] };
  const r3 = await buildSite({ env, outDir: out, historyPath: hist, now: new Date(NOW.getTime() + 7200_000), deps: deps2 });
  assert.equal(r3.history.GC!.length, 2);
  const h = JSON.parse(readFileSync(join(out, "data/history-GC.json"), "utf8"));
  assert.equal(h.points.length, 2);
  assert.equal(h.points[0].input_hash, undefined);
});

test("static site without key: honest insufficient state, still builds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-site-"));
  const r = await buildSite({ env: {}, outDir: join(dir, "site"), historyPath: join(dir, "h.json"), now: NOW, deps });
  assert.ok(r.assets.every((a) => a.bias.status === "insufficient" && a.bias.displayedScore === null));
  assert.equal(r.ingest.providers.FRED, "unconfigured");
});
