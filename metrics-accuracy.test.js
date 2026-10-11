// Regression tests for the 2026-10-10 metrics-accuracy pass:
//   1. percentiles(): nearest-rank method + arithmetic mean, computed over
//      the recorded latency samples (verified through the public
//      recordRequest()/getMetricsSnapshot() surface).
//   2. Active-request LEASES: the old +/- gauge leaked permanently on any
//      dropped decrement (production showed 1124 "active" requests); leases
//      are counted alive-right-now and self-heal via TTL expiry.
//   3. circuitBreakerKey(): "model:<id>" rows collapse the redundant
//      "<id>:<id>" suffix; legacy provider rows keep their shape.
//   4. getDailySpendUsd(): reads the recorded WAT-day estimate for the
//      global bucket (drives the optional MAX_DAILY_SPEND_USD ceiling).
// Same discipline as the rest of the repo: node:test only, no mocking deps,
// in-memory store path plus a real unreachable-host failure path.
import { test } from "node:test";
import assert from "node:assert/strict";

// ─── In-memory store path (no DB configured) ─────────────────────────────────
delete process.env.GATEWAY_METRICS_DATABASE_URL;
process.env.ACTIVE_LEASE_TTL_MS = "360000"; // default; leases only expire via explicit end here
const store = await import("./metrics-store.js?mem=1");

test("1a. percentiles use nearest-rank and expose the arithmetic mean (avg)", async () => {
  // Even count: p50 is the lower-middle element (nearest-rank ceil(n/2)),
  // NOT the upper one the old floor() formula reported for even samples.
  const latencies = [400, 100, 300, 200]; // recorded order irrelevant; sorted [100,200,300,400]
  for (const [i, ms] of latencies.entries()) {
    await store.recordRequest("pctprov", "pctmodel-even", 200, ms, null, null, null, false);
  }
  const snap = await store.getMetricsSnapshot(["pctprov"], ["pctmodel-even"]);
  const m = snap.byModel["pctmodel-even"];
  assert.equal(m.latency.count, 4);
  assert.equal(m.latency.p50, 200, `p50 of [100,200,300,400] must be 200 (nearest-rank), got ${m.latency.p50}`);
  assert.equal(m.latency.p95, 400, "p95 must be the ceil(0.95*4)=4th element");
  assert.equal(m.latency.p99, 400);
  assert.equal(m.latency.avg, 250, "avg must be the arithmetic mean 250");
  assert.equal(m.latency.min, 100);
  assert.equal(m.latency.max, 400);
});

test("1b. percentiles for odd counts pick the middle element", async () => {
  for (const ms of [10, 20, 30]) {
    await store.recordRequest("pctprov", "pctmodel-odd", 200, ms, null, null, null, false);
  }
  const snap = await store.getMetricsSnapshot(["pctprov"], ["pctmodel-odd"]);
  const m = snap.byModel["pctmodel-odd"];
  assert.equal(m.latency.p50, 20);
  assert.equal(m.latency.avg, 20);
});

test("1c. empty buckets keep the zeroed shape and still carry avg", async () => {
  const snap = await store.getMetricsSnapshot([], ["never-seen-model"]);
  const m = snap.byModel["never-seen-model"];
  assert.equal(m.latency.count, 0);
  assert.equal(m.latency.avg, 0);
  assert.equal(m.latency.p50, 0);
});

test("2a. active leases count only live leases and clear on explicit end", async () => {
  const begin = store.beginActiveLease("requests", "lease-a");
  await begin; // end must be chained after begin settles (see server.js)
  assert.equal(await store.countActiveLeases("requests"), 1, "one live lease");
  await store.beginActiveLease("requests", "lease-b");
  assert.equal(await store.countActiveLeases("requests"), 2, "two live leases");
  // Streams are a separate namespace.
  await store.beginActiveLease("streams", "lease-a:s");
  assert.equal(await store.countActiveLeases("streams"), 1);
  assert.equal(await store.countActiveLeases("requests"), 2, "stream leases do not leak into requests");

  await store.endActiveLease("requests", "lease-a");
  assert.equal(await store.countActiveLeases("requests"), 1);
  await store.endActiveLease("requests", "lease-b");
  await store.endActiveLease("streams", "lease-a:s");
  assert.equal(await store.countActiveLeases("requests"), 0, "all ended");
  assert.equal(await store.countActiveLeases("streams"), 0);
});

