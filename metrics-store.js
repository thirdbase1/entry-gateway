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

function percentiles(arr) {
  if (!arr.length) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p) => Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return {
    p50: sorted[idx(50)],
    p95: sorted[idx(95)],
    p99: sorted[idx(99)],
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

// Upserts one bucket row, incrementing counters atomically via
// ON CONFLICT ... DO UPDATE SET col = table.col + EXCLUDED.col. The
// status-code breakdown is a dynamic-key JSONB increment; lat/ttft are
// appended and trimmed to the last MAX_SAMPLES in the same statement.
async function upsertBucket(scope, name, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  const is2xx = status >= 200 && status < 300 ? 1 : 0;
  const is4xx = status >= 400 && status < 500 ? 1 : 0;
  const is5xx = status >= 500 ? 1 : 0;
  const statusStr = String(status);
  // Same finite/non-negative clamp as bumpMem -- see num()'s comment. These
  // values go straight into DOUBLE PRECISION columns where a NaN would be
  // stored permanently and poison every later aggregate read.
  const u = usage
    ? { input: num(usage.input), output: num(usage.output), cache_read: num(usage.cache_read), cache_write: num(usage.cache_write), reasoning: num(usage.reasoning) }
    : null;
  await sql`
    INSERT INTO gw_metrics_buckets (
      scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
      upstream_errors, fallbacks, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_write, tokens_reasoning,
      estimated_spend, status_breakdown, lat, ttft
    ) VALUES (
      ${scope}, ${name}, 1, ${is2xx}, ${is4xx}, ${is5xx},
      0, ${isFallback ? 1 : 0}, ${u?.input || 0}, ${u?.output || 0},
      ${u?.cache_read || 0}, ${u?.cache_write || 0}, ${u?.reasoning || 0},
      ${estimatedCost != null ? num(estimatedCost) : 0}, jsonb_build_object(${statusStr}::text, 1),
      ${latencyMs != null ? [num(latencyMs)] : []}, ${ttftMs != null ? [num(ttftMs)] : []}
    )
    ON CONFLICT (scope, name) DO UPDATE SET
      requests = gw_metrics_buckets.requests + EXCLUDED.requests,
      requests_2xx = gw_metrics_buckets.requests_2xx + EXCLUDED.requests_2xx,
      requests_4xx = gw_metrics_buckets.requests_4xx + EXCLUDED.requests_4xx,
      requests_5xx = gw_metrics_buckets.requests_5xx + EXCLUDED.requests_5xx,
      fallbacks = gw_metrics_buckets.fallbacks + EXCLUDED.fallbacks,
      tokens_input = gw_metrics_buckets.tokens_input + EXCLUDED.tokens_input,
      tokens_output = gw_metrics_buckets.tokens_output + EXCLUDED.tokens_output,
      tokens_cache_read = gw_metrics_buckets.tokens_cache_read + EXCLUDED.tokens_cache_read,
      tokens_cache_write = gw_metrics_buckets.tokens_cache_write + EXCLUDED.tokens_cache_write,
      tokens_reasoning = gw_metrics_buckets.tokens_reasoning + EXCLUDED.tokens_reasoning,
      estimated_spend = gw_metrics_buckets.estimated_spend + EXCLUDED.estimated_spend,
      status_breakdown = jsonb_set(
        gw_metrics_buckets.status_breakdown, ARRAY[${statusStr}::text],
        to_jsonb(COALESCE((gw_metrics_buckets.status_breakdown ->> ${statusStr})::bigint, 0) + 1)
      ),
      lat = CASE WHEN ${latencyMs != null} THEN
        (array_append(gw_metrics_buckets.lat, ${latencyMs}::double precision))[
          greatest(1, cardinality(array_append(gw_metrics_buckets.lat, ${latencyMs}::double precision)) - ${MAX_SAMPLES - 1}):
        ]
        ELSE gw_metrics_buckets.lat END,
      ttft = CASE WHEN ${ttftMs != null} THEN
        (array_append(gw_metrics_buckets.ttft, ${ttftMs}::double precision))[
          greatest(1, cardinality(array_append(gw_metrics_buckets.ttft, ${ttftMs}::double precision)) - ${MAX_SAMPLES - 1}):
        ]
        ELSE gw_metrics_buckets.ttft END
  `;
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

// Same shape as upsertBucket but targeting gw_metrics_daily with the WAT
// day in the key. Written alongside the cumulative bucket in the same
// request's Promise.all batch so the two can only disagree mid-outage,
// never permanently drift.
async function upsertDailyBucket(day, scope, name, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  const statusStr = String(status);
  const u = usage
    ? { input: num(usage.input), output: num(usage.output), cache_read: num(usage.cache_read), cache_write: num(usage.cache_write), reasoning: num(usage.reasoning) }
    : null;
  await sql`
    INSERT INTO gw_metrics_daily (
      day, scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
      fallbacks, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
      tokens_reasoning, estimated_spend, status_breakdown
    ) VALUES (
      ${day}, ${scope}, ${name}, 1, ${status >= 200 && status < 300 ? 1 : 0}, ${status >= 400 && status < 500 ? 1 : 0}, ${status >= 500 ? 1 : 0},
      ${isFallback ? 1 : 0}, ${u?.input || 0}, ${u?.output || 0}, ${u?.cache_read || 0}, ${u?.cache_write || 0},
      ${u?.reasoning || 0}, ${estimatedCost != null ? num(estimatedCost) : 0}, jsonb_build_object(${statusStr}::text, 1)
    )
    ON CONFLICT (day, scope, name) DO UPDATE SET
      requests = gw_metrics_daily.requests + EXCLUDED.requests,
      requests_2xx = gw_metrics_daily.requests_2xx + EXCLUDED.requests_2xx,
      requests_4xx = gw_metrics_daily.requests_4xx + EXCLUDED.requests_4xx,
      requests_5xx = gw_metrics_daily.requests_5xx + EXCLUDED.requests_5xx,
      fallbacks = gw_metrics_daily.fallbacks + EXCLUDED.fallbacks,
      tokens_input = gw_metrics_daily.tokens_input + EXCLUDED.tokens_input,
      tokens_output = gw_metrics_daily.tokens_output + EXCLUDED.tokens_output,
      tokens_cache_read = gw_metrics_daily.tokens_cache_read + EXCLUDED.tokens_cache_read,
      tokens_cache_write = gw_metrics_daily.tokens_cache_write + EXCLUDED.tokens_cache_write,
      tokens_reasoning = gw_metrics_daily.tokens_reasoning + EXCLUDED.tokens_reasoning,
      estimated_spend = gw_metrics_daily.estimated_spend + EXCLUDED.estimated_spend,
      status_breakdown = jsonb_set(
        gw_metrics_daily.status_breakdown, ARRAY[${statusStr}::text],
        to_jsonb(COALESCE((gw_metrics_daily.status_breakdown ->> ${statusStr})::bigint, 0) + 1)
      )
  `;
}

async function bumpDailyUpstreamErrors(day, scope, name) {
  await sql`
    INSERT INTO gw_metrics_daily (day, scope, name, upstream_errors)
    VALUES (${day}, ${scope}, ${name}, 1)
    ON CONFLICT (day, scope, name) DO UPDATE SET
      upstream_errors = gw_metrics_daily.upstream_errors + EXCLUDED.upstream_errors
  `;
}

export async function recordRequest(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  provider = provider || "unknown";
  model = model || "unknown";

  if (!dbUsable()) {
    recordRequestMem(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    return;
  }

  try {
    await ensureSchema();
    const day = localDay();
    await Promise.all([
      upsertBucket("global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
      upsertBucket("provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
      upsertBucket("model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
      upsertDailyBucket(day, "global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
      upsertDailyBucket(day, "provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
      upsertDailyBucket(day, "model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback),
    ]);
  } catch (error) {
    recordDbFailure(error);
    recordRequestMem(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    // 2026-09-10: daily history must be recorded on the DB-FAILURE catch
    // path too (not just the !dbUsable() early return) -- the unreachable-
    // DB regression test proved requests recorded during a DB outage
    // otherwise vanished from the daily view entirely.
    bumpDailyMem("global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpDailyMem("model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  }
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

async function bumpUpstreamErrors(scope, name) {
  await sql`
    INSERT INTO gw_metrics_buckets (scope, name, upstream_errors)
    VALUES (${scope}, ${name}, 1)
    ON CONFLICT (scope, name) DO UPDATE SET
      upstream_errors = gw_metrics_buckets.upstream_errors + 1
  `;
}

export async function recordUpstreamError(provider, model) {
  provider = provider || "unknown";

  if (!dbUsable()) {
    recordUpstreamErrorMem(provider, model);
    const day = localDay();
    memDailyBucket(day, "global", "_").upstreamErrors += 1;
    memDailyBucket(day, "provider", provider).upstreamErrors += 1;
    if (model) memDailyBucket(day, "model", model).upstreamErrors += 1;
    return;
  }

  try {
    await ensureSchema();
    const day = localDay();
    await Promise.all([
      bumpUpstreamErrors("global", "_"),
      bumpUpstreamErrors("provider", provider),
      ...(model ? [bumpUpstreamErrors("model", model)] : []),
      bumpDailyUpstreamErrors(day, "global", "_"),
      bumpDailyUpstreamErrors(day, "provider", provider),
      ...(model ? [bumpDailyUpstreamErrors(day, "model", model)] : []),
    ]);
  } catch (error) {
    recordDbFailure(error);
    recordUpstreamErrorMem(provider, model);
    const dayOnFail = localDay();
    memDailyBucket(dayOnFail, "global", "_").upstreamErrors += 1;
    memDailyBucket(dayOnFail, "provider", provider).upstreamErrors += 1;
    if (model) memDailyBucket(dayOnFail, "model", model).upstreamErrors += 1;
  }
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

// ─── Circuit breakers (shared across instances) ──────────────────────────────

const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30000;

function defaultCircuitBreaker() {
  return { state: "closed", failures: 0, openedAt: null, threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS };
}

function cbMemKey(provider, model) {
  return `${provider || "unknown"}:${model || "unknown"}`;
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
      out[`${raw.provider}:${raw.model}`] = {
        state: raw.state,
        failures: Number(raw.failures) || 0,
        openedAt: raw.opened_at ? Number(raw.opened_at) : null,
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

async function readBucket(scope, name) {
  if (!dbUsable()) {
    const b = memBucket(scope === "global" ? "global:_" : `${scope}:${name}`);
    return serializeFromMem(b);
  }
  try {
    await ensureSchema();
    const rows = await sql`
      SELECT * FROM gw_metrics_buckets WHERE scope = ${scope} AND name = ${name}
    `;
    return serializeFromDb(rows[0] || null);
  } catch (error) {
    recordDbFailure(error);
    const b = memBucket(scope === "global" ? "global:_" : `${scope}:${name}`);
    return serializeFromMem(b);
  }
}

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

export async function getMetricsSnapshot(knownProviders, knownModels) {
  const global = await readBucket("global", "_");

  let providerNames, modelNames;
  if (!dbUsable()) {
    providerNames = [...new Set([...(mem.sets.get("providers") || []), ...knownProviders])];
    modelNames = [...new Set([...(mem.sets.get("models") || []), ...knownModels])];
  } else {
    try {
      await ensureSchema();
      const [providerRows, modelRows] = await Promise.all([
        sql`SELECT DISTINCT name FROM gw_metrics_buckets WHERE scope = 'provider'`,
        sql`SELECT DISTINCT name FROM gw_metrics_buckets WHERE scope = 'model'`,
      ]);
      providerNames = [...new Set([...providerRows.map((r) => r.name), ...knownProviders])];
      modelNames = [...new Set([...modelRows.map((r) => r.name), ...knownModels])];
    } catch (error) {
      recordDbFailure(error);
      providerNames = [...new Set([...(mem.sets.get("providers") || []), ...knownProviders])];
      modelNames = [...new Set([...(mem.sets.get("models") || []), ...knownModels])];
    }
  }

  const byProvider = {};
  await Promise.all(providerNames.map(async (name) => { byProvider[name] = await readBucket("provider", name); }));
  const byModel = {};
  await Promise.all(modelNames.map(async (name) => { byModel[name] = await readBucket("model", name); }));

  const circuitBreakers = await getAllCircuitBreakers();

  const activeRequests = await getGauge("activeRequests");
  const activeStreams = await getGauge("activeStreams");

  // Per-day history (added 2026-09-10). Unbounded retention -- every day
  // that ever had traffic stays queryable forever, so a full year (or
  // more) of daily trends is always available. Rows only exist for days
  // with traffic, so this stays small in practice.
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
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  } else {
    try {
      await ensureSchema();
      const rows = await sql`
        SELECT day, scope, name, requests, requests_2xx, requests_4xx, requests_5xx,
               upstream_errors, fallbacks, tokens_input, tokens_output,
               tokens_cache_read, tokens_cache_write, tokens_reasoning, estimated_spend
        FROM gw_metrics_daily
        ORDER BY day ASC
      `;
      daily = rows.map((r) => ({
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
