// Regression test for the 2026-08-27 incident: Upstash rate-limited this
// project's Redis instance, and every function in metrics-store.js threw
// straight out of an unguarded `await redis.xxx()` call. Two call sites in
// server.js's fallback loop had no try/catch at all around one of them,
// which meant real chat requests either got a fast-but-misleading 502 (the
// error message looked like an upstream model failure, not our own Redis)
// or hung completely unguarded until Vercel's hard 300s function timeout.
//
// This test points metrics-store.js at a real, unreachable host (not a
// mock -- this repo intentionally has zero test-mocking deps, see
// fallback.test.js) so every Redis call actually fails over the network,
// and asserts every exported function still resolves quickly with a safe
// fallback value instead of throwing or hanging.
import { test } from "node:test";
import assert from "node:assert/strict";

// Must be set BEFORE importing metrics-store.js -- it reads these at
// module-load time to decide whether to construct a real Redis client.
process.env.KV_REST_API_URL = "https://invalid-nonexistent-redis-host.example.invalid";
process.env.KV_REST_API_TOKEN = "fake-token-for-test";

const {
  usingRedis,
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
} = await import("./metrics-store.js");

// Sanity check: confirms this test is actually exercising the "Redis is
// configured but failing" catch path, not the "!redis" early-return path
// that would trivially pass even with the old, unfixed code.
test("usingRedis() reports true (a real client was constructed) so this test exercises the failure path, not the !redis path", () => {
  assert.equal(usingRedis(), true);
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

test("recordRequest() fails open instead of throwing when Redis is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(recordRequest("providerA", "model-x", 200, 10, 5, null, 0, false), "recordRequest"));
});

test("recordUpstreamError() fails open instead of throwing when Redis is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(recordUpstreamError("providerA", "model-x"), "recordUpstreamError"));
});

test("incrGauge()/getGauge() fail open with a safe numeric default when Redis is unreachable", async () => {
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
  assert.equal(result, false); // fails open -- never blocks a route just because Redis is down
});

test("getCircuitBreaker()/recordBreakerFailure()/recordBreakerSuccess() fail open when Redis is unreachable", async () => {
  const cb = await resolvesWithin(getCircuitBreaker("providerA", "model-x"), "getCircuitBreaker");
  assert.equal(cb.state, "closed");
  await assert.doesNotReject(resolvesWithin(recordBreakerFailure("providerA", "model-x"), "recordBreakerFailure"));
  await assert.doesNotReject(resolvesWithin(recordBreakerSuccess("providerA", "model-x"), "recordBreakerSuccess"));
});

test("getAllCircuitBreakers()/getMetricsSnapshot() (the /health and /metrics admin endpoints) fail open when Redis is unreachable", async () => {
  await assert.doesNotReject(resolvesWithin(getAllCircuitBreakers(), "getAllCircuitBreakers"));
  await assert.doesNotReject(resolvesWithin(getMetricsSnapshot(["providerA"], ["model-x"]), "getMetricsSnapshot"));
});
