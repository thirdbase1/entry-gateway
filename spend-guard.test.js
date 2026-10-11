// Regression tests for the optional server-side daily spend ceiling
// (MAX_DAILY_SPEND_USD) added 2026-10-10.
//
//   1. Unit: evaluateSpendLimit() and secondsUntilNextWatMidnight() pure
//      logic (spend-guard.js).
//   2. End-to-end: with the ceiling configured, once the gateway's recorded
//      WAT-day estimated spend reaches it, paid proxy routes answer
//      429 SpendLimitError + Retry-After while read-only endpoints keep
//      working; with the ceiling unset nothing changes (default off).
//
// No real providers; the daily spend is seeded through the same
// metrics-store recordRequest() path real traffic uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "spend-guard-test-gateway-key-0123456789";

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

const settle = () => new Promise((r) => setTimeout(r, 80));

// ─── 1. Pure logic ───────────────────────────────────────────────────────────
const { evaluateSpendLimit, secondsUntilNextWatMidnight } = await import("./spend-guard.js");

test("1a. evaluateSpendLimit is disabled (allowed) for any non-positive limit", () => {
  assert.equal(evaluateSpendLimit(0, 0).allowed, true);
  assert.equal(evaluateSpendLimit(1e9, undefined).allowed, true);
  assert.equal(evaluateSpendLimit(1e9, -5).allowed, true);
});

test("1b. evaluateSpendLimit allows under, rejects at/over, and treats junk spend as 0", () => {
  assert.equal(evaluateSpendLimit(0.99, 1).allowed, true);
  assert.equal(evaluateSpendLimit(1, 1).allowed, false, "at the ceiling is already over -- a ceiling is inclusive");
  assert.equal(evaluateSpendLimit(1.01, 1).allowed, false);
  const junk = evaluateSpendLimit(NaN, 1);
  assert.equal(junk.spent, 0, "NaN spend is treated as 0, never as pass-through or poison");
  assert.equal(junk.allowed, true);
});

test("1c. secondsUntilNextWatMidnight crosses 23:00 UTC and is always positive", () => {
  // WAT = UTC+1, so midnight WAT == 23:00 UTC. 2026-10-10T22:00:00Z is 1h
  // before the reset; 2026-10-10T22:59:30Z is 30s before it; 23:00:01Z is
  // already the next WAT day (next reset ~24h away).
  const H = 3600_000;
  assert.equal(secondsUntilNextWatMidnight(Date.UTC(2026, 9, 10, 22, 0, 0)), 3600);
  assert.equal(secondsUntilNextWatMidnight(Date.UTC(2026, 9, 10, 22, 59, 30)), 30);
  const nextDay = secondsUntilNextWatMidnight(Date.UTC(2026, 9, 10, 23, 0, 1));
  assert.ok(nextDay > 86_000 && nextDay <= 86_400, `just past reset, next ceiling reset is ~24h away, got ${nextDay}`);
  assert.ok(secondsUntilNextWatMidnight(0) >= 1, "never zero or negative");
});

// ─── 2. End-to-end with the ceiling configured ───────────────────────────────
let upstream;
let gateway;
let gatewayPort;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);

  process.env.VERCEL = "1";
  process.env.GATEWAY_API_KEYS = GW_KEY;
  delete process.env.ADMIN_API_KEYS;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.SPEND_UPSTREAM_KEY = "dummy";
  process.env.MAX_DAILY_SPEND_USD = "0.5";
  process.env.SPEND_CHECK_TTL_MS = "15000";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "spend-model", protocol: "openai-chat", provider: "prov-spend", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "SPEND_UPSTREAM_KEY" },
  ]);
  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);

  // Seed today's recorded estimated spend ABOVE the $0.5 ceiling through the
  // normal recordRequest path (same module instance the gateway uses).
  const store = await import("./metrics-store.js");
  await store.recordRequest("prov-spend", "spend-model", 200, 10, null, { input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 0 }, 5.0, false);
  await settle();
});

test.after(async () => {
  gateway?.closeAllConnections?.();
  gateway?.close?.();
  upstream?.closeAllConnections?.();
  upstream?.close?.();
});

test("2a. once the day's recorded spend is at/over the ceiling, paid routes answer 429 SpendLimitError", async () => {
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    body: { model: "spend-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 429, `expected the spend ceiling to reject, got ${r.status}: ${r.body}`);
  assert.match(r.body, /SpendLimitError/);
  const retryAfter = Number(r.headers["retry-after"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 86_400, `Retry-After must point at the next WAT midnight, got ${retryAfter}`);
});

test("2b. the spend ceiling does not touch read-only endpoints", async () => {
  const metrics = await request(gatewayPort, { path: "/metrics", headers: { Authorization: `Bearer ${GW_KEY}` } });
  assert.equal(metrics.status, 200);
  const models = await request(gatewayPort, { path: "/v1/models", headers: { Authorization: `Bearer ${GW_KEY}` } });
  assert.equal(models.status, 200);
});

test("2c. without the env var the ceiling is fully disabled (default unchanged)", async () => {
  delete process.env.MAX_DAILY_SPEND_USD;
  // New module instance so the default is re-read.
  const { default: app2 } = await import(`./server.js?nospend=${Date.now()}`);
  const gw2 = http.createServer(app2);
  const port2 = await listen(gw2);
  try {
    const r = await request(port2, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
      body: { model: "spend-model", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(r.status, 200, "with no MAX_DAILY_SPEND_USD the request must proxy normally");
  } finally {
    gw2.closeAllConnections?.();
    gw2.close?.();
  }
});
