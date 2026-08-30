// Regression tests for the security + abuse-protection fixes applied to the
// gateway. Uses only Node built-ins (node:test, node:http) -- zero new deps,
// same discipline as fallback.test.js.
//
// Covers:
//   1. CRITICAL: /admin no longer leaks the live admin/gateway key to
//      unauthenticated visitors, but still auto-injects it for a request that
//      already presents a valid Bearer token.
//   2. Reflected-XSS via the Host header into the admin page is escaped.
//   3. CORS: a malformed Origin no longer 500s the request, and a foreign
//      *.vercel.app origin is not reflected back.
//   4. Gemini `:action` path-injection (URL-encoded slashes) is collapsed to a
//      safe action instead of being forwarded raw to the upstream.
//   5. Per-key rate limiting returns 429 once a key exceeds its budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "gw-secret-key";
const RL_KEY = "rl-key";
const FAIL_KEY = "failure-test-key";
const ADMIN_KEY = "admin-secret-key";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

// Mock upstream that records the path each request hit and returns a minimal
// valid (non-streaming) completion so proxy() completes cleanly.
function startMockUpstream(log) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return server;
}

// One-shot HTTP request helper; resolves with { status, body, headers }.
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body != null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const geminiLog = [];
const openaiLog = [];
let failingUpstreamHits = 0;
let gatewayPort;
let gateway;
let geminiUpstream;
let openaiUpstream;
let failingUpstream;

test.before(async () => {
  geminiUpstream = startMockUpstream(geminiLog);
  openaiUpstream = startMockUpstream(openaiLog);
  const geminiPort = await listen(geminiUpstream);
  const openaiPort = await listen(openaiUpstream);
  failingUpstream = http.createServer((_req, res) => {
    failingUpstreamHits += 1;
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  const failingPort = await listen(failingUpstream);

  process.env.VERCEL = "1"; // don't app.listen()
  process.env.GATEWAY_API_KEYS = `${GW_KEY},${RL_KEY},${FAIL_KEY}`;
  process.env.ADMIN_API_KEYS = ADMIN_KEY;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.TEST_G_KEY = "dummy-g";
  process.env.TEST_A_KEY = "dummy-a";
  // Tight budget so the rate-limit test can exhaust it quickly.
  process.env.RATE_LIMIT_RPS = "1";
  process.env.RATE_LIMIT_BURST = "3";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "gemini-3.5-flash", protocol: "gemini-generate", provider: "pG", upstreamBaseURL: `http://127.0.0.1:${geminiPort}`, upstreamApiKeyEnv: "TEST_G_KEY", priority: 1 },
    { id: "test-openai", protocol: "openai-chat", provider: "pA", upstreamBaseURL: `http://127.0.0.1:${openaiPort}`, upstreamApiKeyEnv: "TEST_A_KEY", priority: 1 },
    { id: "failing-openai", protocol: "openai-chat", provider: "pFail", upstreamBaseURL: `http://127.0.0.1:${failingPort}`, upstreamApiKeyEnv: "TEST_A_KEY", priority: 1 },
  ]);

  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);
});

test.after(async () => {
  for (const s of [gateway, geminiUpstream, openaiUpstream, failingUpstream]) {
    s?.closeAllConnections?.();
    s?.close?.();
  }
});

test("1a. /admin does NOT leak the admin key to an unauthenticated visitor", async () => {
  const { status, body } = await request(gatewayPort, { path: "/admin" });
  assert.equal(status, 200);
  assert.ok(!body.includes(ADMIN_KEY), "leaked the live admin key to an anonymous visitor");
  assert.ok(!body.includes(GW_KEY), "leaked the live gateway key to an anonymous visitor");
  // Match the injected TAG form, not admin.html's own JS selector string
  // `meta[name="gateway-key"]` which legitimately appears in the page script.
  assert.ok(!/<meta name="gateway-key"/.test(body), "injected a gateway-key meta tag for an anonymous visitor");
  // URL is not a secret and should still be auto-injected for zero-config.
  assert.ok(/<meta name="gateway-url"/.test(body), "gateway-url meta should still be present");
});

