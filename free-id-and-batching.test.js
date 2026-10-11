// Regression tests for the 2026-10-10 follow-up pass:
//   1. ":free" id normalization: routes configured with a ":free" suffix are
//      exposed publicly WITHOUT the suffix (catalog, routing, metrics,
//      breakers) while the upstream still receives the REAL ":free" id.
//      Legacy clients that still send the ":free" id keep working.
//   2. Metrics write micro-batcher: in DB mode record* enqueues and the
//      window flush persists (or, when the database is unreachable, drains
//      the whole window into the in-memory fallback so nothing vanishes).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GW_KEY = "free-id-test-gateway-key-0123456789";
const METRICS_KEY = "free-id-metrics-key-0123456789";

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

const settle = () => new Promise((r) => setTimeout(r, 100));

let upstream;
let capturedModels = [];
let upstreamPort;
let gateway;
let gatewayPort;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(raw || "{}").model || ""; } catch {}
      capturedModels.push(model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  upstreamPort = await listen(upstream);

  process.env.VERCEL = "1";
  process.env.GATEWAY_API_KEYS = GW_KEY;
  process.env.METRICS_BEARER_KEY = METRICS_KEY;
  delete process.env.ADMIN_API_KEYS;
  delete process.env.MAX_DAILY_SPEND_USD;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.FREE_UP_KEY = "dummy";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    // The ":free" id in operator config is what users should never see.
    { id: "qwen3.8-flash:free", protocol: "openai-chat", provider: "qwenfree", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "FREE_UP_KEY" },
    // An explicit upstreamModel already carrying the real id is respected.
    { id: "mimo-v2.6-flash:free", protocol: "openai-chat", provider: "mimofree", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "FREE_UP_KEY", upstreamModel: "mimo-v2.6-flash:free" },
    // A paid route for the same public id as the free one coexists as a
    // fallback candidate instead of colliding (different upstream model).
    { id: "glm-5.3-flash", protocol: "openai-chat", provider: "glmpaid", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "FREE_UP_KEY", priority: 10 },
    { id: "glm-5.3-flash:free", protocol: "openai-chat", provider: "glmfree", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "FREE_UP_KEY", priority: 20 },
  ]);
  const { default: app } = await import(`./server.js?freeid=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);
});

test.after(async () => {
  gateway?.closeAllConnections?.();
  gateway?.close?.();
  upstream?.closeAllConnections?.();
  upstream?.close?.();
});

const post = (model) => request(gatewayPort, {
  method: "POST",
  path: "/v1/chat/completions",
  headers: { Authorization: `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
  body: { model, messages: [{ role: "user", content: "hi" }] },
});

// ─── 1. :free normalization ──────────────────────────────────────────────────

test("1a. /v1/models lists the stripped public id, never the :free suffix", async () => {
  const r = await request(gatewayPort, { path: "/v1/models", headers: { Authorization: `Bearer ${GW_KEY}` } });
  assert.equal(r.status, 200);
  const ids = JSON.parse(r.body).data.map((m) => m.id);
  assert.ok(ids.includes("qwen3.8-flash"), `stripped id must be listed, got: ${ids.join(",")}`);
  assert.ok(ids.includes("mimo-v2.6-flash"));
  assert.ok(!ids.some((id) => /:free/i.test(id)), `no public id may carry the :free suffix: ${ids.join(",")}`);
});

test("1b. a request for the stripped id reaches the upstream with the REAL :free id", async () => {
  const r = await post("qwen3.8-flash");
  assert.equal(r.status, 200);
  await settle();
  assert.equal(capturedModels.at(-1), "qwen3.8-flash:free", "the upstream must receive the real configured id");
});

test("1c. an explicit upstreamModel wins over the auto-derived one", async () => {
  await post("mimo-v2.6-flash");
  await settle();
  assert.equal(capturedModels.at(-1), "mimo-v2.6-flash:free");
});

test("1d. legacy clients still sending the :free id keep working", async () => {
  const r = await post("qwen3.8-flash:free");
  assert.equal(r.status, 200, `legacy alias must route, got ${r.status}: ${r.body}`);
  await settle();
  assert.equal(capturedModels.at(-1), "qwen3.8-flash:free");
});

