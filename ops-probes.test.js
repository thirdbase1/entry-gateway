// Tests for the 2026-09-21 liveness/readiness split, build identity, and the
// per-route request-body ceiling.
//
// Motivation: /health was the only probe and it did live Postgres reads before
// answering, so an orchestrator's liveness probe could restart a gateway that
// was serving traffic perfectly well just because the metrics DB was slow --
// a metrics outage turned into a restart loop. Separately, express.json's
// single global 25mb ceiling meant a route for a small model had to accept a
// 25mb prompt, a cost/timeout risk its own config could not express.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "ops-test-gateway-key-0123456789";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

async function bootGateway(t, routes) {
  process.env.VERCEL = "1";
  process.env.GATEWAY_API_KEYS = GW_KEY;
  delete process.env.ADMIN_API_KEYS;
  process.env.MODEL_ROUTES_JSON = JSON.stringify(routes);
  process.env.CONFIG_CACHE_MS = "0";
  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  const gateway = http.createServer(app);
  const port = await listen(gateway);
  t.after(() => {
    gateway.closeAllConnections?.();
    gateway.close?.();
  });
  return `http://127.0.0.1:${port}`;
}

test("1a. /health/live answers without touching the metrics store", async (t) => {
  const base = await bootGateway(t, []);
  const res = await fetch(`${base}/health/live`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "alive");
  assert.equal(typeof body.uptime, "number");
  // A liveness probe must not expose operational detail: it is polled
  // constantly and its response is usually unauthenticated.
  assert.equal(body.routes, undefined, "liveness must not enumerate routes");
  assert.equal(body.metricsBackend, undefined, "liveness must not report backend state");
});

test("1b. /health/ready reports ready with routes and 503 without them", async (t) => {
  const withRoutes = await bootGateway(t, [
    { id: "m1", protocol: "openai-chat", provider: "p", upstreamBaseURL: "https://api.example.com/v1", upstreamApiKeyEnv: "OPS_KEY" },
    { id: "m2", protocol: "openai-chat", provider: "p", upstreamBaseURL: "https://api.example.com/v1", upstreamApiKeyEnv: "OPS_KEY" },
  ]);
  const ok = await fetch(`${withRoutes}/health/ready`);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.routes, 2);
  assert.equal(okBody.routedModels, 2);
  assert.ok(okBody.bootedAt, "build identity must include boot time");

  const noRoutes = await bootGateway(t, []);
  const notReady = await fetch(`${noRoutes}/health/ready`);
  assert.equal(notReady.status, 503, "an instance with no routes must not be marked ready");
  assert.equal((await notReady.json()).status, "no-routes");
});

test("1c. build identity (version + git sha) is surfaced when configured", async (t) => {
  process.env.GATEWAY_VERSION = "9.9.9";
  process.env.GIT_SHA = "deadbeef";
  try {
    const base = await bootGateway(t, []);
    const body = await (await fetch(`${base}/health/ready`)).json();
    assert.equal(body.version, "9.9.9");
    assert.equal(body.gitSha, "deadbeef");
  } finally {
    delete process.env.GATEWAY_VERSION;
    delete process.env.GIT_SHA;
  }
});

test("2. a route's maxBodyBytes is enforced and the global ceiling still applies elsewhere", async (t) => {
  process.env.OPS_KEY = "k";
  const base = await bootGateway(t, [
    { id: "small", protocol: "openai-chat", provider: "p", upstreamBaseURL: "http://127.0.0.1:1", upstreamApiKeyEnv: "OPS_KEY", maxBodyBytes: 200 },
    { id: "unlimited", protocol: "openai-chat", provider: "p", upstreamBaseURL: "http://127.0.0.1:1", upstreamApiKeyEnv: "OPS_KEY" },
  ]);

  const post = (model, content) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });

  const tooBig = await post("small", "x".repeat(5000));
  assert.equal(tooBig.status, 413, "a body over the route's own ceiling must be rejected");
  const err = await tooBig.json();
  assert.equal(err.error.type, "InvalidRequestError");
  assert.match(err.error.message, /200-byte limit/);
  assert.ok(tooBig.headers.get("x-gateway-request-id"), "the 413 still carries a request id");

  const small = await post("small", "hi");
  assert.notEqual(small.status, 413, "a body under the route's own ceiling is not rejected by the guard");

  // The unlimited route has no maxBodyBytes, so it falls through to the global
  // express.json ceiling and is proxied (failing on the dead upstream, which
  // proves the guard let it through).
  const big = await post("unlimited", "x".repeat(5000));
  assert.notEqual(big.status, 413, "a route without maxBodyBytes keeps the global ceiling");
  assert.equal(big.status, 502, "the request reached the proxy and failed on the dead upstream");
});