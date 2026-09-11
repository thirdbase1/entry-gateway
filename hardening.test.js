// Regression tests for the 2026-09 hardening pass. Same discipline as
// security.test.js / fallback.test.js: node:test + node:http only, zero new
// dependencies, mock upstreams on ephemeral ports, no real providers hit.
//
// Covers:
//   1. SSRF guards: non-http(s) upstream URLs and the optional
//      UPSTREAM_HOST_ALLOWLIST gate proxied fetches (unit + end-to-end).
//   2. Constant-time key auth still accepts/rejects correctly after moving
//      from Set.has(rawKey) to SHA-256 digest comparison.
//   3. A missing provider secret is treated as a config error: it must not
//      trip the model's circuit breaker or leak the env-var name in the 502.
//   4. Malformed JSON bodies get a clean OpenAI-shaped 400 JSON error
//      instead of Express's default HTML error page.
//   5. metrics-store record* functions clamp NaN/Infinity inputs so one bad
//      upstream usage payload can't permanently poison cumulative counters.
//   6. admin.html's connection bar has the id its script looks up -- without
//      it, auto-connect threw a TypeError for every operator visit.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GW_KEY = "hardening-test-gateway-key-0123456789"; // >=16 chars: keeps dash-cookie logic inert
const SECRETLESS_KEY = "secretless-test-gateway-key!!";

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

const upstreamLog = [];
let gateway;
let gatewayPort;
let upstream;

test.before(async () => {
  // Fails every chain-model attempt (429/503 alternating, both retryable) so
  // a full 2-candidate chain of 5 requests trips exactly ONE per-model breaker
  // to `open` at the threshold of 5 -- not two provider-scoped breakers.
  // The model lives in the JSON body for openai-chat (not the URL), so we must
  // read the body to route the mock's behavior.
  let chainHits = 0;
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      upstreamLog.push(req.url);
      let model = "";
      try { model = JSON.parse(raw || "{}").model || ""; } catch {}
      if (model === "chain-model") {
        res.writeHead(chainHits++ % 2 ? 503 : 429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "busy" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  const upstreamPort = await listen(upstream);

  process.env.VERCEL = "1"; // don't app.listen()
  process.env.GATEWAY_API_KEYS = `${GW_KEY},${SECRETLESS_KEY}`;
  delete process.env.ADMIN_API_KEYS;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.TEST_HARDENING_KEY = "dummy";
  process.env.TEST_HARDENING_KEY2 = "dummy2";
  // Two routes for the SAME model+provider: one with a valid secret env var,
  // one pointing at an env var nobody ever sets (missing-secret scenario).
  // The good route gets priority 900 so the broken one is always tried first.
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "ok-model", protocol: "openai-chat", provider: "hardenprov", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "TEST_HARDENING_KEY", priority: 900 },
    { id: "secretless-model", protocol: "openai-chat", provider: "hardenprov", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "THIS_ENV_IS_INTENTIONALLY_UNSET", priority: 1 },
    // Two-route fallback chain where BOTH providers fail (429/503): proves
    // the whole chain records exactly one failure per attempt against a
    // single per-model breaker identity instead of two provider-scoped ones.
    { id: "chain-model", protocol: "openai-chat", provider: "chain-a", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "TEST_HARDENING_KEY", priority: 1, headers: {} },
    { id: "chain-model", protocol: "openai-chat", provider: "chain-b", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "TEST_HARDENING_KEY2", priority: 2 },
  ]);

  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);
});

test.after(async () => {
  for (const s of [gateway, upstream]) {
    s?.closeAllConnections?.();
    s?.close?.();
  }
});

// ─── 1. SSRF guards (pure functions, exported from server.js) ────────────────

test("1a. isHttpUpstream rejects non-http(s) schemes and garbage", async () => {
  const { isHttpUpstream } = await import("./server.js");
  assert.equal(isHttpUpstream("https://api.example.com/v1"), true);
  assert.equal(isHttpUpstream("http://127.0.0.1:1234"), true);
  assert.equal(isHttpUpstream("file:///proc/self/environ"), false);
  assert.equal(isHttpUpstream("data:text/plain,hello"), false);
  assert.equal(isHttpUpstream("gopher://evil.internal:11211"), false);
  assert.equal(isHttpUpstream("not a url"), false);
  assert.equal(isHttpUpstream(""), false);
});

test("1b. upstreamHostAllowed enforces the optional allowlist (fresh instance, CONFIG_CACHE_MS=0)", async () => {
  // The allowlist lives behind a TTL cache read lazily per call, so a second
  // server.js import with CONFIG_CACHE_MS=0 picks up the env change at once.
  process.env.CONFIG_CACHE_MS = "0";
  process.env.UPSTREAM_HOST_ALLOWLIST = "api.example.com, 127.0.0.1";
  try {
    const { upstreamHostAllowed } = await import(`./server.js?allowlist=${Date.now()}`);
    assert.equal(upstreamHostAllowed("https://API.Example.com/v1"), true); // case-insensitive
    assert.equal(upstreamHostAllowed("http://127.0.0.1:9999/v1"), true); // port-free match
    assert.equal(upstreamHostAllowed("https://evil.example.com/v1"), false);
    assert.equal(upstreamHostAllowed("garbage"), false);
  } finally {
    delete process.env.UPSTREAM_HOST_ALLOWLIST;
    delete process.env.CONFIG_CACHE_MS;
  }
});