test("1e. a paid route and a stripped free route coexist for one public id (priority order)", async () => {
  const r = await post("glm-5.3-flash");
  assert.equal(r.status, 200);
  await settle();
  // priority 10 (paid, glm paid route has no :free -> upstream model is the plain id)
  assert.equal(capturedModels.at(-1), "glm-5.3-flash", "the lower-priority-number (paid) route serves first");
});

test("1f. metrics and circuit breakers record under the stripped id", async () => {
  await post("qwen3.8-flash");
  await settle();
  const m = await request(gatewayPort, { path: "/metrics?daily=global", headers: { Authorization: `Bearer ${METRICS_KEY}` } });
  const snap = JSON.parse(m.body);
  assert.ok(snap.byModel["qwen3.8-flash"], `metrics must use the stripped id, got: ${Object.keys(snap.byModel).join(",")}`);
  assert.ok(!Object.keys(snap.byModel).some((k) => /:free/i.test(k)), "no :free key may appear in metrics");
  assert.ok(snap.byModel["qwen3.8-flash"].requests >= 2);
  assert.ok(!Object.keys(snap.circuitBreakers).some((k) => /:free/i.test(k)), "breaker keys use stripped ids");
});

// ─── 2. Metrics micro-batcher ────────────────────────────────────────────────
// Points the store at the same unreachable-host technique used by
// metrics-store-db-failure.test.js to verify the enqueue -> flush -> drain-
// to-memory path end to end (no real database involved).
process.env.GATEWAY_METRICS_DATABASE_URL =
  "postgresql://user:pass@invalid-nonexistent-db-host.example.invalid/db?sslmode=require";
const batchStore = await import("./metrics-store.js?batcher=1");

test("2a. recordRequest in DB mode enqueues without throwing and flushPendingWrites resolves", async () => {
  batchStore.recordRequest("batchprov", "batchmodel", 200, 12, 3, { input: 5, output: 2, cache_read: 0, cache_write: 0, reasoning: 0 }, 0.01, false);
  batchStore.recordUpstreamError("batchprov", "batchmodel");
  await assert.doesNotReject(batchStore.flushPendingWrites());
});

test("2b. a failed flush drains the whole window into the in-memory fallback", async () => {
  // Fresh events (the earlier test's window was already drained).
  batchStore.recordRequest("batchprov2", "batchmodel2", 200, 7, null, { input: 3, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 }, 0.02, false);
  await batchStore.flushPendingWrites(); // DB unreachable -> drains to mem
  const snap = await batchStore.getMetricsSnapshot(["batchprov2"], ["batchmodel2"]);
  const m = snap.byModel["batchmodel2"];
  assert.ok(m, "the drained window must be visible through the in-memory fallback");
  assert.equal(m.requests, 1);
  assert.equal(m.tokens.input, 3);
  assert.equal(m.estimatedSpend, 0.02);
  assert.equal(m.statusBreakdown["200"], 1);
  const d = (snap.daily || []).find((r) => r.scope === "model" && r.name === "batchmodel2");
  assert.ok(d && d.requests >= 1, "the drained window must also land in the in-memory daily history");
});

test("2c. multiple events in one window merge into single per-bucket accumulators", async () => {
  for (let i = 0; i < 5; i++) {
    batchStore.recordRequest("batchprov3", "batchmodel3", 200, i + 1, null, { input: 2, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 }, 0.001, i > 3);
  }
  await batchStore.flushPendingWrites();
  const snap = await batchStore.getMetricsSnapshot(["batchprov3"], ["batchmodel3"]);
  const m = snap.byModel["batchmodel3"];
  assert.equal(m.requests, 5, "five merged events sum into one bucket");
  assert.equal(m.tokens.input, 10);
  assert.equal(m.fallbacks, 1);
  assert.equal(m.latency.count, 5, "all five latency samples survive the merge");
  assert.equal(m.latency.avg, 3, "avg of 1..5 = 3");
});

