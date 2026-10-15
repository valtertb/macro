// All market data in this file is SYNTHETIC (see fixtures.ts). Parser inputs are hand-written samples in the
// documented formats; they are NOT captured live responses (the build sandbox had no access to FRED/ECB).
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { getSeries, history, openDb, replaceCalendar, saveSnapshot, upcomingCalendar, upsertObservations } from "../src/db.ts";
import { fetchText, redact, resetHttpState } from "../src/http.ts";
import { ingestAll } from "../src/ingest.ts";
import type { IngestDeps } from "../src/ingest.ts";
import { parseEcbCsv } from "../src/providers/ecb.ts";
import { parseFredObservations, parseFredReleaseDates } from "../src/providers/fred.ts";
import { refreshAll, scoreAll } from "../src/refresh.ts";
import { createApp, parseSymbol } from "../src/server.ts";
import { NOW, makeData, treasuryXml } from "./fixtures.ts";

const synthetic = makeData();
const fakeDeps: IngestDeps = {
  fetchFred: async (id) => { if (!synthetic[id]) throw new Error("no synthetic series " + id); return synthetic[id]; },
  fetchEcb: async (def) => { if (!synthetic[def.code]) throw new Error("synthetic: " + def.code + " not available"); return synthetic[def.code]; },
  fetchTreasury: async () => treasuryXml([]),
  fetchReleases: async () => [
    { date: "2026-10-22", name: "Consumer Price Index" },
    { date: "2026-10-23", name: "Some Random Release" },
    { date: "2026-11-06", name: "Employment Situation" },
  ],
};

test("parsers: FRED skips '.', ECB CSV handles daily/monthly, rejects quarterly, errors on bad shape", () => {
  const f = parseFredObservations({ observations: [{ date: "2026-10-13", value: "4.01" }, { date: "2026-10-14", value: "." }, { date: "bad", value: "1" }] });
  assert.deepEqual(f, [{ date: "2026-10-13", value: 4.01 }]);
  assert.throws(() => parseFredObservations({ error_message: "Bad Request" }));
  const csv = 'KEY,FREQ,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n"A.B",D,2026-10-13,2.31,A\n"A.B",D,2026-10-14,,A\n"A.B",M,2026-09,2.5,A\n"A.B",Q,2026-Q3,9,A\n';
  assert.deepEqual(parseEcbCsv(csv), [{ date: "2026-09-01", value: 2.5 }, { date: "2026-10-13", value: 2.31 }]);
  assert.throws(() => parseEcbCsv("A,B\n1,2\n"));
  assert.deepEqual(parseFredReleaseDates({ release_dates: [{ release_name: "CPI", date: "2026-10-22" }, { date: "2026-10-23" }] }), [{ date: "2026-10-22", name: "CPI" }]);
});

test("http: retries 5xx with backoff, no retry on 4xx, breaker opens, secrets redacted", async () => {
  resetHttpState();
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    if (req.url === "/flaky") { res.writeHead(hits < 3 ? 500 : 200); res.end("ok"); }
    else if (req.url === "/notfound") { res.writeHead(404); res.end("no"); }
    else { res.writeHead(500); res.end("down"); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(await fetchText(base + "/flaky", { baseDelayMs: 1 }), "ok");
    assert.equal(hits, 3);
    hits = 0;
    await assert.rejects(fetchText(base + "/notfound", { baseDelayMs: 1 }), /HTTP 404/);
    assert.equal(hits, 1);
    resetHttpState();
    for (let i = 0; i < 5; i++) await assert.rejects(fetchText(base + "/down", { retries: 0 }), /HTTP 500/);
    await assert.rejects(fetchText(base + "/down", { retries: 0 }), /Circuit breaker/);
  } finally { srv.close(); resetHttpState(); }
  assert.ok(!redact("https://x/y?series_id=A&api_key=SECRET123&file_type=json").includes("SECRET123"));
});

test("db: upsert inserts, logs revisions, snapshots + history, calendar", () => {
  const db = openDb(":memory:");
  assert.deepEqual(upsertObservations(db, "X", "FRED", [{ date: "2026-01-01", value: 1 }, { date: "2026-01-02", value: 2 }], "t1"), { inserted: 2, revised: 0 });
  assert.deepEqual(upsertObservations(db, "X", "FRED", [{ date: "2026-01-02", value: 2.5 }, { date: "2026-01-03", value: 3 }], "t2"), { inserted: 1, revised: 1 });
  assert.deepEqual(getSeries(db, "X").map((o) => o.value), [1, 2.5, 3]);
  const rev = db.prepare("SELECT * FROM observation_revisions").all() as any[];
  assert.equal(rev.length, 1);
  assert.equal(rev[0].old_value, 2);
  replaceCalendar(db, "S", [{ date: "2026-10-20", name: "A", kind: "DATA", importance: "high" }, { date: "2026-12-01", name: "B", kind: "DATA", importance: "high" }]);
  assert.deepEqual(upcomingCalendar(db, "2026-10-15", 14).map((e) => e.name), ["A"]);
  assert.equal(history(db, "GC", 10).length, 0);
});

test("ingest without FRED key: honest 'unconfigured' status, nothing fabricated, score suppressed", async () => {
  const db = openDb(":memory:");
  const r = await refreshAll(db, {}, { now: NOW, deps: fakeDeps });
  assert.equal(r.ingest.providers.FRED, "unconfigured");
  assert.ok(r.ingest.skipped.includes("DGS2"));
  assert.equal(getSeries(db, "DGS2").length, 0);
  const snap = JSON.parse((db.prepare("SELECT payload_json FROM bias_snapshots WHERE symbol='NQ'").get() as any).payload_json);
  assert.equal(snap.bias.status, "insufficient");
  assert.equal(snap.bias.displayedScore, null);
  assert.match(snap.explanation.summary, /Nedostatok dát/);
});