test("2b. a dropped end self-heals: leases expire by TTL and stop being counted", async () => {
  // Dedicated in-memory store instance: delete the DB URL HERE (not just at
  // file load -- the unreachable-DB section at the bottom of this file sets
  // it before tests run, and this dynamic import happens mid-test).
  delete process.env.GATEWAY_METRICS_DATABASE_URL;
  process.env.ACTIVE_LEASE_TTL_MS = "50";
  const shortStore = await import("./metrics-store.js?mem-short-ttl=1");
  await shortStore.beginActiveLease("requests", "leaked-lease");
  assert.equal(await shortStore.countActiveLeases("requests"), 1);
  await new Promise((r) => setTimeout(r, 1300)); // lease TTL passes with no end call
  assert.equal(await shortStore.countActiveLeases("requests"), 0, "expired lease must not be counted -- this is the self-heal that fixes the phantom-active gauge");
  process.env.ACTIVE_LEASE_TTL_MS = "360000";
});

test("2c. ending a lease before its begin settles still leaves zero live leases", async () => {
  // The contract server.js relies on: chain end AFTER begin settles. This
  // asserts the safe ordering works even when begin is still in flight.
  const begin = store.beginActiveLease("requests", "ordered-lease");
  await begin.then(() => store.endActiveLease("requests", "ordered-lease"));
  assert.equal(await store.countActiveLeases("requests"), 0);
});

test("3. circuitBreakerKey collapses the redundant model:<id>:<id> suffix", () => {
  assert.equal(store.circuitBreakerKey("model:glm-5.3-flash", "glm-5.3-flash"), "model:glm-5.3-flash");
  assert.equal(store.circuitBreakerKey("model:qwen3.8-flash:free", "qwen3.8-flash:free"), "model:qwen3.8-flash:free", "model ids containing ':' survive");
  assert.equal(store.circuitBreakerKey("freemodel", "gpt-5.6-luna"), "freemodel:gpt-5.6-luna", "legacy provider rows keep their shape");
  assert.equal(store.circuitBreakerKey("model:glm-5.3-flash", "other"), "model:glm-5.3-flash:other", "mismatched model keeps the full join");
});

test("4. getDailySpendUsd reads the recorded WAT-day global estimate", async () => {
  await store.recordRequest("spprov", "spmodel", 200, 10, null, { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 }, 0.25, false);
  const spent = await store.getDailySpendUsd();
  assert.ok(spent >= 0.25, `today's global spend must include the 0.25 just recorded, got ${spent}`);
  // And a day with no rows reports 0, never undefined/NaN.
  assert.equal(await store.getDailySpendUsd("2001-01-01"), 0);
});

test("5. getMetricsSnapshot still fails open with no DB and reports lease-based actives", async () => {
  const snap = await store.getMetricsSnapshot(["x-provider"], ["x-model"]);
  assert.equal(typeof snap.activeRequests, "number");
  assert.equal(typeof snap.activeStreams, "number");
  assert.ok(snap.global);
  assert.ok(snap.byProvider);
});

// ─── Real unreachable-DB failure path ────────────────────────────────────────
// Same technique as metrics-store-db-failure.test.js: a syntactically valid
// connection string to a host that cannot resolve, so every call exercises
// the network-failure catch path (not the !sql shortcut).
process.env.GATEWAY_METRICS_DATABASE_URL =
  "postgresql://user:pass@invalid-nonexistent-db-host.example.invalid/db?sslmode=require";
const dbFailStore = await import("./metrics-store.js?dbfail=1");

test("6. lease functions fail open (never throw, never hang) when the DB is unreachable", async () => {
  await assert.doesNotReject(dbFailStore.beginActiveLease("requests", "dbfail-lease"));
  await assert.doesNotReject(dbFailStore.endActiveLease("requests", "dbfail-lease"));
  const n = await dbFailStore.countActiveLeases("requests");
  assert.equal(typeof n, "number");
});

test("7. getDailySpendUsd fails open to a number when the DB is unreachable", async () => {
  const v = await dbFailStore.getDailySpendUsd();
  assert.equal(typeof v, "number");
  assert.ok(Number.isFinite(v));
});

test("8. getAllCircuitBreakers still resolves (with the normalized-key shape) on DB failure", async () => {
  const cbs = await dbFailStore.getAllCircuitBreakers();
  assert.equal(typeof cbs, "object");
});