test("2d. flushPendingWrites is safe to call concurrently and repeatedly", async () => {
  batchStore.recordRequest("batchprov4", "batchmodel4", 200, 1, null, null, null, false);
  await Promise.all([
    batchStore.flushPendingWrites(),
    batchStore.flushPendingWrites(),
    batchStore.flushPendingWrites(),
  ]);
  // A second round with a fresh event must still land exactly once.
  batchStore.recordRequest("batchprov4", "batchmodel4", 200, 1, null, null, null, false);
  await batchStore.flushPendingWrites();
  const snap = await batchStore.getMetricsSnapshot(["batchprov4"], ["batchmodel4"]);
  assert.equal(snap.byModel["batchmodel4"].requests, 2, "no double-count across concurrent flush callers");
});

// ─── 3. Flush-statement shape (regression: the INSERT branch must be complete)
// The real-Postgres verification caught the first version of the batcher
// inserting '{}' for status_breakdown and unsliced lat/ttft on a bucket's
// FIRST flush (the ON CONFLICT branch never ran) -- statuses in that window
// were lost forever. These pin the fixed shape.
test("3a. bucket flush statement carries statuses and sliced samples in the INSERT branch", async () => {
  delete process.env.GATEWAY_METRICS_DATABASE_URL;
  const store = await import("./metrics-store.js?stmt-shape=1");
  const acc = {
    requests: 2, r2xx: 1, r4xx: 1, r5xx: 0, upstreamErrors: 0, fallbacks: 0,
    tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: 0 },
    spend: 0.01, statuses: { "200": 1, "400": 1 },
    lat: Array.from({ length: 600 }, (_, i) => i + 1),
    ttft: [],
  };
  const stmt = store.buildBucketFlushStatement("provider", "shape-model", acc);
  const insertPart = stmt.text.slice(0, stmt.text.indexOf("ON CONFLICT"));
  assert.match(insertPart, /jsonb_build_object\(/, "INSERT branch must build the merged statuses");
  assert.match(insertPart, /\$17::text/, "status codes must be bound parameters in the INSERT branch");
  assert.doesNotMatch(insertPart, /'\{\}'::jsonb/, "INSERT branch must not hardcode an empty status object");
  // lat is JS-sliced to MAX_SAMPLES before binding (600 -> 500 samples).
  assert.equal(stmt.params[14].length, 500, "lat samples must be sliced to MAX_SAMPLES for the INSERT branch");
  // The conflict branch keeps the SQL-side trim (old + new samples together).
  assert.match(stmt.text, /gw_metrics_buckets\.lat \|\| \$15::double precision\[\]\)\[/, "conflict branch must SQL-trim merged samples");
  // Statuses also appear in the conflict-branch chain.
  assert.match(stmt.text, /jsonb_set\(/, "conflict branch must chain jsonb_set for status increments");
});

test("3b. daily flush statement carries statuses in the INSERT branch too", async () => {
  const store = await import("./metrics-store.js?stmt-shape=1");
  const acc = {
    requests: 1, r2xx: 1, r4xx: 0, r5xx: 0, upstreamErrors: 0, fallbacks: 0,
    tokens: { input: 1, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
    spend: 0, statuses: { "200": 1 }, lat: [], ttft: [],
  };
  const stmt = store.buildDailyFlushStatement("2026-10-10", "global", "_", acc);
  const insertPart = stmt.text.slice(0, stmt.text.indexOf("ON CONFLICT"));
  assert.match(insertPart, /jsonb_build_object\(/, "daily INSERT branch must build merged statuses");
  assert.doesNotMatch(insertPart, /'\{\}'::jsonb/, "daily INSERT branch must not hardcode an empty status object");
});

test("3c. an empty-status window still produces valid statements", async () => {
  const store = await import("./metrics-store.js?stmt-shape=1");
  const acc = { requests: 1, r2xx: 0, r4xx: 0, r5xx: 0, upstreamErrors: 0, fallbacks: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 }, spend: 0, statuses: {}, lat: [], ttft: [] };
  const bucket = store.buildBucketFlushStatement("provider", "empty-model", acc);
  assert.match(bucket.text.slice(0, bucket.text.indexOf("ON CONFLICT")), /'\{\}'::jsonb/, "empty statuses fall back to '{}'");
  const daily = store.buildDailyFlushStatement("2026-10-10", "provider", "empty-model", acc);
  assert.match(daily.text.slice(0, daily.text.indexOf("ON CONFLICT")), /'\{\}'::jsonb/);
  assert.deepEqual(bucket.params[14], [], "empty lat stays an empty array parameter");
});