test("1c. upstreamHostAllowed trusts operator config when no allowlist is set", async () => {
  const { upstreamHostAllowed } = await import("./server.js");
  assert.equal(upstreamHostAllowed("https://anything-at-all.example.org/v1"), true);
});

// ─── 2. Constant-time key auth still behaves correctly ───────────────────────

test("2a. valid Bearer keys are accepted after the timingSafeEqual migration", async () => {
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    body: { model: "ok-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 200);
});

test("2b. invalid / empty / whitespace-padded keys are rejected", async () => {
  for (const supplied of ["wrong-key", "", "   ", GW_KEY.slice(0, -1)]) {
    const r = await request(gatewayPort, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: `Bearer ${supplied}`, "Content-Type": "application/json" },
      body: { model: "ok-model", messages: [] },
    });
    assert.equal(r.status, 401, `key "${supplied}" should have been rejected`);
  }
});

// ─── 3. Missing provider secret = config error, not an upstream failure ─────

test("3a. a route with an unset secret fails cleanly and never trips the breaker", async () => {
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${SECRETLESS_KEY}`, "Content-Type": "application/json" },
    body: { model: "secretless-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 502);
  // The env-var NAME must not be echoed back to the client...
  assert.ok(!r.body.includes("THIS_ENV_IS_INTENTIONALLY_UNSET"), `502 leaked the secret env var name: ${r.body}`);
  // ...and the model's circuit breaker must still be closed after repeated
  // deterministic config failures (previously each one counted as an
  // upstream failure and would eventually open the circuit).
  const { getCircuitBreaker } = await import("./metrics-store.js");
  const cb = await getCircuitBreaker("model:secretless-model", "secretless-model");
  assert.equal(cb.state, "closed");
  assert.equal(cb.failures, 0);
});

// ─── 3b. Fallback chains record ONE breaker identity per model ──────────────

// Breaker/metrics writes are fire-and-forget off the request hot path (server
//.js `defer()`), so a test that asserts on breaker state must let those
// microtask/IO chains settle first -- exactly like a second gateway instance
// would observe them a moment later in production.
const settle = () => new Promise((r) => setTimeout(r, 50));

test("3b. a full fallback-chain failure trips one per-model breaker, not per-provider ones", async () => {
  // 2 candidates/request: req1 -> failures 1,2; req2 -> 3,4; req3 -> candidate
  // #1 =5 (opens), candidate #2 circuit-skipped. So 3 requests trip exactly 5.
  for (let i = 0; i < 3; i++) {
    const r = await request(gatewayPort, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
      body: { model: "chain-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(r.status, 502, `chain request ${i + 1} should 502 while both providers fail`);
  }
  await settle();
  const { getCircuitBreaker } = await import("./metrics-store.js");
  const chainCb = await getCircuitBreaker("model:chain-model", "chain-model");
  assert.equal(chainCb.state, "open", "the single per-model breaker should have opened after 5 attempts");
  assert.equal(chainCb.failures, 5);
  // The individual providers in the chain must NOT carry their own open
  // circuits -- that was the cascading-failover-death bug.
  for (const prov of ["chain-a", "chain-b"]) {
    const cb = await getCircuitBreaker(prov, "chain-model");
    assert.equal(cb.state, "closed", `provider-level breaker ${prov} must stay unused/closed`);
    assert.equal(cb.failures, 0);
  }
});

// ─── 4. Malformed JSON body -> clean 400 JSON (no HTML, no stack trace) ─────

test("4a. malformed JSON returns an OpenAI-shaped 400, never an HTML error page", async () => {
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(r.status, 400);
  assert.match(r.headers["content-type"] || "", /application\/json/);
  assert.ok(!r.body.includes("<!DOCTYPE") && !r.body.includes("<html"), "Express default HTML error page leaked");
  assert.match(r.body, /InvalidRequestError/);
});

// ─── 5. metrics-store numeric clamping (NaN stickiness protection) ──────────

test("5a. NaN/Infinity usage cannot poison cumulative metric counters", async () => {
  delete process.env.GATEWAY_METRICS_DATABASE_URL;
  const store = await import(`./metrics-store.js?nan-guard=${Date.now()}`);
  const bad = { input: NaN, output: Infinity, cache_read: -5, cache_write: null, reasoning: undefined };
  await store.recordRequest("nanprov", "nanmodel", 200, Number.NaN, 5, bad, Number.NaN, false);
  await store.recordRequest("nanprov", "nanmodel", 200, 10, 5, { input: 7, output: 3, cache_read: 0, cache_write: 0, reasoning: 0 }, 0.001, false);
  const snap = await store.getMetricsSnapshot(["nanprov"], ["nanmodel"]);
  const m = snap.byModel.nanmodel;
  assert.ok(Number.isFinite(m.estimatedSpend), `estimatedSpend went non-finite: ${m.estimatedSpend}`);
  assert.ok(Number.isFinite(m.tokens.input) && m.tokens.input >= 0, `tokens.input corrupted: ${m.tokens.input}`);
  assert.ok(Number.isFinite(m.latency.p50), `latency percentiles corrupted: ${JSON.stringify(m.latency)}`);
  // Second request's real values must survive intact.
  assert.equal(m.tokens.output, 3);
});

// ─── 6. admin.html DOM contract ─────────────────────────────────────────────

test("6a. admin.html defines #conn-bar which its own script manipulates", () => {
  const html = readFileSync(fileURLToPath(new URL("./public/admin.html", import.meta.url)), "utf-8");
  assert.ok(/id="conn-bar"/.test(html), "the conn-bar element referenced by getElementById('conn-bar') does not exist");
});
