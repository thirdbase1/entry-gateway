// Tests for the startup configuration validator (config-validation.js).
//
// Motivation: every route lives in operator-supplied JSON env vars. Before
// this, a malformed route surfaced only at request time as an opaque 502, and
// several field types were silently coerced (a string priority, a truthy
// `cost: 0`) producing routes that "worked" but sorted or billed wrong. The
// validator reports all of these at startup, in one pass, without throwing.
//
// Pure unit tests -- no server, no network, no ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRoute, validateRoutes, validateStartupConfig } from "./config-validation.js";

const GOOD_ENV = { PROVIDER_KEY: "sk-test" };

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const goodRoute = () => ({
  id: "test-model",
  protocol: "openai-chat",
  provider: "test",
  upstreamBaseURL: "https://api.example.com/v1",
  upstreamApiKeyEnv: "PROVIDER_KEY",
  priority: 10,
  cost: { input: 1, output: 2 },
});

test("1. a well-formed route produces no problems", () => {
  withEnv(GOOD_ENV, () => {
    assert.deepEqual(validateRoute(goodRoute(), 0), []);
  });
});

test("2. a missing provider key env var is reported, naming the var not the key", () => {
  withEnv({ ...GOOD_ENV, PROVIDER_KEY: undefined }, () => {
    const problems = validateRoute(goodRoute(), 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /PROVIDER_KEY is not set/);
    // The message must identify the ENV VAR NAME, never any secret value.
    assert.ok(!problems[0].includes("sk-test"), "must not echo any key material");
  });
});

test("3. a non-http(s) upstream is rejected (SSRF guard parity)", () => {
  withEnv(GOOD_ENV, () => {
    const problems = validateRoute({ ...goodRoute(), upstreamBaseURL: "file:///proc/self/environ" }, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must be http/);
  });
  withEnv(GOOD_ENV, () => {
    const problems = validateRoute({ ...goodRoute(), upstreamBaseURL: "not-a-url" }, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a parseable URL/);
  });
});

test("4. string-typed numeric fields are flagged instead of silently coerced", () => {
  withEnv(GOOD_ENV, () => {
    const problems = validateRoute({ ...goodRoute(), priority: "10", timeoutMs: "5000", billingMultiplier: "5" }, 0);
    assert.equal(problems.length, 3, "priority, timeoutMs and billingMultiplier are all wrong-typed");
    assert.ok(problems.some((p) => p.includes('"priority" must be a finite number')));
    assert.ok(problems.some((p) => p.includes('"timeoutMs" must be a finite number')));
    assert.ok(problems.some((p) => p.includes('"billingMultiplier" must be a finite number')));
  });
});

test("5. NaN and Infinity are rejected as numeric values", () => {
  withEnv(GOOD_ENV, () => {
    // JSON.parse turns NaN/Infinity into null, but a programmatic caller (or a
    // hand-edited env var round-tripped through a non-standard parser) can
    // produce the real values.
    const problems = validateRoute({ ...goodRoute(), priority: Number.NaN, timeoutMs: Number.POSITIVE_INFINITY }, 0);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.includes("finite number")));
  });
});

test("6. unknown protocol and authStyle values are reported", () => {
  withEnv(GOOD_ENV, () => {
    const problems = validateRoute({ ...goodRoute(), protocol: "openai-responses", authStyle: "magic" }, 0);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /unknown protocol/);
    assert.match(problems[1], /unknown authStyle/);
  });
});

test("7. cost object entries are type-checked, including context tiers", () => {
  withEnv(GOOD_ENV, () => {
    const problems = validateRoute({
      ...goodRoute(),
      cost: { input: 1, output: "2", cache_read: 0.1, context_over_272k: { input: 2, output: 4 }, context_over_200k: 9 },
    }, 0);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes('cost.output must be a finite number')));
    assert.ok(problems.some((p) => p.includes('cost.context_over_200k must be an object')));
  });
});

test("8. validateRoutes reports every problem in one pass, not just the first", () => {
  withEnv(GOOD_ENV, () => {
    const problems = validateRoutes([
      goodRoute(),
      { id: "bad-1", upstreamBaseURL: "ftp://x" },
      { id: "bad-2", upstreamBaseURL: "https://api.example.com/v1" },
      "not-an-object",
    ], "TEST_ROUTES");
    // bad-1: missing apiKeyEnv + bad scheme; bad-2: missing apiKeyEnv;
    // string entry: not an object.
    assert.ok(problems.length >= 4, `expected several problems, got ${problems.length}`);
    assert.ok(problems.some((p) => p.includes("bad-1")));
    assert.ok(problems.some((p) => p.includes("bad-2")));
  });
});

test("9. a non-array route source is reported as such", () => {
  const problems = validateRoutes({ id: "oops" }, "TEST_ROUTES");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected a JSON array of routes/);
});

test("10. validateStartupConfig aggregates route and discovery problems", () => {
  withEnv({ ...GOOD_ENV, DISCOVERY_KEY: undefined }, () => {
    const count = validateStartupConfig({
      routeSources: [["TEST_ROUTES", [{ id: "x", upstreamBaseURL: "https://a.example.com" }]]],
      discoverySources: [{ url: "https://a.example.com/v1/models", apiKeyEnv: "DISCOVERY_KEY", protocols: ["openai-chat"] }],
    });
    // route missing apiKeyEnv, plus discovery key not set.
    assert.ok(count >= 2, `expected at least 2 problems, got ${count}`);
  });
});

test("11. a fully valid configuration reports zero problems", () => {
  withEnv(GOOD_ENV, () => {
    const count = validateStartupConfig({
      routeSources: [["TEST_ROUTES", [goodRoute()]]],
      discoverySources: [{ url: "https://a.example.com/v1/models", apiKeyEnv: "PROVIDER_KEY", protocols: ["openai-chat"] }],
    });
    assert.equal(count, 0);
  });
});