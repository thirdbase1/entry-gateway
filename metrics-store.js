// ─── Durable, cross-instance metrics + circuit-breaker store ─────────────────
//
// WHY THIS FILE EXISTS: this gateway runs on Vercel serverless functions
// (see api/index.js + vercel.json rewrite). Serverless functions are
// stateless between invocations -- there is no guarantee the request that
// proxies a chat completion and the later request that reads /metrics (or
// even two concurrent chat requests) land on the same warm instance. A
// plain module-level JS object only ever reflects whatever traffic
// happened to hit *that one* instance since its last cold start -- so real
// production traffic could rack up hundreds of requests while /metrics
// (hit by a different, fresher instance) kept reporting 0, and circuit
// breakers never reliably tripped either since each instance had its own
// isolated failure count.
//
// Fix: persist every counter, status-code breakdown, latency/ttft sample,
// and circuit-breaker state in Postgres (Neon, via the same database
// entry-agents already runs on -- @neondatabase/serverless's HTTP driver
// needs no persistent connection/pool, so it's just as serverless-friendly
// as a REST-based store). All instances read and write the same tables,
// so metrics and circuit-breaker state stay consistent no matter which
// instance handles which request.
//
// HISTORY: this used to be backed by Upstash Redis (KV_REST_API_URL/
// KV_REST_API_TOKEN). Migrated off it entirely 2026-08-27 after Upstash
// rate-limited this project's Redis instance in production, which (on top
// of the missing-try/catch bug fixed earlier that same day) was the
// second real incident traced back to Upstash-side throttling in about a
// week (the first hit entry-agents' own separate Redis instance). Postgres
// isn't immune to outages either, so every function here still fails open
// to an in-memory fallback exactly like the old Redis version did -- see
// the "DB health circuit breaker" section below -- but at least it's no
// longer the SAME shared Upstash account/quota as everything else.
//
// Falls back to an in-memory store (old behavior, single-instance-only)
// if GATEWAY_METRICS_DATABASE_URL isn't configured, so local dev still
// works without a real database -- it just won't be cross-instance
// consistent, which is fine for a single local `node server.js` process.

import { neon } from "@neondatabase/serverless";

const MAX_SAMPLES = 500; // capped list length per latency/ttft series

let sql = null;
if (process.env.GATEWAY_METRICS_DATABASE_URL) {
  sql = neon(process.env.GATEWAY_METRICS_DATABASE_URL);
} else {
  console.error(JSON.stringify({
    type: "metrics_store_fallback",
    message: "GATEWAY_METRICS_DATABASE_URL not set -- metrics and circuit breakers will be IN-MEMORY ONLY and will not be consistent across serverless instances.",
  }));
}

export const usingDb = () => sql !== null;

// ─── DB health circuit breaker (in-process, NOT the DB-backed per-model
// circuit breaker below -- this one protects access to the database
// itself) ──────────────────────────────────────────────────────────────────
//
// Same fail-open + short-cooldown pattern already used for entry-agents'
// own rate limiter (lib/rate-limit.ts) and for this gateway's earlier
// Upstash incident: catch every real DB error, fall back to the existing
// in-memory path for that one call, and open a short in-process circuit
// so a sustained DB outage doesn't force every subsequent request to pay
// a doomed round-trip before giving up. Metrics and circuit-breaking are
// both non-critical secondary concerns -- they must never be able to
// block or slow down the actual proxy request.
const DB_CIRCUIT_COOLDOWN_MS = 15_000;
let dbCircuitOpenedAt = null;
let schemaEnsuredAt = null; // re-checked once per cooldown window too

function isDbCircuitOpen() {
  if (dbCircuitOpenedAt === null) return false;
  if (Date.now() - dbCircuitOpenedAt > DB_CIRCUIT_COOLDOWN_MS) {
    dbCircuitOpenedAt = null;
    return false;
  }
  return true;
}

