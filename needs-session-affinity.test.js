// Unit test for needsSessionAffinity() (server.js). Regression test for
// the 2026-08-28 bug: the prompt_cache_key session-affinity fix (built
// 2026-08-19 for gpt-5.6/FreeModel) never covered the api.b.ai-hosted
// models added 2026-08-28 (deepseek-v4-flash-vision-exp, glm-5.3-flash,
// qwen3.8-flash) since they're routed under three different `provider`
// values (deepseek/zai/qwen, matching each model's real creator for
// pricing) despite sharing one physical api.b.ai backend that needs the
// same affinity treatment. Confirmed live via the admin reasoning-probe
// route that all three genuinely cache (cached_tokens 0 -> ~2048/1920 on
// a repeat identical request) when session-affine, so this was a real
// production cache-hit-ratio bug, not a "these models don't cache" limit.
import { test } from "node:test";
import assert from "node:assert/strict";

// Same guard fallback.test.js uses: server.js app.listen()s at module
// scope unless VERCEL is set. Without this, `node --test *.test.js` makes
// this file bind :8787 and whichever test file binds it second crashes
// with EADDRINUSE (this exact failure was first seen 2026-09-10 -- the
// test had shipped uncommitted with no guard).
process.env.VERCEL = "1";
const { needsSessionAffinity } = await import("./server.js");

test("gpt-5.6 family via freemodel needs session affinity", () => {
  assert.equal(needsSessionAffinity("freemodel", "gpt-5.6-luna", "https://vip-sg.freemodel.dev"), true);
  assert.equal(needsSessionAffinity("freemodel", "gpt-5.6-sol", "https://api.freemodel.dev"), true);
});

test("non-gpt-5.6 freemodel models do not need it", () => {
  assert.equal(needsSessionAffinity("freemodel", "gpt-5.5", "https://api.freemodel.dev"), false);
});

test("all three api.b.ai-hosted models need session affinity regardless of their provider label", () => {
  assert.equal(needsSessionAffinity("deepseek", "deepseek-v4-flash-vision-exp", "https://api.b.ai/v1"), true);
  assert.equal(needsSessionAffinity("zai", "glm-5.3-flash", "https://api.b.ai/v1"), true);
  assert.equal(needsSessionAffinity("qwen", "qwen3.8-flash", "https://api.b.ai/v1"), true);
});

test("an unrelated provider/host does not need it", () => {
  assert.equal(needsSessionAffinity("opencode-zen", "kimi-k3", "https://opencode.ai/zen/v1"), false);
});

test("handles a malformed upstreamBaseURL without throwing", () => {
  assert.equal(needsSessionAffinity("qwen", "qwen3.8-flash", "not-a-url"), false);
});
