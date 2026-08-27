// Regression test, originally written 2026-08-27 for an Upstash Redis
// rate-limit incident, updated the same day when the store was migrated
// off Upstash entirely onto Postgres/Neon (see metrics-store.js's
// top-of-file HISTORY note). Every function in metrics-store.js used to
// throw straight out of an unguarded `await redis.xxx()` call when Redis
// errored; the same discipline (fail open, never throw) is now verified
// against the Postgres-backed implementation instead.
//
// This test points metrics-store.js at a real, unreachable Postgres host
// (not a mock -- this repo intentionally has zero test-mocking deps, see
// fallback.test.js) so every DB call actually fails over the network, and
// asserts every exported function still resolves quickly with a safe
// fallback value instead of throwing or hanging.
import { test } from "node:test";
import assert from "node:assert/strict";

// Must be set BEFORE importing metrics-store.js -- it reads this at
// module-load time to decide whether to construct a real DB client.
// A syntactically valid but unreachable Postgres connection string.
process.env.GATEWAY_METRICS_DATABASE_URL =
  "postgresql://user:pass@invalid-nonexistent-db-host.example.invalid/db?sslmode=require";

const {
  usingDb,
  recordRequest,
  recordUpstreamError,
  incrGauge,
  getGauge,
  getCircuitBreaker,
  isCircuitOpen,
  recordBreakerFailure,
  recordBreakerSuccess,
  getAllCircuitBreakers,
  getMetricsSnapshot,
  kvGet,
  kvSet,
} = await import("./metrics-store.js");

// Sanity check: confirms this test is actually exercising the "DB is
// configured but failing" catch path, not the "!sql" early-return path
// that would trivially pass even with unfixed code.
test("usingDb() reports true (a real client was constructed) so this test exercises the failure path, not the !sql path", () => {
  assert.equal(usingDb(), true);
});

// Generous but bounded -- every call must fail over the network and fall
// back quickly, never hang anywhere close to a serverless function
// timeout.
const MAX_MS = 20_000;

async function resolvesWithin(promise, label) {
  const timeout = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`${label} did not resolve within ${MAX_MS}ms -- looks like the 2026-08-27 hang regressed`)), MAX_MS),
  );
  return await Promise.race([promise, timeout]);
}

test("recordRequest() fails open instead of throwing when the DB is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(recordRequest("providerA", "model-x", 200, 10, 5, null, 0, false), "recordRequest"));
});

test("recordUpstreamError() fails open instead of throwing when the DB is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(recordUpstreamError("providerA", "model-x"), "recordUpstreamError"));
});

test("incrGauge()/getGauge() fail open with a safe numeric default when the DB is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(incrGauge("activeRequests", 1), "incrGauge"));
  const value = await resolvesWithin(getGauge("activeRequests"), "getGauge");
  assert.equal(typeof value, "number");
});

// The critical one: this is exactly what server.js's fallback loop calls
// with NO surrounding try/catch of its own -- it must be physically
// impossible for this to throw.
test("isCircuitOpen() never throws and returns a boolean (server.js relies on this with no try/catch of its own)", async () => {
  const result = await resolvesWithin(isCircuitOpen("providerA", "model-x"), "isCircuitOpen");
  assert.equal(typeof result, "boolean");
  assert.equal(result, false); // fails open -- never blocks a route just because the DB is down
});

test("getCircuitBreaker()/recordBreakerFailure()/recordBreakerSuccess() fail open when the DB is unreachable", async () => {
  const cb = await resolvesWithin(getCircuitBreaker("providerA", "model-x"), "getCircuitBreaker");
  assert.equal(cb.state, "closed");
  await assert.doesNotReject(resolvesWithin(recordBreakerFailure("providerA", "model-x"), "recordBreakerFailure"));
  await assert.doesNotReject(resolvesWithin(recordBreakerSuccess("providerA", "model-x"), "recordBreakerSuccess"));
});

test("getAllCircuitBreakers()/getMetricsSnapshot() (the /health and /metrics admin endpoints) fail open when the DB is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(getAllCircuitBreakers(), "getAllCircuitBreakers"));
  await assert.doesNotReject(resolvesWithin(getMetricsSnapshot(["providerA"], ["model-x"]), "getMetricsSnapshot"));
});

test("kvSet()/kvGet() (used by gemini-cache.js) fail open to an in-memory fallback when the DB is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(kvSet("test-key", "test-value", 60), "kvSet"));
  const value = await resolvesWithin(kvGet("test-key"), "kvGet");
  assert.equal(value, "test-value"); // in-memory fallback still round-trips correctly
});
