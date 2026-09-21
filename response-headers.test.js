// Regression tests for the 2026-09-21 response-header hardening pass.
//
// Three real defects found by probing a live gateway instance against a
// deliberately hostile mock upstream, all fixed in the same change:
//
//   1. proxy() forwarded upstream response headers through a 4-item DENYLIST,
//      so Authorization, x-api-key and set-cookie from the upstream reached
//      the client verbatim -- a compromised or hostile provider could both
//      leak its own credentials to every caller and plant cookies.
//   2. The upstream could forge x-gateway-request-id, which is the gateway's
//      own correlation header, poisoning log joins and any support workflow
//      built on it.
//   3. cacheSummary() divided cache_read by uncached-only input, so a normal
//      90%-cached request logged cacheRatio: 9 (900%).
//
// Same discipline as the rest of this repo's suites: node:test + node:http
// only, zero new dependencies, mock upstreams on ephemeral ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "hdr-test-gateway-key-0123456789";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

// Boots the real server.js against a caller-supplied upstream handler and
// returns the gateway base URL plus a teardown.
async function bootGateway(t, upstreamHandler, routes) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  process.env.VERCEL = "1"; // don't app.listen()
  process.env.GATEWAY_API_KEYS = GW_KEY;
  delete process.env.ADMIN_API_KEYS;
  process.env.MODEL_ROUTES_JSON = JSON.stringify(
    routes.map((r) => ({
      protocol: "openai-chat",
      provider: "test-upstream",
      upstreamApiKeyEnv: "TEST_HDR_KEY",
      ...r,
      upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`,
    })),
  );
  process.env.TEST_HDR_KEY = "dummy-upstream-key";
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

const chat = (base, body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("1a. credential-bearing upstream headers never reach the client", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-upstream-should-never-leak",
      "x-api-key": "upstream-x-api-key-should-never-leak",
      "Proxy-Authorization": "Basic should-never-leak",
      "set-cookie": "session=evil; Path=/",
      "www-authenticate": "Basic realm=upstream",
    });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "leaky-model" }]);

  const res = await chat(base, { model: "leaky-model", messages: [] });
  assert.equal(res.status, 200);
  for (const h of ["authorization", "x-api-key", "proxy-authorization", "set-cookie", "www-authenticate"]) {
    assert.equal(res.headers.get(h), null, `${h} must not be forwarded from upstream`);
  }
});

test("1b. the upstream cannot forge the gateway's own request id", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "x-gateway-request-id": "FORGED-BY-UPSTREAM" });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "forge-model" }]);

  const res = await chat(base, { model: "forge-model", messages: [] });
  assert.equal(res.status, 200);
  const id = res.headers.get("x-gateway-request-id");
  assert.ok(id, "gateway request id must be present");
  assert.notEqual(id, "FORGED-BY-UPSTREAM", "upstream must not be able to set the gateway's correlation header");
  assert.match(id, /^gw_\d+_[a-z0-9]+$/, "must keep the gateway's own id shape");
});

test("1c. the upstream's own request id is preserved under a distinct name", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "x-request-id": "req_upstream_abc123" });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "reqid-model" }]);

  const res = await chat(base, { model: "reqid-model", messages: [] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-upstream-request-id"), "req_upstream_abc123");
  assert.equal(res.headers.get("x-request-id"), null, "must not be forwarded under its own name");
});

test("1d. rate-limit and retry hints the client can act on still pass through", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "retry-after": "7",
      "x-ratelimit-remaining-requests": "42",
      "anthropic-ratelimit-tokens-remaining": "9001",
      "openai-version": "2026-01-01",
    });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "hint-model" }]);

  const res = await chat(base, { model: "hint-model", messages: [] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("retry-after"), "7");
  assert.equal(res.headers.get("x-ratelimit-remaining-requests"), "42");
  assert.equal(res.headers.get("anthropic-ratelimit-tokens-remaining"), "9001");
  assert.equal(res.headers.get("openai-version"), "2026-01-01");
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/, "content-type must survive");
});

test("1e. an unknown upstream-specific header is dropped rather than forwarded", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-some-future-provider-header": "value",
      "x-internal-trace-id": "trace-123",
    });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "unknown-hdr-model" }]);

  const res = await chat(base, { model: "unknown-hdr-model", messages: [] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-some-future-provider-header"), null);
  assert.equal(res.headers.get("x-internal-trace-id"), null);
});

test("2. cacheRatio is a real ratio, never above 1.0", async (t) => {
  // prompt_tokens is the TOTAL prompt with cached_tokens as a subset, so
  // usageOf() reports input=1000, cache_read=900; cacheBreakdownOf()
  // normalizes that to uncached input 100 + cache_read 900. The old
  // cacheSummary() divided 900 by 100 and logged cacheRatio: 9.
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl-1",
      usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 900 },
    }));
  }, [{ id: "cache-model", cost: { input: 1, output: 2, cache_read: 0.1 } }]);

  const logged = [];
  const origLog = console.log;
  console.log = (line) => logged.push(line);
  try {
    const res = await chat(base, { model: "cache-model", messages: [] });
    assert.equal(res.status, 200);
  } finally {
    console.log = origLog;
  }

  const entry = logged.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((x) => x?.type === "request");
  assert.ok(entry, "a request log line must be emitted");
  assert.equal(entry.usage.input, 100, "normalized input is uncached-only");
  assert.equal(entry.usage.cache_read, 900);
  assert.equal(entry.cache.cacheRatio, 0.9, "cache_read / total prompt tokens");
  assert.ok(entry.cache.cacheRatio <= 1, "a cache ratio can never exceed 100%");
  assert.equal(entry.cache.cacheStatus, "hit");
});

test("3. every rejected request still carries a gateway request id", async (t) => {
  const base = await bootGateway(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, [{ id: "ok-model" }]);

  const post = (body, headers = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

  const cases = [
    ["invalid key", await post(JSON.stringify({ model: "ok-model" }), { Authorization: "Bearer wrong-key" })],
    ["missing key", await post(JSON.stringify({ model: "ok-model" }))],
    ["unknown model", await post(JSON.stringify({ model: "no-such-model" }), { Authorization: `Bearer ${GW_KEY}` })],
    ["missing model", await post(JSON.stringify({ messages: [] }), { Authorization: `Bearer ${GW_KEY}` })],
    ["non-object body", await post('"hi"', { Authorization: `Bearer ${GW_KEY}` })],
    ["malformed json", await post("{not json", { Authorization: `Bearer ${GW_KEY}` })],
    ["body too large", await post(JSON.stringify({ model: "ok-model", messages: [{ role: "user", content: "x".repeat(30 * 1024 * 1024) }] }), { Authorization: `Bearer ${GW_KEY}` })],
  ];

  for (const [label, res] of cases) {
    assert.ok(res.status >= 400, `${label} should be an error status, got ${res.status}`);
    const id = res.headers.get("x-gateway-request-id");
    assert.ok(id, `${label} must carry a gateway request id`);
    assert.match(id, /^gw_\d+_[a-z0-9]+$/, `${label} id shape`);
  }
});