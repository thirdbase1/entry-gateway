// End-to-end regression tests for the 2026-10-10 error-classification pass.
// Same discipline as hardening.test.js: node:test + node:http only, mock
// upstreams on ephemeral ports, no real providers hit.
//
// Covers:
//   1. A circuit-open rejection is a gateway-side 503 (ServiceUnavailableError
//      + Retry-After), NOT a 502 "all upstream routes failed", and it does
//      NOT increment upstream_errors (nothing reached the provider).
//   2. A client disconnect mid-stream does NOT count against the provider:
//      no breaker failure, no upstream error -- only the status-0 attempt.
//   3. A hard upstream timeout DOES count: upstream error + breaker failure.
//   4. Upstream failure detail relayed to clients in the 502 `failures` array
//      is redacted (credential-shaped strings) and bounded.
//   5. After every successful attempt, activeRequests/activeStreams return
//      to their real value (lease-based, no phantom actives).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "classification-test-gateway-key-0123456789";
const METRICS_KEY = "classification-metrics-key-0123456789";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body != null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// Deferred metric writes need a beat to land before /metrics is read.
const settle = () => new Promise((r) => setTimeout(r, 80));

let upstream;
let gateway;
let gatewayPort;
let upstreamPort;
let upstreamMode = "ok"; // "ok" | "hang" | "slow" | "leaky"

test.before(async () => {
  // Mock upstream whose behavior is switched per test via upstreamMode.
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (upstreamMode === "hang") {
        // SSE headers + one chunk, then hold the socket open forever.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        return; // never ends; the gateway aborts on client disconnect / timeout
      }
      if (upstreamMode === "slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        }, 500);
        return;
      }
      if (upstreamMode === "leaky") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid credentials sk-live-abc123XYZdef456GHI789", code: "bad_key" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  upstreamPort = await listen(upstream);

  process.env.VERCEL = "1"; // don't app.listen()
  process.env.GATEWAY_API_KEYS = GW_KEY;
  process.env.METRICS_BEARER_KEY = METRICS_KEY;
  delete process.env.ADMIN_API_KEYS;
  delete process.env.MAX_DAILY_SPEND_USD;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.CLASSIFY_UPSTREAM_KEY = "dummy";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    // Single-route models so the circuit behavior is unambiguous.
    { id: "ok-model", protocol: "openai-chat", provider: "prov-ok", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "CLASSIFY_UPSTREAM_KEY" },
    { id: "hang-model", protocol: "openai-chat", provider: "prov-hang", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "CLASSIFY_UPSTREAM_KEY" },
    { id: "timeout-model", protocol: "openai-chat", provider: "prov-slow", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "CLASSIFY_UPSTREAM_KEY", timeoutMs: 120 },
    { id: "leaky-model", protocol: "openai-chat", provider: "prov-leaky", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "CLASSIFY_UPSTREAM_KEY" },
  ]);
  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);
});

test.after(async () => {
  gateway?.closeAllConnections?.();
  gateway?.close?.();
  upstream?.closeAllConnections?.();
  upstream?.close?.();
});

const post = (model, extra = {}) => request(gatewayPort, {
  method: "POST",
  path: "/v1/chat/completions",
  headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
  body: { model, messages: [{ role: "user", content: "hi" }], ...extra },
});