test("1b. /admin DOES auto-inject the key when the request already has a valid Bearer token", async () => {
  const { status, body } = await request(gatewayPort, { path: "/admin", headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.equal(status, 200);
  assert.ok(/<meta name="gateway-key"/.test(body), "authorized visitor should get the gateway-key meta");
  assert.ok(body.includes(ADMIN_KEY), "authorized visitor should get the key auto-injected");
});

test("1c. /admin sends Cache-Control: no-store", async () => {
  const { headers } = await request(gatewayPort, { path: "/admin" });
  assert.equal(headers["cache-control"], "no-store");
});

test("2. Host header is HTML-attribute-escaped (no reflected XSS)", async () => {
  const payload = 'x"><script>alert(1)</script>';
  const { body } = await request(gatewayPort, { path: "/admin", headers: { Host: payload } });
  assert.ok(!body.includes("<script>alert(1)</script>"), "raw script from Host header leaked into the page");
  // Either escaped in place, or the header was rejected outright -- both safe.
});

test("3a. malformed Origin does not 500 the request", async () => {
  const { status } = await request(gatewayPort, { path: "/health", headers: { Origin: "not a valid url" } });
  assert.notEqual(status, 500, "malformed Origin crashed the middleware");
  assert.equal(status, 200);
});

test("3b. a foreign *.vercel.app origin is not reflected back", async () => {
  const { headers } = await request(gatewayPort, { path: "/health", headers: { Origin: "https://attacker-controlled.vercel.app" } });
  assert.notEqual(headers["access-control-allow-origin"], "https://attacker-controlled.vercel.app");
});

test("3c. a first-party entry-agents vercel.app origin IS reflected back", async () => {
  const origin = "https://entry-agents-git-main-thirdbase1s-projects.vercel.app";
  const { headers } = await request(gatewayPort, { path: "/health", headers: { Origin: origin } });
  assert.equal(headers["access-control-allow-origin"], origin);
});

test("4a. URL-encoded path-injection in the Gemini action is collapsed to a safe action", async () => {
  geminiLog.length = 0;
  // The gateway classifies a request as gemini-generate when the path contains
  // "generatecontent" (server.js:237), so a realistic attack appends traversal
  // onto a valid-looking action. %2F decodes to "/" in req.params, so pre-fix
  // this forwarded `/models/gemini-3.5-flash:generateContent/../../admin` to the
  // upstream host. actionFor() must collapse the unknown action to a safe one.
  await request(gatewayPort, {
    method: "POST",
    path: "/v1beta/models/gemini-3.5-flash:generateContent%2F..%2F..%2Fadmin",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    body: { contents: [] },
  });
  assert.equal(geminiLog.length, 1, "upstream should have been hit exactly once");
  const hit = geminiLog[0];
  assert.ok(!hit.includes("admin"), `injected segment leaked upstream: ${hit}`);
  assert.ok(!hit.includes(".."), `path traversal leaked upstream: ${hit}`);
  assert.ok(hit.includes(":generateContent"), `expected safe action, got: ${hit}`);
});

test("4b. the legitimate streamGenerateContent action still passes through", async () => {
  geminiLog.length = 0;
  await request(gatewayPort, {
    method: "POST",
    path: "/v1beta/models/gemini-3.5-flash:streamGenerateContent",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
    body: { contents: [] },
  });
  assert.equal(geminiLog.length, 1);
  assert.ok(geminiLog[0].includes(":streamGenerateContent"), `streaming action was mangled: ${geminiLog[0]}`);
  assert.ok(geminiLog[0].includes("alt=sse"), "streaming request must carry ?alt=sse");
});

test("5. per-key rate limiting returns 429 once the budget is exhausted", async () => {
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      request(gatewayPort, {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Authorization: `Bearer ${RL_KEY}`, "Content-Type": "application/json" },
        body: { model: "test-openai", messages: [{ role: "user", content: "hi" }] },
      }),
    ),
  );
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.includes(200), "first requests within budget should succeed");
  assert.ok(statuses.includes(429), "requests over the per-key budget should be rate limited (429)");
  const limited = results.find((r) => r.status === 429);
  assert.equal(limited.headers["retry-after"], "1");
  assert.match(limited.body, /RateLimitError/);
});

