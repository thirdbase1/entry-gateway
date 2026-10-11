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

const GW_KEY = "gw-secret-key-0123456789abcdef";
const RL_KEY = "rl-key-0123456789abcdef-0123";
const FAIL_KEY = "failure-test-key-0123456789ab";
const ADMIN_KEY = "admin-secret-key-0123456789abcd"; // legacy: must be IGNORED by the gateway now
const METRICS_KEY = "metrics-fallback-key-0123456789abcd";

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
  // The dash-session signing secret is derived from the API keys, so this
  // suite uses realistic-length keys (server.js refuses to mint a signed
  // session on Vercel when every configured key looks low-entropy).
  process.env.GATEWAY_API_KEYS = `${GW_KEY},${RL_KEY},${FAIL_KEY}`;
  process.env.ADMIN_API_KEYS = ADMIN_KEY; // kept only to prove it is ignored
  process.env.METRICS_BEARER_KEY = METRICS_KEY;
  process.env.DASHBOARD_PUBLIC_URL = "https://admin.entry-agents.dev";
  process.env.ADMIN_AUTOAUTH = "0"; // legacy env: also ignored, set to prove it
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

test("1a. /admin no longer serves a dashboard -- it redirects or answers 410", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/admin" });
  assert.ok(!body.includes("<html") && !body.includes("<!DOCTYPE"), "the gateway must not serve HTML anymore");
  assert.ok(status === 302 || status === 410, `expected 302 redirect or 410 gone, got ${status}`);
  if (status === 302) {
    assert.match(headers.location || "", /admin\.entry-agents\.dev|^\//, "redirect target must be the configured dashboard URL");
  }
  assert.ok(!headers["set-cookie"], "the gateway must never issue a session cookie anymore");
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY), "no key may appear in any response body");
});

test("1b. even a valid Bearer token gets no HTML dashboard and no cookie", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/admin", headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.ok(status === 302 || status === 410);
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY));
  assert.ok(!headers["set-cookie"], "the legacy gw_dash session must not come back");
});

test("1c. the HTML dashboard files are gone from the repo and the response", async () => {
  const { body } = await request(gatewayPort, { path: "/admin" });
  assert.ok(!body.includes("Gateway Admin"), "old dashboard markup must not be served");
  assert.ok(!body.includes("gw_dash"), "legacy session cookie name must not appear");
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

test("3c. even first-party vercel.app origins are no longer reflected (no browser consumer remains)", async () => {
  const origin = "https://entry-agents-git-main-thirdbase1s-projects.vercel.app";
  const { headers } = await request(gatewayPort, { path: "/health", headers: { Origin: origin } });
  assert.notEqual(headers["access-control-allow-origin"], origin, "CORS allowlist must be trimmed to localhost dev only");
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

// ─── 6. Metrics permission boundary (inference key restricted) ───────────────

test("6a. the inference API key can no longer read /metrics or /v1/debug/routes", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status, body } = await request(gatewayPort, { path, headers: { Authorization: `Bearer ${GW_KEY}` } });
    assert.equal(status, 401, `${path} must reject the inference key (got ${status})`);
    assert.match(body, /AuthError/);
    assert.ok(!body.includes("upstreamBaseURL"), "route configuration must not leak on rejection");
  }
});

test("6b. a forged or stale gw_dash session cookie is rejected everywhere", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status } = await request(gatewayPort, { path, headers: { Cookie: "gw_dash=1750000000000.abcdef0123456789" } });
    assert.equal(status, 401, `${path} must reject the removed session cookie`);
  }
});

test("6b-2. the metrics fallback key reads /metrics and /v1/debug/routes", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status, body } = await request(gatewayPort, { path, headers: { Authorization: `Bearer ${METRICS_KEY}` } });
    assert.equal(status, 200, `${path} must accept METRICS_BEARER_KEY (got ${status}: ${body.slice(0, 120)})`);
  }
});

test("6c. the metrics fallback key must NOT unlock paid proxy routes", async () => {
  const { status } = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${METRICS_KEY}`, "Content-Type": "application/json" },
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(status, 401, "the metrics credential must never authorize inference");
});

test("6d. legacy ADMIN_API_KEYS are ignored entirely (deprecated privilege)", async () => {
  const { status } = await request(gatewayPort, { path: "/metrics", headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.equal(status, 401, "ADMIN_API_KEYS must no longer grant metrics access");
  const models = await request(gatewayPort, { path: "/v1/models", headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
  assert.equal(models.status, 401, "ADMIN_API_KEYS must not work on /v1/models either");
});

test("6e. a stale/legacy gw_dash-style admin session cannot reach /v1/models", async () => {
  const { status } = await request(gatewayPort, { path: "/v1/models", headers: { Cookie: "gw_dash=1750000000000.deadbeefcafebabe" } });
  assert.equal(status, 401);
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
  // Breakers are keyed by a single per-model identity (`model:<id>`), not the
  // candidate's provider label -- see cbProvider in server.js handle().
  const cb = await getCircuitBreaker("model:failing-openai", "failing-openai");
  assert.equal(failingUpstreamHits, 3);
  assert.equal(cb.state, "closed", "three failures must not trip a five-failure breaker");
  assert.equal(cb.failures, 3, "each upstream response must increment the breaker exactly once");
});


// ─── 7. Root path: redirect, never HTML ──────────────────────────────────────

test("7a. / redirects to the dashboard or answers 410 -- no HTML is served", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/" });
  assert.ok(status === 302 || status === 410, `expected 302 or 410, got ${status}`);
  assert.ok(!body.includes("<!DOCTYPE") && !body.includes("OpenAIThirdParty"), "the old landing page must be gone");
  if (status === 302) assert.match(headers.location || "", /admin\.entry-agents\.dev|^\//);
});

test("7b. / never reflects the Host header (no HTML surface remains)", async () => {
  const { body, headers } = await request(gatewayPort, { path: "/", headers: { Host: 'x"><script>alert(1)</script>' } });
  assert.ok(!body.includes("<script>alert(1)</script>"));
  if (headers.location) assert.ok(!headers.location.includes("script"), "redirect target must not reflect the Host header");
});

test("7c. / never leaks any API key", async () => {
  const { body } = await request(gatewayPort, { path: "/" });
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY) && !body.includes(METRICS_KEY));
});