function recordDbFailure(error) {
  const wasAlreadyOpen = dbCircuitOpenedAt !== null;
  dbCircuitOpenedAt = Date.now();
  if (!wasAlreadyOpen) {
    console.error(JSON.stringify({
      type: "metrics_store_db_degraded",
      message: "A database call failed -- metrics and circuit-breaker checks are temporarily fail-open/in-memory-only on this instance so requests keep flowing.",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// True when it's worth even trying a real DB call right now.
function dbUsable() {
  return sql !== null && !isDbCircuitOpen();
}

// CREATE TABLE IF NOT EXISTS is idempotent and cheap, so this is safe to
// re-run on every cold start (memoized per warm instance) and to retry
// again after a DB-circuit cooldown elapses.
async function ensureSchema() {
  if (schemaEnsuredAt !== null) return;
  await sql`
    CREATE TABLE IF NOT EXISTS gw_metrics_buckets (
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      requests BIGINT NOT NULL DEFAULT 0,
      requests_2xx BIGINT NOT NULL DEFAULT 0,
      requests_4xx BIGINT NOT NULL DEFAULT 0,
      requests_5xx BIGINT NOT NULL DEFAULT 0,
      upstream_errors BIGINT NOT NULL DEFAULT 0,
      fallbacks BIGINT NOT NULL DEFAULT 0,
      tokens_input BIGINT NOT NULL DEFAULT 0,
      tokens_output BIGINT NOT NULL DEFAULT 0,
      tokens_cache_read BIGINT NOT NULL DEFAULT 0,
      tokens_cache_write BIGINT NOT NULL DEFAULT 0,
      tokens_reasoning BIGINT NOT NULL DEFAULT 0,
      estimated_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
      status_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      lat DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
      ttft DOUBLE PRECISION[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (scope, name)
    )
  `;
  // Added 2026-09-10: per-day metrics history. The original
  // gw_metrics_buckets above is a single cumulative all-time counter per
  // (scope, name) -- it has NO time dimension at all, so the /metrics
  // snapshot could never answer "how much traffic ran yesterday vs
  // today". This table writes the same counters rolled up per Nigeria-local
  // day (12am WAT, per the 2026-09-10 owner request).
  // Retention is deliberately UNBOUNDED -- nothing ever deletes these
  // rows, so history is kept indefinitely (well past a year); if the
  // table ever gets too big, aggregate further rather than truncate.
  // lat/ttft sample arrays are intentionally NOT kept per day -- they
  // are unbounded-ish per row and only matter for the live percentile
  // view, which stays on the cumulative table.
  await sql`
    CREATE TABLE IF NOT EXISTS gw_metrics_daily (
      day DATE NOT NULL,
      scope TEXT NOT NULL,
      name TEXT NOT NULL,
      requests BIGINT NOT NULL DEFAULT 0,
      requests_2xx BIGINT NOT NULL DEFAULT 0,
      requests_4xx BIGINT NOT NULL DEFAULT 0,
      requests_5xx BIGINT NOT NULL DEFAULT 0,
      upstream_errors BIGINT NOT NULL DEFAULT 0,
      fallbacks BIGINT NOT NULL DEFAULT 0,
      tokens_input BIGINT NOT NULL DEFAULT 0,
      tokens_output BIGINT NOT NULL DEFAULT 0,
      tokens_cache_read BIGINT NOT NULL DEFAULT 0,
      tokens_cache_write BIGINT NOT NULL DEFAULT 0,
      tokens_reasoning BIGINT NOT NULL DEFAULT 0,
      estimated_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
      status_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (day, scope, name)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS gw_metrics_gauges (
      name TEXT PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0
    )
  `;
  // Short-TTL leases for genuinely in-flight upstream work (see
  // beginActiveLease above). Rows are deleted on completion and TTL-evicted
  // on read, so this table stays at roughly the size of the real in-flight
  // set. Additive 2026-10-10; the old gw_metrics_gauges rows are left
  // untouched (no destructive migration -- the counters there are simply no
  // longer read for activeRequests/activeStreams).
  await sql`
    CREATE TABLE IF NOT EXISTS gw_active_leases (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS gw_circuit_breakers (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'closed',
      failures INT NOT NULL DEFAULT 0,
      opened_at BIGINT,
      PRIMARY KEY (provider, model)
    )
  `;
  // Generic small TTL-keyed cache table -- shared with gemini-cache.js so
  // that module doesn't need its own separate DB dependency. TTL is
  // enforced in application code (expires_at_ms check on read), matching
  // how it already worked against Redis (no cron eviction needed at this
  // volume; a stale row is just a few hundred bytes).
  await sql`
    CREATE TABLE IF NOT EXISTS gw_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at_ms BIGINT
    )
  `;
  schemaEnsuredAt = Date.now();
}

// ─── In-memory fallback (dev only, and DB-outage fail-open) ─────────────────

const mem = {
  buckets: new Map(), // key -> { counters, status, lat[], ttft[] }
  daily: new Map(), // "YYYY-MM-DD|scope|name" -> per-day counters (2026-09-10)
  sets: new Map(), // key -> Set
  gauges: new Map(), // key -> number
  cbs: new Map(), // key -> {state,failures,openedAt,threshold,cooldownMs}
  kv: new Map(), // key -> { value, expiresAtMs }
};
// Circuit updates are launched off the request hot path. Serialize updates for
// each provider/model so concurrent completions cannot all read the same state
// and overwrite one another with the same failure count.
const circuitQueues = new Map();
function withCircuitLock(key, update) {
  const previous = circuitQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(update);
  circuitQueues.set(key, current);
  return current.finally(() => {
    if (circuitQueues.get(key) === current) circuitQueues.delete(key);
  });
}
function memBucket(key) {
  if (!mem.buckets.has(key)) {
    mem.buckets.set(key, {
      counters: {},
      status: {},
      lat: [],
      ttft: [],
      models: {},
    });
  }
  return mem.buckets.get(key);
}

// Percentiles use the nearest-rank method (ceil(p/100 * n), 1-indexed), the
// textbook definition, computed over the bucket's retained sample window (the
// most recent MAX_SAMPLES recorded attempts -- see MAX_SAMPLES above). The
// previous implementation used floor(p/100 * n) capped at the last index,
// which for even-sized samples reported the UPPER element as the median
// (n=2, p50 -> sorted[1]) instead of the nearest-rank lower one. `avg` is the
// arithmetic mean over the same window -- the dashboard's "average latency"
// used to show p50 mislabeled as an average.
function percentiles(arr) {
  if (!arr.length) return { p50: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p) => Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return {
    p50: sorted[idx(50)],
    p95: sorted[idx(95)],
    p99: sorted[idx(99)],
    avg: Math.round(avg * 100) / 100,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

// ─── Recording ────────────────────────────────────────────────────────────────

// STABILITY: every numeric field consumed by the record* functions below is
// clamped to a finite, non-negative number before it reaches an accumulator.
// A NaN anywhere in this path is permanently sticky (NaN + x = NaN): one bad
// upstream usage payload would silently poison that provider/model's spend
// and latency counters forever, and Postgres DOUBLE PRECISION happily stores
// NaN the same way. The values originate from parsed upstream JSON, so this
// is defensive input validation at the trust boundary, not paranoia.
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);

function bumpMem(bucket, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  if (usage) usage = { input: num(usage.input), output: num(usage.output), cache_read: num(usage.cache_read), cache_write: num(usage.cache_write), reasoning: num(usage.reasoning) };
  if (estimatedCost != null) estimatedCost = num(estimatedCost);
  if (latencyMs != null) latencyMs = num(latencyMs);
  if (ttftMs != null) ttftMs = num(ttftMs);
  bucket.counters.requests = (bucket.counters.requests || 0) + 1;
  if (status >= 200 && status < 300) bucket.counters.requests2xx = (bucket.counters.requests2xx || 0) + 1;
  else if (status >= 400 && status < 500) bucket.counters.requests4xx = (bucket.counters.requests4xx || 0) + 1;
  else if (status >= 500) bucket.counters.requests5xx = (bucket.counters.requests5xx || 0) + 1;
  bucket.status[status] = (bucket.status[status] || 0) + 1;
  if (isFallback) bucket.counters.fallbacks = (bucket.counters.fallbacks || 0) + 1;
  if (usage) {
    bucket.counters.tokensInput = (bucket.counters.tokensInput || 0) + (usage.input || 0);
    bucket.counters.tokensOutput = (bucket.counters.tokensOutput || 0) + (usage.output || 0);
    bucket.counters.tokensCacheRead = (bucket.counters.tokensCacheRead || 0) + (usage.cache_read || 0);
    bucket.counters.tokensCacheWrite = (bucket.counters.tokensCacheWrite || 0) + (usage.cache_write || 0);
    bucket.counters.tokensReasoning = (bucket.counters.tokensReasoning || 0) + (usage.reasoning || 0);
  }
  if (estimatedCost != null) bucket.counters.estimatedSpend = (bucket.counters.estimatedSpend || 0) + estimatedCost;
  if (latencyMs != null) { bucket.lat.push(latencyMs); if (bucket.lat.length > MAX_SAMPLES) bucket.lat.shift(); }
  if (ttftMs != null) { bucket.ttft.push(ttftMs); if (bucket.ttft.length > MAX_SAMPLES) bucket.ttft.shift(); }
}

function recordRequestMem(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  bumpMem(memBucket("global:_"), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  bumpMem(memBucket(`provider:${provider}`), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  bumpMem(memBucket(`model:${model}`), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  if (!mem.sets.has("providers")) mem.sets.set("providers", new Set());
  if (!mem.sets.has("models")) mem.sets.set("models", new Set());
  mem.sets.get("providers").add(provider);
  mem.sets.get("models").add(model);
}

// ─── Micro-batched DB writes (concurrency scaling) ────────────────────────────
//
// Under high load the previous per-event write path cost up to 6 database
// round-trips PER REQUEST (3 bucket upserts + 3 daily upserts, plus 2 lease
// writes) -- at a thousand concurrent requests that is thousands of Neon HTTP
// calls per second, which throttles the database, opens the DB health
// circuit, and degrades every metric to the per-instance in-memory fallback.
//
// The batcher coalesces those writes: record* functions now MERGE their event
// into per-(scope,name) accumulators (a synchronous Map update -- zero
// hot-path DB cost), and a flush writes ONE statement per touched bucket
// every METRICS_FLUSH_MS. 1000 rps across 10 providers/30 models becomes
// ~40 statements per 200ms window instead of ~6000 single-row writes.
//
// Durability is preserved by the caller: server.js registers
// flushPendingWrites() with the request's waitUntil, so the serverless
// runtime stays alive until the window containing that request's events has
// been persisted. On long-lived processes a 1s safety interval covers any
// straggler events. If a flush fails, the whole window drains into the
// in-memory fallback (same fail-open discipline as everything else here).

const METRICS_FLUSH_MS = Math.max(50, Number(process.env.METRICS_FLUSH_MS || 200));
const pendingBuckets = new Map(); // "scope|name"      -> merged delta
const pendingDaily = new Map();   // "day|scope|name"   -> merged delta
const pendingLeases = new Map();  // leaseId -> { id, kind, expiresAtMs, ended }
const pendingLeaseDeletes = new Set();

function newDelta() {
  return { requests: 0, r2xx: 0, r4xx: 0, r5xx: 0, upstreamErrors: 0, fallbacks: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 }, spend: 0, statuses: {}, lat: [], ttft: [] };
}

// Merges event delta b into accumulator a. Every numeric field passes the
// same num() clamp as bumpMem below -- a NaN in one event must not poison
// the merged accumulator.
function mergeDelta(a, b) {
  a.requests += b.requests;
  a.r2xx += b.r2xx;
  a.r4xx += b.r4xx;
  a.r5xx += b.r5xx;
  a.upstreamErrors += b.upstreamErrors;
  a.fallbacks += b.fallbacks;
  for (const k of ["input", "output", "cache_read", "cache_write", "reasoning"]) a.tokens[k] += b.tokens[k];
  a.spend += b.spend;
  for (const [code, n] of Object.entries(b.statuses)) a.statuses[code] = (a.statuses[code] || 0) + n;
  for (const v of b.lat) a.lat.push(v);
  for (const v of b.ttft) a.ttft.push(v);
}

function requestDelta(status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  const d = newDelta();
  d.requests = 1;
  if (status >= 200 && status < 300) d.r2xx = 1;
  else if (status >= 400 && status < 500) d.r4xx = 1;
  else if (status >= 500) d.r5xx = 1;
  d.statuses[String(status)] = 1;
  if (isFallback) d.fallbacks = 1;
  if (usage) {
    d.tokens.input = num(usage.input);
    d.tokens.output = num(usage.output);
    d.tokens.cache_read = num(usage.cache_read);
    d.tokens.cache_write = num(usage.cache_write);
    d.tokens.reasoning = num(usage.reasoning);
  }
  if (estimatedCost != null) d.spend = num(estimatedCost);
  if (latencyMs != null) d.lat.push(num(latencyMs));
  if (ttftMs != null) d.ttft.push(num(ttftMs));
  return d;
}

function upstreamErrorDelta() {
  const d = newDelta();
  d.upstreamErrors = 1;
  return d;
}

function enqueueBucketDelta(scope, name, d) {
  const key = `${scope}|${name}`;
  const cur = pendingBuckets.get(key);
  if (cur) mergeDelta(cur, d);
  else pendingBuckets.set(key, d);
}

function enqueueDailyDelta(day, scope, name, d) {
  const key = `${day}|${scope}|${name}`;
  const cur = pendingDaily.get(key);
  if (cur) mergeDelta(cur, d);
  else pendingDaily.set(key, d);
}

// ONE parameterized statement per bucket per flush: summed counters, the
// dynamic status-code chain, and lat/ttft sample appends (trimmed to
// MAX_SAMPLES). Built as a pure {text, params} pair (no driver call) so the
// exact SQL is unit-testable against a real Postgres; performFlush executes
// it via the Neon driver. Every value travels as a bound parameter.
//
// NOTE (found by the real-Postgres verification): BOTH branches matter. The
// INSERT VALUES branch serves a bucket's very first flush -- its statuses
// and samples must be complete there too, not only in the ON CONFLICT
// branch. lat/ttft are sliced in JS to MAX_SAMPLES for the insert branch;
// the conflict branch slices in SQL because it must trim old + new together.
export function buildBucketFlushStatement(scope, name, acc) {
  const latSamples = acc.lat.slice(-MAX_SAMPLES);
  const ttftSamples = acc.ttft.slice(-MAX_SAMPLES);
  const params = [
    scope, name,
    acc.requests, acc.r2xx, acc.r4xx, acc.r5xx, acc.upstreamErrors, acc.fallbacks,
    acc.tokens.input, acc.tokens.output, acc.tokens.cache_read, acc.tokens.cache_write, acc.tokens.reasoning,
    acc.spend, latSamples, ttftSamples,
  ];
  // INSERT-branch status_breakdown: the merged window statuses as one jsonb.
  let sbInsertExpr = "'{}'::jsonb";
  if (Object.keys(acc.statuses).length) {
    const args = [];
    for (const [code, count] of Object.entries(acc.statuses)) {
      args.push(`$${params.push(code)}::text`, `$${params.push(count)}::bigint`);
    }
    sbInsertExpr = `jsonb_build_object(${args.join(", ")})`;
  }
  // ON CONFLICT-branch status chain over the existing row's jsonb.
  let sbExpr = "gw_metrics_buckets.status_breakdown";
  for (const [code, count] of Object.entries(acc.statuses)) {
    const pCode = params.push(String(code));
    const pCount = params.push(count);
    sbExpr = `jsonb_set(${sbExpr}, ARRAY[$${pCode}::text], to_jsonb(COALESCE((${sbExpr} ->> $${pCode}::text)::bigint, 0) + $${pCount}::bigint))`;
  }
  const text = `
    INSERT INTO gw_metrics_buckets (
      scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
      upstream_errors, fallbacks, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_write, tokens_reasoning,
      estimated_spend, status_breakdown, lat, ttft
    ) VALUES (
      $1::text, $2::text, $3::bigint, $4::bigint, $5::bigint, $6::bigint,
      $7::bigint, $8::bigint, $9::bigint, $10::bigint,
      $11::bigint, $12::bigint, $13::bigint,
      $14::double precision, ${sbInsertExpr}, $15::double precision[], $16::double precision[]
    )
    ON CONFLICT (scope, name) DO UPDATE SET
      requests = gw_metrics_buckets.requests + EXCLUDED.requests,
      requests_2xx = gw_metrics_buckets.requests_2xx + EXCLUDED.requests_2xx,
      requests_4xx = gw_metrics_buckets.requests_4xx + EXCLUDED.requests_4xx,
      requests_5xx = gw_metrics_buckets.requests_5xx + EXCLUDED.requests_5xx,
      upstream_errors = gw_metrics_buckets.upstream_errors + EXCLUDED.upstream_errors,
      fallbacks = gw_metrics_buckets.fallbacks + EXCLUDED.fallbacks,
      tokens_input = gw_metrics_buckets.tokens_input + EXCLUDED.tokens_input,
      tokens_output = gw_metrics_buckets.tokens_output + EXCLUDED.tokens_output,
      tokens_cache_read = gw_metrics_buckets.tokens_cache_read + EXCLUDED.tokens_cache_read,
      tokens_cache_write = gw_metrics_buckets.tokens_cache_write + EXCLUDED.tokens_cache_write,
      tokens_reasoning = gw_metrics_buckets.tokens_reasoning + EXCLUDED.tokens_reasoning,
      estimated_spend = gw_metrics_buckets.estimated_spend + EXCLUDED.estimated_spend,
      status_breakdown = ${sbExpr},
      lat = CASE WHEN cardinality($15::double precision[]) > 0 THEN
        (gw_metrics_buckets.lat || $15::double precision[])[
          greatest(1, cardinality(gw_metrics_buckets.lat || $15::double precision[]) - ${MAX_SAMPLES - 1}):
        ]
        ELSE gw_metrics_buckets.lat END,
      ttft = CASE WHEN cardinality($16::double precision[]) > 0 THEN
        (gw_metrics_buckets.ttft || $16::double precision[])[
          greatest(1, cardinality(gw_metrics_buckets.ttft || $16::double precision[]) - ${MAX_SAMPLES - 1}):
        ]
        ELSE gw_metrics_buckets.ttft END
  `;
  return { text, params };
}

export function buildDailyFlushStatement(day, scope, name, acc) {
  const params = [
    day, scope, name,
    acc.requests, acc.r2xx, acc.r4xx, acc.r5xx, acc.upstreamErrors, acc.fallbacks,
    acc.tokens.input, acc.tokens.output, acc.tokens.cache_read, acc.tokens.cache_write, acc.tokens.reasoning,
    acc.spend,
  ];
  // INSERT-branch statuses (a brand-new day/bucket row must carry them too).
  let sbInsertExpr = "'{}'::jsonb";
  if (Object.keys(acc.statuses).length) {
    const args = [];
    for (const [code, count] of Object.entries(acc.statuses)) {
      args.push(`$${params.push(code)}::text`, `$${params.push(count)}::bigint`);
    }
    sbInsertExpr = `jsonb_build_object(${args.join(", ")})`;
  }
  let sbExpr = "gw_metrics_daily.status_breakdown";
  for (const [code, count] of Object.entries(acc.statuses)) {
    const pCode = params.push(String(code));
    const pCount = params.push(count);
    sbExpr = `jsonb_set(${sbExpr}, ARRAY[$${pCode}::text], to_jsonb(COALESCE((${sbExpr} ->> $${pCode}::text)::bigint, 0) + $${pCount}::bigint))`;
  }
  const text = `
    INSERT INTO gw_metrics_daily (
      day, scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
      upstream_errors, fallbacks, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_write, tokens_reasoning, estimated_spend, status_breakdown
    ) VALUES (
      $1::date, $2::text, $3::text, $4::bigint, $5::bigint, $6::bigint, $7::bigint,
      $8::bigint, $9::bigint, $10::bigint, $11::bigint,
      $12::bigint, $13::bigint, $14::bigint, $15::double precision, ${sbInsertExpr}
    )
    ON CONFLICT (day, scope, name) DO UPDATE SET
      requests = gw_metrics_daily.requests + EXCLUDED.requests,
      requests_2xx = gw_metrics_daily.requests_2xx + EXCLUDED.requests_2xx,
      requests_4xx = gw_metrics_daily.requests_4xx + EXCLUDED.requests_4xx,
      requests_5xx = gw_metrics_daily.requests_5xx + EXCLUDED.requests_5xx,
      upstream_errors = gw_metrics_daily.upstream_errors + EXCLUDED.upstream_errors,
      fallbacks = gw_metrics_daily.fallbacks + EXCLUDED.fallbacks,
      tokens_input = gw_metrics_daily.tokens_input + EXCLUDED.tokens_input,
      tokens_output = gw_metrics_daily.tokens_output + EXCLUDED.tokens_output,
      tokens_cache_read = gw_metrics_daily.tokens_cache_read + EXCLUDED.tokens_cache_read,
      tokens_cache_write = gw_metrics_daily.tokens_cache_write + EXCLUDED.tokens_cache_write,
      tokens_reasoning = gw_metrics_daily.tokens_reasoning + EXCLUDED.tokens_reasoning,
      estimated_spend = gw_metrics_daily.estimated_spend + EXCLUDED.estimated_spend,
      status_breakdown = ${sbExpr}
  `;
  return { text, params };
}

export function buildLeaseFlushStatements(upserts, deletes) {
  const statements = [];
  const live = upserts.filter((l) => !l.ended);
  if (live.length) {
    // Multi-row insert via unnest: one round-trip for the whole window's
    // lease begins. "ended" leases are already excluded -- an end that
    // arrived before its begin was flushed simply cancels it.
    statements.push({
      text: `INSERT INTO gw_active_leases (id, kind, expires_at_ms)
       SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[])
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, expires_at_ms = EXCLUDED.expires_at_ms`,
      params: [live.map((l) => l.id), live.map((l) => l.kind), live.map((l) => l.expiresAtMs)],
    });
  }
  if (deletes.length) {
    statements.push({
      text: `DELETE FROM gw_active_leases WHERE id = ANY($1::text[])`,
      params: [deletes],
    });
  }
  return statements;
}

// Applies an unflushable delta to the in-memory fallback so a failed flush
// degrades to per-instance visibility instead of vanishing.
function drainBucketDeltaToMem(scope, name, acc) {
  const b = memBucket(scope === "global" ? "global:_" : `${scope}:${name}`);
  const c = b.counters;
  c.requests = (c.requests || 0) + acc.requests;
  c.requests2xx = (c.requests2xx || 0) + acc.r2xx;
  c.requests4xx = (c.requests4xx || 0) + acc.r4xx;
  c.requests5xx = (c.requests5xx || 0) + acc.r5xx;
  c.upstreamErrors = (c.upstreamErrors || 0) + acc.upstreamErrors;
  c.fallbacks = (c.fallbacks || 0) + acc.fallbacks;
  c.tokensInput = (c.tokensInput || 0) + acc.tokens.input;
  c.tokensOutput = (c.tokensOutput || 0) + acc.tokens.output;
  c.tokensCacheRead = (c.tokensCacheRead || 0) + acc.tokens.cache_read;
  c.tokensCacheWrite = (c.tokensCacheWrite || 0) + acc.tokens.cache_write;
  c.tokensReasoning = (c.tokensReasoning || 0) + acc.tokens.reasoning;
  c.estimatedSpend = (c.estimatedSpend || 0) + acc.spend;
  for (const [code, n] of Object.entries(acc.statuses)) b.status[code] = (b.status[code] || 0) + n;
  for (const v of acc.lat) { b.lat.push(v); if (b.lat.length > MAX_SAMPLES) b.lat.shift(); }
  for (const v of acc.ttft) { b.ttft.push(v); if (b.ttft.length > MAX_SAMPLES) b.ttft.shift(); }
  if (scope === "provider") { if (!mem.sets.has("providers")) mem.sets.set("providers", new Set()); mem.sets.get("providers").add(name); }
  if (scope === "model") { if (!mem.sets.has("models")) mem.sets.set("models", new Set()); mem.sets.get("models").add(name); }
}

function drainDailyDeltaToMem(day, scope, name, acc) {
  const b = memDailyBucket(day, scope, name);
  b.requests += acc.requests;
  b.requests2xx += acc.r2xx;
  b.requests4xx += acc.r4xx;
  b.requests5xx += acc.r5xx;
  b.upstreamErrors += acc.upstreamErrors;
  b.fallbacks += acc.fallbacks;
  b.tokensInput += acc.tokens.input;
  b.tokensOutput += acc.tokens.output;
  b.tokensCacheRead += acc.tokens.cache_read;
  b.tokensCacheWrite += acc.tokens.cache_write;
  b.tokensReasoning += acc.tokens.reasoning;
  b.estimatedSpend += acc.spend;
}

let flushChainTail = Promise.resolve();
let flushInFlight = false;

// Writes every pending accumulator to the database. One flush = one
// statement per touched (scope,name) bucket, one per touched daily row, and
// at most one lease upsert + one lease delete statement -- all in parallel.
async function performFlush() {
  if (pendingBuckets.size === 0 && pendingDaily.size === 0 && pendingLeases.size === 0 && pendingLeaseDeletes.size === 0) return;
  if (!dbUsable()) {
    // DB health circuit is open: these events cannot reach the database
    // right now, so degrade the whole window to the in-memory fallback
    // instead of stranding it until the next flush after recovery.
    for (const [key, acc] of pendingBuckets) {
      const [scope, name] = key.split("|");
      drainBucketDeltaToMem(scope, name, acc);
    }
    for (const [key, acc] of pendingDaily) {
      const [day, scope, name] = key.split("|");
      drainDailyDeltaToMem(day, scope, name, acc);
    }
    for (const l of pendingLeases.values()) if (!l.ended) memLeaseBucket(l.kind).set(l.id, l.expiresAtMs);
    for (const id of pendingLeaseDeletes) for (const ids of memLeases.values()) ids.delete(id);
    pendingBuckets.clear();
    pendingDaily.clear();
    pendingLeases.clear();
    pendingLeaseDeletes.clear();
    return;
  }
  const buckets = [...pendingBuckets.entries()];
  const daily = [...pendingDaily.entries()];
  const leaseUpserts = [...pendingLeases.values()];
  const leaseDeletes = [...pendingLeaseDeletes];
  pendingBuckets.clear();
  pendingDaily.clear();
  pendingLeases.clear();
  pendingLeaseDeletes.clear();
  try {
    await ensureSchema();
    await Promise.all([
      ...buckets.map(([key, acc]) => {
        const [scope, name] = key.split("|");
        const stmt = buildBucketFlushStatement(scope, name, acc);
        return sql.query(stmt.text, stmt.params);
      }),
      ...daily.map(([key, acc]) => {
        const [day, scope, name] = key.split("|");
        const stmt = buildDailyFlushStatement(day, scope, name, acc);
        return sql.query(stmt.text, stmt.params);
      }),
      ...buildLeaseFlushStatements(leaseUpserts, leaseDeletes).map((stmt) => sql.query(stmt.text, stmt.params)),
    ]);
  } catch (error) {
    recordDbFailure(error);
    // Degrade this whole window to the in-memory fallback rather than lose
    // it: the same events the DB missed remain visible on this instance.
    for (const [key, acc] of buckets) {
      const [scope, name] = key.split("|");
      drainBucketDeltaToMem(scope, name, acc);
    }
    for (const [key, acc] of daily) {
      const [day, scope, name] = key.split("|");
      drainDailyDeltaToMem(day, scope, name, acc);
    }
    for (const l of leaseUpserts) if (!l.ended) memLeaseBucket(l.kind).set(l.id, l.expiresAtMs);
    for (const id of leaseDeletes) for (const ids of memLeases.values()) ids.delete(id);
  }
}

// Resolves after a flush that is guaranteed to include everything enqueued
// BEFORE this call. Callers register this with the request's waitUntil so
// deferred metric writes actually persist on serverless (a plain
// fire-and-forget enqueue would be frozen away with the invocation).
export function flushPendingWrites() {
  if (flushInFlight) {
    // A flush is running; its snapshot may already exclude newer events, so
    // chain one more flush (a no-op when nothing arrived meanwhile).
    flushInFlight = false;
    const run = flushChainTail.then(() => performFlush());
    flushChainTail = run.then(() => {}, () => {});
    return run;
  }
  flushInFlight = true;
  const run = flushChainTail.then(() => performFlush()).finally(() => { flushInFlight = false; });
  flushChainTail = run.then(() => {}, () => {});
  return run;
}

// Safety net for events enqueued outside a request lifecycle (local dev,
// tests, CLI usage): flush about once a second while anything is pending.
// unref'd so it never keeps a process or serverless invocation alive.
setInterval(() => { if (pendingBuckets.size || pendingDaily.size || pendingLeases.size || pendingLeaseDeletes.size) void flushPendingWrites(); }, Math.max(200, METRICS_FLUSH_MS)).unref?.();

export function recordRequest(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  provider = provider || "unknown";
  model = model || "unknown";

  if (!dbUsable()) {
    recordRequestMem(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    return;
  }

  // DB mode: synchronous merge into the batch accumulators -- zero DB
  // round-trips on the hot path. The caller registers flushPendingWrites()
  // (server.js does this once per request) for durability.
  const d = requestDelta(status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  enqueueBucketDelta("global", "_", d);
  enqueueBucketDelta("provider", provider, d);
  enqueueBucketDelta("model", model, d);
  const day = localDay();
  enqueueDailyDelta(day, "global", "_", d);
  enqueueDailyDelta(day, "provider", provider, d);
  enqueueDailyDelta(day, "model", model, d);
}

function recordUpstreamErrorMem(provider, model) {
  const pb = memBucket(`provider:${provider}`);
  pb.counters.upstreamErrors = (pb.counters.upstreamErrors || 0) + 1;
  const gb = memBucket("global:_");
  gb.counters.upstreamErrors = (gb.counters.upstreamErrors || 0) + 1;
  if (model) {
    const mb = memBucket(`model:${model}`);
    mb.counters.upstreamErrors = (mb.counters.upstreamErrors || 0) + 1;
  }
}

export function recordUpstreamError(provider, model) {
  provider = provider || "unknown";

  if (!dbUsable()) {
    recordUpstreamErrorMem(provider, model);
    const day = localDay();
    memDailyBucket(day, "global", "_").upstreamErrors += 1;
    memDailyBucket(day, "provider", provider).upstreamErrors += 1;
    if (model) memDailyBucket(day, "model", model).upstreamErrors += 1;
    return;
  }

  const d = upstreamErrorDelta();
  enqueueBucketDelta("global", "_", d);
  enqueueBucketDelta("provider", provider, d);
  if (model) enqueueBucketDelta("model", model, d);
  const day = localDay();
  enqueueDailyDelta(day, "global", "_", d);
  enqueueDailyDelta(day, "provider", provider, d);
  if (model) enqueueDailyDelta(day, "model", model, d);
}

// ─── Per-day history (added 2026-09-10) ─────────────────────────────────────────
// Day key in Nigeria local time (owner request 2026-09-10: each day's
// history should start at 12am Nigeria time, not UTC midnight).
// Africa/Lagos (WAT) is fixed UTC+1 with no DST -- now or ever -- so
// shifting the UTC timestamp by +1h yields the exact Nigeria-local
// calendar day: a new day's bucket starts at 12am Lagos (23:00 UTC).
// Stable regardless of instance region, and still a plain DATE-shaped
// string for the Postgres column.
export function localDay() {
  return new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
}

function memDailyBucket(day, scope, name) {
  const key = `${day}|${scope}|${name}`;
  let b = mem.daily.get(key);
  if (!b) {
    b = { requests: 0, requests2xx: 0, requests4xx: 0, requests5xx: 0, upstreamErrors: 0, fallbacks: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, estimatedSpend: 0 };
    mem.daily.set(key, b);
  }
  return b;
}

function bumpDailyMem(scope, name, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  const b = memDailyBucket(localDay(), scope, name);
  b.requests += 1;
  if (status >= 200 && status < 300) b.requests2xx += 1;
  else if (status >= 400 && status < 500) b.requests4xx += 1;
  else if (status >= 500) b.requests5xx += 1;
  if (isFallback) b.fallbacks += 1;
  if (usage) {
    b.tokensInput += num(usage.input);
    b.tokensOutput += num(usage.output);
    b.tokensCacheRead += num(usage.cache_read);
    b.tokensCacheWrite += num(usage.cache_write);
    b.tokensReasoning += num(usage.reasoning);
  }
  b.estimatedSpend += estimatedCost != null ? num(estimatedCost) : 0;
}

// ─── Gauges (activeRequests / activeStreams) ─────────────────────────────────

export async function incrGauge(name, delta) {
  if (!dbUsable()) {
    mem.gauges.set(name, (mem.gauges.get(name) || 0) + delta);
    return;
  }
  try {
    await ensureSchema();
    await sql`
      INSERT INTO gw_metrics_gauges (name, value) VALUES (${name}, ${delta})
      ON CONFLICT (name) DO UPDATE SET value = gw_metrics_gauges.value + EXCLUDED.value
    `;
  } catch (error) {
    recordDbFailure(error);
    mem.gauges.set(name, (mem.gauges.get(name) || 0) + delta);
  }
}

export async function getGauge(name) {
  if (!dbUsable()) return Math.max(0, mem.gauges.get(name) || 0);
  try {
    await ensureSchema();
    const rows = await sql`SELECT value FROM gw_metrics_gauges WHERE name = ${name}`;
    return Math.max(0, Number(rows[0]?.value) || 0);
  } catch (error) {
    recordDbFailure(error);
    return Math.max(0, mem.gauges.get(name) || 0);
  }
}

// ─── Active-request leases (self-healing "in-flight" counts) ─────────────────
//
// The old activeRequests/activeStreams gauges were +/- counters in
// gw_metrics_gauges, incremented at the start of an upstream attempt and
// decremented in a `finally` block. Both writes are fire-and-forget across
// independent serverless instances, so ANY dropped decrement (a transient DB
// error landing on the in-memory fallback while later reads hit the DB, a
// lambda frozen right after res.end(), a mid-request crash) leaked +1 into
// the gauge FOREVER. Production drifted to "activeRequests: 1124" with ~39
// minutes of uptime -- the number was meaningless.
//
// A counter cannot self-heal; a LEASE can. Each attempt now inserts a
// short-TTL row keyed by a per-attempt id and deletes it on completion, and
// reads COUNT the unexpired rows. A dropped delete only leaves one row until
// its TTL passes -- the count converges back to the real in-flight work
// without any operator intervention. TTL must exceed the longest possible
// request (Vercel maxDuration is 300s; route timeoutMs can reach it) so a
// still-running request's lease never lapses mid-flight.
// TTL floor of 1s guards against footgun configs (0/negative would expire
// every lease instantly and report 0 active forever); read lazily so tests
// (and operators) can tune it without a redeploy.
const activeLeaseTtlMs = () => Math.max(1_000, Number(process.env.ACTIVE_LEASE_TTL_MS || 360_000));
const memLeases = new Map(); // kind -> Map(id -> expiresAtMs)

function memLeaseBucket(kind) {
  if (!memLeases.has(kind)) memLeases.set(kind, new Map());
  return memLeases.get(kind);
}
function sweepMemLeases(now) {
  for (const [kind, ids] of memLeases) {
    for (const [id, exp] of ids) if (exp <= now) ids.delete(id);
    if (!ids.size) memLeases.delete(kind);
  }
}

export async function beginActiveLease(kind, id) {
  id = String(id);
  if (!dbUsable()) {
    memLeaseBucket(kind).set(id, Date.now() + activeLeaseTtlMs());
    return;
  }
  // Batched: the lease is merged into the pending set (a synchronous Map
  // update) and written with one multi-row statement per flush window.
  pendingLeases.set(id, { id, kind, expiresAtMs: Date.now() + activeLeaseTtlMs(), ended: false });
}

// The caller MUST call end after its begin promise settles (see server.js's
// chained defer). An end that lands while the begin is still pending marks it
// ended, so the window's flush never even inserts that lease -- the DELETE
// racing the INSERT problem disappears entirely in the batched form.
export async function endActiveLease(kind, id) {
  id = String(id);
  const pending = pendingLeases.get(id);
  if (pending) {
    pending.ended = true;
    return;
  }
  if (!dbUsable()) {
    memLeaseBucket(kind).delete(id);
    return;
  }
  pendingLeaseDeletes.add(id);
  // Drop any stale local-overlay entry so fail-open reads agree immediately.
  for (const ids of memLeases.values()) ids.delete(id);
}

export async function countActiveLeases(kind) {
  const now = Date.now();
  if (!dbUsable()) {
    sweepMemLeases(now);
    let n = 0;
    for (const exp of memLeaseBucket(kind).values()) if (exp > now) n += 1;
    return n;
  }
  try {
    await ensureSchema();
    // Opportunistic TTL eviction: expired leases are garbage, and deleting
    // them here keeps the table at roughly the size of the real in-flight set.
    await sql`DELETE FROM gw_active_leases WHERE expires_at_ms <= ${now}`;
    const rows = await sql`SELECT count(*)::int AS n FROM gw_active_leases WHERE kind = ${kind} AND expires_at_ms > ${now}`;
    let n = Math.max(0, Number(rows[0]?.n) || 0);
    // Include leases queued for insert but not yet flushed (ids are unique
    // per attempt, so these cannot double-count rows already in the table)
    // so a brand-new attempt is visible within the same flush window.
    for (const l of pendingLeases.values()) {
      if (l.kind === kind && !l.ended && l.expiresAtMs > now) n += 1;
    }
    return n;
  } catch (error) {
    recordDbFailure(error);
    sweepMemLeases(now);
    let n = 0;
    for (const exp of memLeaseBucket(kind).values()) if (exp > now) n += 1;
    // A flush failure may have left the window's leases queued (they drain
    // to the mem overlay only on the flush path) -- count the live ones.
    for (const l of pendingLeases.values()) {
      if (l.kind === kind && !l.ended && l.expiresAtMs > now) n += 1;
    }
    return n;
  }
}

// ─── Circuit breakers (shared across instances) ──────────────────────────────

const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30000;
// Exported for the 503 Retry-After hint in server.js so the two can't drift.
export { CB_THRESHOLD, CB_COOLDOWN_MS };

function defaultCircuitBreaker() {
  return { state: "closed", failures: 0, openedAt: null, threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS };
}

function cbMemKey(provider, model) {
  // Normalized so the in-memory overlay (no-DB mode and fail-open fallbacks)
  // uses the same "model:<id>" keys the DB path reports -- otherwise the two
  // paths disagreed and consumers parsing the key after "model:" (the
  // dashboard's provider-health lookup) failed for ids containing ":".
  return circuitBreakerKey(provider, model);
}

export async function getCircuitBreaker(provider, model) {
  const key = cbMemKey(provider, model);
  // Fast path: trust a within-cooldown snapshot written by THIS instance's
  // recordBreaker* calls (see setCircuitState). This is what lets server.js
  // fire-and-forget the durable DB write on the request hot path without the
  // circuit breaker going blind -- in-instance state stays synchronous and
  // correct, while the DB write still propagates it to other instances. On a
  // cold start (no local snapshot) or once a snapshot ages past the cooldown
  // window we fall through to the DB so cross-instance state (e.g. another
  // instance having tripped this breaker) is still picked up.
  const local = mem.cbs.get(key);
  if (local && Date.now() - (local.updatedAt || 0) < CB_COOLDOWN_MS) return { ...local };
  if (!dbUsable()) {
    if (!mem.cbs.has(key)) mem.cbs.set(key, { ...defaultCircuitBreaker(), updatedAt: Date.now() });
    return { ...mem.cbs.get(key) };
  }
  try {
    await ensureSchema();
    const rows = await sql`
      SELECT state, failures, opened_at FROM gw_circuit_breakers
      WHERE provider = ${provider || "unknown"} AND model = ${model || "unknown"}
    `;
    const raw = rows[0];
    if (!raw) return defaultCircuitBreaker();
    return {
      state: raw.state,
      failures: Number(raw.failures) || 0,
      openedAt: raw.opened_at ? Number(raw.opened_at) : null,
      threshold: CB_THRESHOLD,
      cooldownMs: CB_COOLDOWN_MS,
    };
  } catch (error) {
    recordDbFailure(error);
    // Fail open: an unreachable circuit-breaker store must never be
    // treated as an OPEN circuit -- that would block a perfectly healthy
    // provider route just because our own metrics DB is struggling.
    if (!mem.cbs.has(key)) mem.cbs.set(key, { ...defaultCircuitBreaker(), updatedAt: Date.now() });
    return { ...mem.cbs.get(key) };
  }
}

// isCircuitOpen deliberately never throws (see the DB health circuit
// breaker note above) -- both of its call sites in server.js need a clean
// boolean, and one of them is a bare `await` outside any try/catch.
export async function isCircuitOpen(provider, model) {
  const cb = await getCircuitBreaker(provider, model);
  if (cb.state === "open") {
    if (Date.now() - (cb.openedAt || 0) >= cb.cooldownMs) {
      await setCircuitState(provider, model, "half_open", cb.failures, cb.openedAt);
      return false; // allow a probe
    }
    return true;
  }
  return false;
}

async function setCircuitState(provider, model, state, failures, openedAt) {
  const key = cbMemKey(provider, model);
  // Update the synchronous in-instance overlay FIRST so subsequent
  // isCircuitOpen()/getCircuitBreaker() calls on this warm instance see the
  // new state immediately, independent of whether/when the durable DB write
  // below lands (server.js fire-and-forgets it off the request hot path).
  mem.cbs.set(key, { state, failures, openedAt, updatedAt: Date.now(), threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS });
  if (!dbUsable()) return;
  try {
    await ensureSchema();
    await sql`
      INSERT INTO gw_circuit_breakers (provider, model, state, failures, opened_at)
      VALUES (${provider || "unknown"}, ${model || "unknown"}, ${state}, ${failures}, ${openedAt ?? null})
      ON CONFLICT (provider, model) DO UPDATE SET
        state = EXCLUDED.state, failures = EXCLUDED.failures, opened_at = EXCLUDED.opened_at
    `;
  } catch (error) {
    recordDbFailure(error);
    // Overlay was already updated above; nothing further to do on failure.
  }
}

function incrementLocalCircuitFailure(provider, model) {
  const key = cbMemKey(provider, model);
  const cb = mem.cbs.get(key) || defaultCircuitBreaker();
  const failures = cb.failures + 1;
  const shouldOpen = cb.state === "half_open" || (cb.state === "closed" && failures >= cb.threshold);
  const openedAt = shouldOpen ? Date.now() : cb.openedAt;
  const next = {
    state: shouldOpen ? "open" : cb.state,
    failures,
    openedAt,
    updatedAt: Date.now(),
    threshold: CB_THRESHOLD,
    cooldownMs: CB_COOLDOWN_MS,
  };
  mem.cbs.set(key, next);
  return { next, justOpened: shouldOpen && cb.state !== "open" };
}

async function incrementCircuitFailure(provider, model) {
  const key = cbMemKey(provider, model);
  if (!dbUsable()) return incrementLocalCircuitFailure(provider, model);

  const now = Date.now();
  try {
    await ensureSchema();
    const rows = await sql`
      INSERT INTO gw_circuit_breakers (provider, model, state, failures, opened_at)
      VALUES (${provider || "unknown"}, ${model || "unknown"}, 'closed', 1, null)
      ON CONFLICT (provider, model) DO UPDATE SET
        failures = gw_circuit_breakers.failures + 1,
        state = CASE
          WHEN gw_circuit_breakers.state = 'half_open'
            OR (gw_circuit_breakers.state = 'closed' AND gw_circuit_breakers.failures + 1 >= ${CB_THRESHOLD})
          THEN 'open'
          ELSE gw_circuit_breakers.state
        END,
        opened_at = CASE
          WHEN gw_circuit_breakers.state = 'half_open'
            OR (gw_circuit_breakers.state = 'closed' AND gw_circuit_breakers.failures + 1 >= ${CB_THRESHOLD})
          THEN ${now}
          ELSE gw_circuit_breakers.opened_at
        END
      RETURNING state, failures, opened_at
    `;
    const raw = rows[0];
    const next = {
      state: raw.state,
      failures: Number(raw.failures) || 0,
      openedAt: raw.opened_at ? Number(raw.opened_at) : null,
      updatedAt: Date.now(),
      threshold: CB_THRESHOLD,
      cooldownMs: CB_COOLDOWN_MS,
    };
    mem.cbs.set(key, next);
    return { next, justOpened: next.state === "open" && next.openedAt === now };
  } catch (error) {
    recordDbFailure(error);
    return incrementLocalCircuitFailure(provider, model);
  }
}

export async function recordBreakerFailure(provider, model) {
  const key = cbMemKey(provider, model);
  return withCircuitLock(key, async () => {
    const { next, justOpened } = await incrementCircuitFailure(provider, model);
    if (justOpened) console.error(JSON.stringify({ type: "circuit_opened", provider, model, failures: next.failures }));
  });
}

export async function recordBreakerSuccess(provider, model) {
  const key = cbMemKey(provider, model);
  return withCircuitLock(key, async () => {
    const cb = await getCircuitBreaker(provider, model);
    if (cb.state !== "closed" || cb.failures !== 0) {
      await setCircuitState(provider, model, "closed", 0, null);
      if (cb.state !== "closed") console.log(JSON.stringify({ type: "circuit_recovered", provider, model }));
    }
  });
}

// Display/API key for a breaker row. Since the per-model hardening, rows are
// written with provider="model:<id>" and model="<id>" (see server.js's
// cbProvider), which cbMemKey-style concatenation rendered as the redundant
// "model:<id>:<id>" -- and model ids that themselves contain ":" (e.g.
// "qwen3.8-flash:free") broke every consumer that split the key on ":".
// Collapse that redundant suffix so keys read "model:<id>"; pre-hardening
// "provider:model" rows keep their shape and gain identity:"legacy" so the
// dashboard can tell them apart.
export function circuitBreakerKey(provider, model) {
  if (typeof provider === "string" && provider.startsWith("model:") && model === provider.slice(6)) {
    return provider;
  }
  return `${provider || "unknown"}:${model || "unknown"}`;
}

export async function getAllCircuitBreakers() {
  if (!dbUsable()) {
    const out = {};
    for (const [key, cb] of mem.cbs.entries()) out[key] = cb;
    return out;
  }
  try {
    await ensureSchema();
    const rows = await sql`SELECT provider, model, state, failures, opened_at FROM gw_circuit_breakers`;
    const out = {};
    for (const raw of rows) {
      out[circuitBreakerKey(raw.provider, raw.model)] = {
        state: raw.state,
        failures: Number(raw.failures) || 0,
        openedAt: raw.opened_at ? Number(raw.opened_at) : null,
        identity: typeof raw.provider === "string" && raw.provider.startsWith("model:") ? "model" : "legacy",
      };
    }
    return out;
  } catch (error) {
    recordDbFailure(error);
    const out = {};
    for (const [key, cb] of mem.cbs.entries()) out[key] = cb;
    return out;
  }
}

// ─── Generic small TTL-keyed KV (shared with gemini-cache.js) ───────────────
// Same fail-open discipline as everything else here: never throws, falls
// back to a local in-memory Map on any DB error.

export async function kvGet(key) {
  const now = Date.now();
  if (!dbUsable()) {
    const entry = mem.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs != null && entry.expiresAtMs <= now) { mem.kv.delete(key); return null; }
    return entry.value;
  }
  try {
    await ensureSchema();
    const rows = await sql`SELECT value, expires_at_ms FROM gw_kv WHERE key = ${key}`;
    const raw = rows[0];
    if (!raw) return null;
    if (raw.expires_at_ms != null && Number(raw.expires_at_ms) <= now) return null;
    return raw.value;
  } catch (error) {
    recordDbFailure(error);
    const entry = mem.kv.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs != null && entry.expiresAtMs <= now) { mem.kv.delete(key); return null; }
    return entry.value;
  }
}

export async function kvSet(key, value, ttlSeconds) {
  const expiresAtMs = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
  if (!dbUsable()) {
    mem.kv.set(key, { value, expiresAtMs });
    return;
  }
  try {
    await ensureSchema();
    await sql`
      INSERT INTO gw_kv (key, value, expires_at_ms) VALUES (${key}, ${value}, ${expiresAtMs})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at_ms = EXCLUDED.expires_at_ms
    `;
  } catch (error) {
    recordDbFailure(error);
    mem.kv.set(key, { value, expiresAtMs });
  }
}

// ─── Snapshot for /metrics and /health ───────────────────────────────────────
// (Bucket reads happen inline in getMetricsSnapshot via one table scan; the
// former per-bucket readBucket() helper was retired with the N+1 queries.)

// CORRECTED 2026-08-18 (twice, back in the Redis-backed version): the
// caller (server.js) feeds this store an already-normalized usage object
// where tokensInput is TRUE uncached-only input for every protocol (see
// cacheBreakdownOf() in server.js) -- Anthropic's additive-vs-subset
// distinction is resolved BEFORE it reaches here, not re-derived at read
// time. Kept this formula and its defensive clamp unchanged across the
// 2026-08-27 Postgres migration.
function cacheHitRateOf(input, cacheRead, cacheWrite) {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? Number(Math.min(1, cacheRead / denom).toFixed(4)) : 0;
}

function serializeFromDb(row) {
  if (!row) {
    return {
      requests: 0, requests2xx: 0, requests4xx: 0, requests5xx: 0,
      upstreamErrors: 0, fallbacks: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cacheHitRate: 0 },
      estimatedSpend: 0, latency: percentiles([]), ttft: percentiles([]), statusBreakdown: {},
    };
  }
  const input = Number(row.tokens_input) || 0;
  const cacheRead = Number(row.tokens_cache_read) || 0;
  const cacheWrite = Number(row.tokens_cache_write) || 0;
  const output = Number(row.tokens_output) || 0;
  return {
    requests: Number(row.requests) || 0,
    requests2xx: Number(row.requests_2xx) || 0,
    requests4xx: Number(row.requests_4xx) || 0,
    requests5xx: Number(row.requests_5xx) || 0,
    upstreamErrors: Number(row.upstream_errors) || 0,
    fallbacks: Number(row.fallbacks) || 0,
    tokens: {
      input, output, cacheRead, cacheWrite,
      reasoning: Number(row.tokens_reasoning) || 0,
      // `input` is uncached-only after server.js normalization. Total prompt
      // tokens must include cache reads/writes, otherwise the headline
      // silently undercounts heavily cached traffic.
      total: input + cacheRead + cacheWrite + output,
      cacheHitRate: cacheHitRateOf(input, cacheRead, cacheWrite),
    },
    estimatedSpend: Number(Number(row.estimated_spend || 0).toFixed(6)),
    latency: percentiles((row.lat || []).map(Number)),
    ttft: percentiles((row.ttft || []).map(Number)),
    statusBreakdown: row.status_breakdown || {},
  };
}

function serializeFromMem(b) {
  const c = b.counters;
  const input = c.tokensInput || 0;
  const cacheRead = c.tokensCacheRead || 0;
  const cacheWrite = c.tokensCacheWrite || 0;
  return {
    requests: c.requests || 0,
    requests2xx: c.requests2xx || 0,
    requests4xx: c.requests4xx || 0,
    requests5xx: c.requests5xx || 0,
    upstreamErrors: c.upstreamErrors || 0,
    fallbacks: c.fallbacks || 0,
    tokens: {
      input, output: c.tokensOutput || 0, cacheRead, cacheWrite,
      reasoning: c.tokensReasoning || 0,
      total: input + cacheRead + cacheWrite + (c.tokensOutput || 0),
      cacheHitRate: cacheHitRateOf(input, cacheRead, cacheWrite),
    },
    estimatedSpend: Number((c.estimatedSpend || 0).toFixed(6)),
    latency: percentiles(b.lat),
    ttft: percentiles(b.ttft),
    statusBreakdown: b.status,
  };
}

export async function getMetricsSnapshot(knownProviders, knownModels, opts = {}) {
  // EFFICIENCY: this used to issue 2 DISTINCT-name queries and then one
  // SELECT per provider AND per model (2 + P + M round-trips per /metrics
  // call). One full read of gw_metrics_buckets yields every row the loop
  // needed -- the table holds one small row per (scope, name), so a single
  // scan is both fewer round-trips and less total work.
  let rows = null;
  if (dbUsable()) {
    try {
      await ensureSchema();
      rows = await sql`SELECT * FROM gw_metrics_buckets`;
    } catch (error) {
      recordDbFailure(error);
      rows = null;
    }
  }

  const globalRow = rows?.find((r) => r.scope === "global" && r.name === "_") || null;
  const global = globalRow ? serializeFromDb(globalRow) : serializeFromMem(memBucket("global:_"));

  let providerNames, modelNames;
  const providerPending = new Set();
  const modelPending = new Set();
  if (rows) {
    // Include providers/models that only exist in the not-yet-flushed batch
    // accumulators, so a brand-new provider's first request is visible in
    // the snapshot within the same window instead of after the flush.
    for (const key of pendingBuckets.keys()) {
      const [scope, name] = key.split("|");
      if (scope === "provider") providerPending.add(name);
      else if (scope === "model") modelPending.add(name);
    }
    providerNames = [...new Set([
      ...rows.filter((r) => r.scope === "provider").map((r) => r.name),
      ...providerPending,
      ...knownProviders,
    ])];
    modelNames = [...new Set([
      ...rows.filter((r) => r.scope === "model").map((r) => r.name),
      ...modelPending,
      ...knownModels,
    ])];
  } else {
    providerNames = [...new Set([...(mem.sets.get("providers") || []), ...knownProviders])];
    modelNames = [...new Set([...(mem.sets.get("models") || []), ...knownModels])];
  }

  const bucketFromDb = (scope, name) => {
    const row = rows?.find((r) => r.scope === scope && r.name === name);
    return row ? serializeFromDb(row) : serializeFromMem(memBucket(`${scope}:${name}`));
  };
  const byProvider = {};
  await Promise.all(providerNames.map(async (name) => { byProvider[name] = bucketFromDb("provider", name); }));
  const byModel = {};
  await Promise.all(modelNames.map(async (name) => { byModel[name] = bucketFromDb("model", name); }));

  const circuitBreakers = await getAllCircuitBreakers();

  // "Active" now means leases that are alive right now (see
  // beginActiveLease): genuinely in-flight upstream attempts / streams,
  // self-healing against dropped cleanup writes.
  const [activeRequests, activeStreams] = await Promise.all([
    countActiveLeases("requests"),
    countActiveLeases("streams"),
  ]);

  // Per-day history (added 2026-09-10). Unbounded retention -- every day
  // that ever had traffic stays queryable forever, so a full year (or
  // more) of daily trends is always available. Rows only exist for days
  // with traffic, so this stays small in practice. An optional
  // opts.dailyScope ("global"|"provider"|"model") trims the payload for
  // callers that only consume one scope (the built-in dashboard only ever
  // renders global rows); omitted keeps the historical all-scopes shape.
  const dailyScope = ["global", "provider", "model"].includes(opts.dailyScope) ? opts.dailyScope : null;
  let daily = null;
  if (!dbUsable()) {
    daily = [...mem.daily.entries()]
      .map(([key, b]) => {
        const [day, scope, name] = key.split("|");
        return {
          day, scope, name,
          requests: b.requests, requests2xx: b.requests2xx, requests4xx: b.requests4xx, requests5xx: b.requests5xx,
          upstreamErrors: b.upstreamErrors, fallbacks: b.fallbacks,
          tokens: { input: b.tokensInput, output: b.tokensOutput, cacheRead: b.tokensCacheRead, cacheWrite: b.tokensCacheWrite, reasoning: b.tokensReasoning },
          estimatedSpend: b.estimatedSpend,
        };
      })
      .filter((r) => !dailyScope || r.scope === dailyScope)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  } else {
    try {
      await ensureSchema();
      const rowsDaily = dailyScope
        ? await sql`
            SELECT day, scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
                   upstream_errors, fallbacks, tokens_input, tokens_output,
                   tokens_cache_read, tokens_cache_write, tokens_reasoning, estimated_spend
            FROM gw_metrics_daily WHERE scope = ${dailyScope}
            ORDER BY day ASC
          `
        : await sql`
            SELECT day, scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
                   upstream_errors, fallbacks, tokens_input, tokens_output,
                   tokens_cache_read, tokens_cache_write, tokens_reasoning, estimated_spend
            FROM gw_metrics_daily
            ORDER BY day ASC
          `;
      daily = rowsDaily.map((r) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        scope: r.scope, name: r.name,
        requests: Number(r.requests) || 0,
        requests2xx: Number(r.requests_2xx) || 0,
        requests4xx: Number(r.requests_4xx) || 0,
        requests5xx: Number(r.requests_5xx) || 0,
        upstreamErrors: Number(r.upstream_errors) || 0,
        fallbacks: Number(r.fallbacks) || 0,
        tokens: {
          input: Number(r.tokens_input) || 0,
          output: Number(r.tokens_output) || 0,
          cacheRead: Number(r.tokens_cache_read) || 0,
          cacheWrite: Number(r.tokens_cache_write) || 0,
          reasoning: Number(r.tokens_reasoning) || 0,
        },
        estimatedSpend: Number(r.estimated_spend) || 0,
      }));
    } catch (error) {
      recordDbFailure(error);
      daily = null;
    }
  }

  return {
    activeRequests,
    activeStreams,
    global,
    byProvider,
    byModel,
    circuitBreakers,
    daily,
    providers: providerNames,
    modelCount: modelNames.length,
    providerCount: providerNames.length,
  };
}

// Today's (WAT-day) recorded estimated spend for the global bucket. Read by
// the optional MAX_DAILY_SPEND_USD spend ceiling in server.js. Never throws:
// on any failure it reports what the in-memory fallback knows (usually 0),
// so a metrics-store outage degrades the ceiling to "disabled" instead of
// blocking traffic -- consistent with the fail-open discipline everywhere
// else in this file.
export async function getDailySpendUsd(day = localDay()) {
  if (!dbUsable()) {
    return mem.daily.get(`${day}|global|_`)?.estimatedSpend || 0;
  }
  try {
    await ensureSchema();
    const rows = await sql`
      SELECT estimated_spend FROM gw_metrics_daily
      WHERE day = ${day} AND scope = 'global' AND name = '_'
    `;
    return Number(rows[0]?.estimated_spend) || 0;
  } catch (error) {
    recordDbFailure(error);
    return mem.daily.get(`${day}|global|_`)?.estimatedSpend || 0;
  }
}