async function metricsSnapshot() {
  const r = await request(gatewayPort, { path: "/metrics", headers: { Authorization: `Bearer ${METRICS_KEY}` } });
  assert.equal(r.status, 200, `metrics read failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body);
}

// ─── 1. Circuit-open rejections: 503, never an upstream error ────────────────

test("1a. five upstream failures trip the per-model breaker (failure counting unchanged)", async () => {
  upstreamMode = "leaky"; // 500 every time
  for (let i = 0; i < 5; i++) {
    const r = await post("leaky-model");
    assert.equal(r.status, 502, `failure request ${i + 1} should 502 while the breaker is still closed`);
  }
  await settle();
  const { getCircuitBreaker } = await import("./metrics-store.js");
  const cb = await getCircuitBreaker("model:leaky-model", "leaky-model");
  assert.equal(cb.state, "open");
  assert.equal(cb.failures, 5);
});

test("1b. while open, the gateway answers 503 + Retry-After and does NOT count an upstream error", async () => {
  upstreamMode = "leaky";
  const before = await metricsSnapshot();
  const beforeErrors = before.global.upstreamErrors;

  const r = await post("leaky-model");
  assert.equal(r.status, 503, `circuit-open rejection must be 503, got ${r.status}`);
  assert.match(r.body, /ServiceUnavailableError/);
  assert.equal(r.headers["retry-after"], "30", "Retry-After must match the breaker cooldown");
  await settle();

  const after = await metricsSnapshot();
  assert.equal(after.global.upstreamErrors, beforeErrors, "a circuit-open rejection must not inflate upstream_errors -- nothing reached the provider");
  const breakerRow = after.byModel["leaky-model"];
  assert.ok(breakerRow, "the rejected attempt is still recorded on the model row");
  assert.ok((breakerRow.statusBreakdown["0"] || 0) >= 1, "rejected attempts count as status 0 (no upstream response)");
});

// ─── 2. Client disconnects never punish the provider ─────────────────────────

test("2. a client disconnect mid-stream records no upstream error and no breaker failure", async () => {
  upstreamMode = "hang";
  const before = await metricsSnapshot();
  const beforeErrors = before.global.upstreamErrors;

  // Fire a request and abort it as soon as bytes start arriving.
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: gatewayPort, path: "/v1/chat/completions", method: "POST", agent: false,
      headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    }, (res) => {
      res.once("data", () => {
        req.destroy(); // the client hung up mid-stream
        resolve();
      });
    });
    req.on("error", () => resolve()); // destroy surfaces as an error here too
    req.write(JSON.stringify({ model: "hang-model", messages: [{ role: "user", content: "hi" }] }));
    req.end();
  });
  await settle();

  const after = await metricsSnapshot();
  assert.equal(after.global.upstreamErrors, beforeErrors, "client disconnects must not count as upstream errors");
  const { getCircuitBreaker } = await import("./metrics-store.js");
  const cb = await getCircuitBreaker("model:hang-model", "hang-model");
  assert.equal(cb.state, "closed", "the provider's breaker must stay closed -- the client hung up, not the provider");
  assert.equal(cb.failures, 0);
});

// ─── 3. Hard timeouts count as real upstream failures ───────────────────────

test("3. an upstream timeout records an upstream error and a breaker failure", async () => {
  upstreamMode = "slow";
  const before = await metricsSnapshot();
  const r = await post("timeout-model");
  assert.equal(r.status, 502, "a timed-out attempt surfaces as 502 (real upstream failure)");
  await settle();
  const after = await metricsSnapshot();
  assert.equal(after.global.upstreamErrors, before.global.upstreamErrors + 1, "timeouts are upstream errors");
  const { getCircuitBreaker } = await import("./metrics-store.js");
  const cb = await getCircuitBreaker("model:timeout-model", "timeout-model");
  assert.equal(cb.failures, 1, "a timeout counts against the breaker");
});

// ─── 4. Client-facing failure detail is redacted and bounded ────────────────

test("4. the 502 failures array never relays credential-shaped strings from the upstream body", async () => {
  upstreamMode = "leaky";
  const r = await post("ok-model");
  assert.equal(r.status, 502);
  assert.ok(!r.body.includes("sk-live-abc123XYZdef456GHI789"), "upstream credential-shaped strings must be redacted in client payloads");
  assert.match(r.body, /\[redacted\]/, "the redaction marker should be visible");
  // Server logs keep the fuller (redaction-free) detail; the client copy is
  // also bounded to 200 chars per failure line.
  const parsed = JSON.parse(r.body);
  for (const f of parsed.error.failures) assert.ok(f.length <= 220, `failure line too long: ${f.length}`);
});

// ─── 5. Lease-based active counts return to zero after requests finish ──────

test("5. activeRequests/activeStreams return to their true value after attempts finish", async () => {
  upstreamMode = "ok";
  await post("ok-model");
  await post("ok-model");
  await settle();
  const snap = await metricsSnapshot();
  assert.equal(snap.activeRequests, 0, `no attempts should remain in flight, got ${snap.activeRequests} -- the old gauge leaked permanently`);
  assert.equal(snap.activeStreams, 0);
  assert.ok(snap.definitions, "the snapshot exposes its metric definitions");
});