// ─── 6. Dashboard auto-auth (signed HttpOnly session, no key entry) ──────────
// The dashboard page must authenticate itself with NO credential entry, via a
// short-lived signed cookie that unlocks READ-ONLY endpoints only. The real
// API keys must never appear in the page, and the paid proxy routes must keep
// requiring a real key.
test("6a. GET /admin hands out a signed session cookie without any key", async () => {
  const res = await request(gatewayPort, { path: "/admin" });
  assert.equal(res.status, 200);
  const cookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith("gw_dash="));
  assert.ok(cookie, "expected a gw_dash session cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Max-Age=/);
  // The cookie must not simply BE an API key.
  assert.ok(!cookie.includes(ADMIN_KEY) && !cookie.includes(GW_KEY));
});

test("6b. session cookie auto-auths read-only endpoints without a Bearer token", async () => {
  const res = await request(gatewayPort, { path: "/admin" });
  const cookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith("gw_dash="));
  const pair = cookie.split(";")[0];
  for (const path of ["/metrics", "/v1/debug/routes", "/v1/models"]) {
    const r = await request(gatewayPort, { path, headers: { Cookie: pair } });
    assert.equal(r.status, 200, `${path} should be auto-authed by the session cookie`);
  }
});

test("5b. each retryable upstream response counts as one breaker failure", async () => {
  failingUpstreamHits = 0;
  for (let i = 0; i < 3; i++) {
    const r = await request(gatewayPort, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: `Bearer ${FAIL_KEY}`, "Content-Type": "application/json" },
      body: { model: "failing-openai", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(r.status, 502);
  }

  const { getCircuitBreaker } = await import("./metrics-store.js");
  const cb = await getCircuitBreaker("pFail", "failing-openai");
  assert.equal(failingUpstreamHits, 3);
  assert.equal(cb.state, "closed", "three failures must not trip a five-failure breaker");
  assert.equal(cb.failures, 3, "each upstream response must increment the breaker exactly once");
});

test("6b-2. a dedicated admin key can read /v1/models", async () => {
  const r = await request(gatewayPort, {
    path: "/v1/models",
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).object, "list");
});

test("6c. session cookie must NOT unlock the paid proxy routes", async () => {
  const res = await request(gatewayPort, { path: "/admin" });
  const pair = (res.headers["set-cookie"] || []).find((c) => c.startsWith("gw_dash=")).split(";")[0];
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "Content-Type": "application/json", Cookie: pair },
    body: { model: "gemini-3.5-flash", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 401, "proxy routes keep requiring a real API key");
  assert.match(r.body, /AuthError/);
});

test("6d. a tampered session cookie is rejected", async () => {
  const res = await request(gatewayPort, { path: "/admin" });
  const pair = (res.headers["set-cookie"] || []).find((c) => c.startsWith("gw_dash=")).split(";")[0];
  const [name, value] = pair.split("=");
  const [exp, sig] = value.split(".");
  const forged = `${name}=${exp}.${"0".repeat(sig.length)}`;
  const r = await request(gatewayPort, { path: "/metrics", headers: { Cookie: forged } });
  assert.equal(r.status, 401);
  // And a forged far-future expiry with a bogus signature too.
  const forged2 = `${name}=${Date.now() + 3.6e6}.${"f".repeat(sig.length)}`;
  const r2 = await request(gatewayPort, { path: "/metrics", headers: { Cookie: forged2 } });
  assert.equal(r2.status, 401);
});

test("6e. ADMIN_AUTOAUTH=0 disables the session entirely", async () => {
  process.env.ADMIN_AUTOAUTH = "0";
  try {
    const res = await request(gatewayPort, { path: "/admin" });
    assert.equal(res.status, 200);
    const cookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith("gw_dash="));
    assert.ok(!cookie, "no session cookie should be issued when auto-auth is off");
    const r = await request(gatewayPort, { path: "/metrics" });
    assert.equal(r.status, 401);
  } finally {
    delete process.env.ADMIN_AUTOAUTH;
  }
});