test("full refresh with fake providers: scores stored once per input change; failures visible, key never leaked", async () => {
  const db = openDb(":memory:");
  const leaky: IngestDeps = { ...fakeDeps, fetchFred: async (id, key) => { if (id === "VIXCLS") throw new Error(`HTTP 500 https://x?api_key=${key}`); return synthetic[id]; } };
  const r = await refreshAll(db, { FRED_API_KEY: "SECRETKEY123" }, { now: NOW, deps: leaky });
  assert.equal(r.ingest.providers.FRED, "degraded");
  assert.ok(r.ingest.failed.some((f) => f.code === "VIXCLS"));
  const dump = JSON.stringify(db.prepare("SELECT * FROM indicator_status").all()) + JSON.stringify(db.prepare("SELECT * FROM system_events").all()) + JSON.stringify(db.prepare("SELECT * FROM provider_status").all());
  assert.ok(!dump.includes("SECRETKEY123"));
  assert.deepEqual(r.score.stored, { NQ: true, GC: true, EURUSD: true });
  // same inputs -> no new snapshot; forced -> new one
  assert.deepEqual(scoreAll(db, NOW).stored, { NQ: false, GC: false, EURUSD: false });
  assert.deepEqual(scoreAll(db, NOW, true).stored, { NQ: true, GC: true, EURUSD: true });
  const cal = upcomingCalendar(db, "2026-10-15", 30).map((e) => e.name);
  assert.ok(cal.includes("US CPI") && cal.includes("FOMC rozhodnutie") && !cal.includes("Some Random Release"));
  const factors = db.prepare("SELECT COUNT(*) AS n FROM factor_scores").get() as any;
  assert.ok(factors.n >= 15);
});

test("alternative refs: newest code wins, no splicing, unavailable codes tolerated", async () => {
  const db = openDb(":memory:");
  const old = synthetic.EA_HICP_CORE.slice(0, -10); // stops earlier
  const fresh = synthetic.EA_HICP_CORE.map((o) => ({ ...o, value: o.value + 0.01 }));
  const deps: IngestDeps = {
    ...fakeDeps,
    fetchEcb: async (def) => {
      if (def.ref.startsWith("ICP/")) return old;
      if (def.ref === "HICP/M.U2.N.XEF000.4F0.ANR") return fresh;
      if (def.code === "EA_HICP_CORE") throw new Error("HTTP 404");
      if (!synthetic[def.code]) throw new Error("n/a");
      return synthetic[def.code];
    },
  };
  const r = await refreshAll(db, { FRED_API_KEY: "k" }, { now: NOW, deps });
  assert.ok(r.ingest.ok.includes("EA_HICP_CORE"));
  const s = getSeries(db, "EA_HICP_CORE");
  assert.equal(s.length, fresh.length);
  assert.equal(s.at(-1)!.value, fresh.at(-1)!.value);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='ref:EA_HICP_CORE'").get() as any).value, "HICP/M.U2.N.XEF000.4F0.ANR");
});

test("server: endpoints, validation, host guard, CSRF-style header on refresh", async () => {
  const db = openDb(":memory:");
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const app = createApp(db, { FRED_API_KEY: "k" }, port, fakeDeps, async () => []);
  srv.on("request", app.handler);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(parseSymbol("gold"), "GC");
    assert.equal(parseSymbol("EUR/USD"), "EURUSD");
    assert.equal(parseSymbol("DAX"), null);

    let res = await fetch(base + "/api/bias/current");
    let body: any = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.assets.length, 3);
    assert.equal(body.assets[0].bias.status, "insufficient"); // empty DB -> honest, no fabricated score
    assert.equal(body.fredConfigured, true);

    assert.equal((await fetch(base + "/api/bias/DAX/history")).status, 400);
    assert.equal((await fetch(base + "/api/nope")).status, 404);
    assert.equal((await fetch(base + "/", {})).headers.get("content-type")?.startsWith("text/html"), true);
    assert.equal((await fetch(base + "/api/refresh", { method: "POST" })).status, 403);

    res = await fetch(base + "/api/refresh", { method: "POST", headers: { "X-Requested-With": "macro-bias" } });
    body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.ingest.ok.length > 10);

    body = await (await fetch(base + "/api/bias/current")).json();
    for (const a of body.assets) {
      assert.equal(a.bias.status, "normal", a.symbol);
      assert.ok(typeof a.bias.displayedScore === "number");
      assert.ok(a.explanation.summary.includes("Makro bias"));
      assert.ok(a.explanation.caveats.some((c: string) => c.includes("nie real-time")));
    }
    body = await (await fetch(base + "/api/providers/status")).json();
    assert.ok(body.indicators.length >= 13);
    assert.ok(body.indicators.some((i: any) => i.code === "EURUSD_REF" && i.lastError)); // failure is visible
    body = await (await fetch(base + "/api/bias/GC/history")).json();
    assert.equal(body.points.length, 1);

    // Host guard (DNS-rebinding protection)
    const status = await new Promise<number>((resolve, reject) => {
      const rq = request({ host: "127.0.0.1", port, path: "/api/bias/current", headers: { host: "evil.example" } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
      rq.on("error", reject); rq.end();
    });
    assert.equal(status, 403);
  } finally { srv.close(); }
});
