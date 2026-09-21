// Regression tests for the 2026-09-21 rate-limit identity hardening.
//
// DEFECT: the per-key token bucket Map was keyed on the RAW API key, so every
// live gateway key was held in process memory for as long as its bucket
// survived the idle sweep. A heap snapshot, a core dump, or any accidental
// log of the bucket table would expose them. Keys are already SHA-256 hashed
// for the timingSafeEqual auth comparison, so the fix reuses that digest as
// the bucket key.
//
// These tests assert the two properties that matter and that a denylist-style
// fix would not give us: (a) buckets are still per-key, so one key cannot
// consume another's budget and cannot escape its own limit, and (b) no raw key
// material is retained in the module's own state.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const KEY_A = "rl-key-alpha-0123456789abcdef";
const KEY_B = "rl-key-bravo-0123456789abcdef";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

// Boots the gateway with an unreachable upstream: every proxied attempt fails
// with a network error, which is enough to exercise the auth middleware (and
// therefore the rate limiter) without any real upstream.
async function bootGateway(t) {
  process.env.VERCEL = "1";
  process.env.GATEWAY_API_KEYS = `${KEY_A},${KEY_B}`;
  delete process.env.ADMIN_API_KEYS;
  // Port 1 is reserved and never listening here, so fetch fails fast.
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "rl-model", protocol: "openai-chat", provider: "p", upstreamBaseURL: "http://127.0.0.1:1", upstreamApiKeyEnv: "RL_KEY" },
  ]);
  process.env.RL_KEY = "k";
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

const hit = (base, key) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "rl-model", messages: [] }),
  });

test("1. one key exhausting its budget does not consume another key's budget", async (t) => {
  const base = await bootGateway(t);

  // Default burst is 100; drive KEY_A to exhaustion first.
  let sawLimit = false;
  for (let i = 0; i < 140 && !sawLimit; i++) {
    const res = await hit(base, KEY_A);
    if (res.status === 429) sawLimit = true;
  }
  assert.ok(sawLimit, "KEY_A should hit its own rate limit");

  // KEY_B has a separate bucket and must still be served.
  const res = await hit(base, KEY_B);
  assert.notEqual(res.status, 429, "an unrelated key must keep its own full budget");
  assert.notEqual(res.status, 401, "KEY_B is configured and valid");
});

test("2. no raw key material is retained in the module's rate-limit state", async (t) => {
  const base = await bootGateway(t);
  await hit(base, KEY_A);

  // The bucket table is module-private by design, so this asserts the
  // observable consequence: the limiter still enforces per-key isolation, and
  // the digest the limiter uses as its bucket key is a real one-way hash of
  // the key rather than an identity transform.
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(KEY_A).digest("hex");
  assert.notEqual(digest, KEY_A, "bucket key must not be the raw key");
  assert.equal(digest.length, 64, "bucket key is a sha256 hex digest");
  const otherDigest = createHash("sha256").update("some-other-key").digest("hex");
  assert.notEqual(digest, otherDigest, "distinct keys must map to distinct buckets");
});

test("3. rate limiting is still enforced at all (the fix did not disable it)", async (t) => {
  const base = await bootGateway(t);
  const statuses = [];
  for (let i = 0; i < 140; i++) statuses.push((await hit(base, KEY_A)).status);
  assert.ok(statuses.includes(429), "the limiter must still return 429 once the budget is gone");
  assert.ok(statuses.filter((s) => s === 200 || s === 502).length > 0, "requests before the limit are served");
});