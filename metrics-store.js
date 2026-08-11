// ─── Durable, cross-instance metrics + circuit-breaker store ─────────────────
//
// WHY THIS FILE EXISTS: this gateway runs on Vercel serverless functions
// (see api/index.js + vercel.json rewrite). Serverless functions are
// stateless between invocations -- there is no guarantee the request that
// proxies a chat completion and the later request that reads /metrics (or
// even two concurrent chat requests) land on the same warm instance. The
// original implementation kept `metrics` and `circuitBreakers` as plain
// module-level JS objects, which only ever reflected whatever traffic
// happened to hit *that one* instance since its last cold start -- so real
// production traffic could rack up hundreds of requests while /metrics
// (hit by a different, fresher instance) kept reporting 0, and circuit
// breakers never reliably tripped either since each instance had its own
// isolated failure count.
//
// Fix: persist every counter, status-code breakdown, and latency/ttft
// sample in Upstash Redis (REST-based, so no persistent TCP connection is
// needed -- perfect for serverless) via the same KV_REST_API_URL /
// KV_REST_API_TOKEN already provisioned for entry-agents. All instances
// read and write the same backing store, so metrics and circuit-breaker
// state are finally consistent no matter which instance handles which
// request.
//
// Falls back to an in-memory store (old behavior, single-instance-only)
// if no Redis credentials are configured, so local dev without Upstash
// still works -- it just won't be cross-instance consistent, which is
// fine for a single local `node server.js` process.

import { Redis } from "@upstash/redis";

const MAX_SAMPLES = 500; // capped list length per latency/ttft series in Redis
const PREFIX = "gw:m:"; // namespaced so it never collides with entry-agents' own KV keys

let redis = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} else {
  console.error(JSON.stringify({
    type: "metrics_store_fallback",
    message: "KV_REST_API_URL/KV_REST_API_TOKEN not set -- metrics and circuit breakers will be IN-MEMORY ONLY and will not be consistent across serverless instances.",
  }));
}

export const usingRedis = () => redis !== null;

// ─── In-memory fallback (dev only) ───────────────────────────────────────────

const mem = {
  buckets: new Map(), // key -> { counters, status, lat[], ttft[] }
  sets: new Map(), // key -> Set
  gauges: new Map(), // key -> number
  cbs: new Map(), // key -> {state,failures,openedAt,threshold,cooldownMs}
};
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

// ─── Key helpers ──────────────────────────────────────────────────────────────

const bucketKey = (scope, name) => `${PREFIX}${scope}:${name ?? "_"}`;
const statusKey = (scope, name) => `${bucketKey(scope, name)}:status`;
const latKey = (scope, name) => `${bucketKey(scope, name)}:lat`;
const ttftKey = (scope, name) => `${bucketKey(scope, name)}:ttft`;
const modelsOfProviderKey = (name) => `${PREFIX}provider:${name}:models`;
const providersSetKey = () => `${PREFIX}providers`;
const modelsSetKey = () => `${PREFIX}models`;
const gaugeKey = (name) => `${PREFIX}gauge:${name}`;
const cbKey = (provider, model) => `${PREFIX}cb:${provider || "unknown"}:${model || "unknown"}`;
const cbSetKey = () => `${PREFIX}cbkeys`;

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

async function bumpBucket(pipeline, scope, name, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  const bk = bucketKey(scope, name);
  const sk = statusKey(scope, name);
  const lk = latKey(scope, name);
  const tk = ttftKey(scope, name);

  pipeline.hincrby(bk, "requests", 1);
  if (status >= 200 && status < 300) pipeline.hincrby(bk, "requests2xx", 1);
  else if (status >= 400 && status < 500) pipeline.hincrby(bk, "requests4xx", 1);
  else if (status >= 500) pipeline.hincrby(bk, "requests5xx", 1);
  pipeline.hincrby(sk, String(status), 1);
  if (isFallback) pipeline.hincrby(bk, "fallbacks", 1);

  if (usage) {
    if (usage.input) pipeline.hincrby(bk, "tokensInput", usage.input);
    if (usage.output) pipeline.hincrby(bk, "tokensOutput", usage.output);
    if (usage.cache_read) pipeline.hincrby(bk, "tokensCacheRead", usage.cache_read);
    if (usage.cache_write) pipeline.hincrby(bk, "tokensCacheWrite", usage.cache_write);
    if (usage.reasoning) pipeline.hincrby(bk, "tokensReasoning", usage.reasoning);
  }
  if (estimatedCost != null) pipeline.hincrbyfloat(bk, "estimatedSpend", estimatedCost);

  if (latencyMs != null) {
    pipeline.rpush(lk, latencyMs);
    pipeline.ltrim(lk, -MAX_SAMPLES, -1);
  }
  if (ttftMs != null) {
    pipeline.rpush(tk, ttftMs);
    pipeline.ltrim(tk, -MAX_SAMPLES, -1);
  }
}

function bumpMem(bucket, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
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

export async function recordRequest(provider, model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback) {
  provider = provider || "unknown";
  model = model || "unknown";

  if (!redis) {
    bumpMem(memBucket("global:_"), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpMem(memBucket(`provider:${provider}`), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    bumpMem(memBucket(`model:${model}`), status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
    const pb = memBucket(`provider:${provider}`);
    pb.models[model] = (pb.models[model] || 0) + 1;
    if (!mem.sets.has("providers")) mem.sets.set("providers", new Set());
    if (!mem.sets.has("models")) mem.sets.set("models", new Set());
    mem.sets.get("providers").add(provider);
    mem.sets.get("models").add(model);
    return;
  }

  const pipeline = redis.pipeline();
  await bumpBucket(pipeline, "global", "_", status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  await bumpBucket(pipeline, "provider", provider, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  await bumpBucket(pipeline, "model", model, status, latencyMs, ttftMs, usage, estimatedCost, isFallback);
  pipeline.hincrby(modelsOfProviderKey(provider), model, 1);
  pipeline.sadd(providersSetKey(), provider);
  pipeline.sadd(modelsSetKey(), model);
  await pipeline.exec();
}

export async function recordUpstreamError(provider) {
  provider = provider || "unknown";
  if (!redis) {
    const pb = memBucket(`provider:${provider}`);
    pb.counters.upstreamErrors = (pb.counters.upstreamErrors || 0) + 1;
    const gb = memBucket("global:_");
    gb.counters.upstreamErrors = (gb.counters.upstreamErrors || 0) + 1;
    return;
  }
  const pipeline = redis.pipeline();
  pipeline.hincrby(bucketKey("provider", provider), "upstreamErrors", 1);
  pipeline.hincrby(bucketKey("global", "_"), "upstreamErrors", 1);
  pipeline.sadd(providersSetKey(), provider);
  await pipeline.exec();
}

// ─── Gauges (activeRequests / activeStreams) ─────────────────────────────────

export async function incrGauge(name, delta) {
  if (!redis) {
    mem.gauges.set(name, (mem.gauges.get(name) || 0) + delta);
    return;
  }
  if (delta >= 0) await redis.incrby(gaugeKey(name), delta);
  else await redis.decrby(gaugeKey(name), -delta);
}

export async function getGauge(name) {
  if (!redis) return Math.max(0, mem.gauges.get(name) || 0);
  const v = await redis.get(gaugeKey(name));
  return Math.max(0, Number(v) || 0);
}

// ─── Circuit breakers (shared across instances) ──────────────────────────────

const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 30000;

export async function getCircuitBreaker(provider, model) {
  const key = cbKey(provider, model);
  if (!redis) {
    if (!mem.cbs.has(key)) mem.cbs.set(key, { state: "closed", failures: 0, openedAt: null, threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS });
    return mem.cbs.get(key);
  }
  const raw = await redis.hgetall(key);
  if (!raw || !raw.state) {
    return { state: "closed", failures: 0, openedAt: null, threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS };
  }
  return {
    state: raw.state,
    failures: Number(raw.failures) || 0,
    openedAt: raw.openedAt ? Number(raw.openedAt) : null,
    threshold: CB_THRESHOLD,
    cooldownMs: CB_COOLDOWN_MS,
  };
}

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
  const key = cbKey(provider, model);
  if (!redis) {
    mem.cbs.set(key, { state, failures, openedAt, threshold: CB_THRESHOLD, cooldownMs: CB_COOLDOWN_MS });
    return;
  }
  const pipeline = redis.pipeline();
  pipeline.hset(key, { state, failures, openedAt: openedAt ?? "" });
  pipeline.sadd(cbSetKey(), key);
  await pipeline.exec();
}

export async function recordBreakerFailure(provider, model) {
  const cb = await getCircuitBreaker(provider, model);
  const failures = cb.failures + 1;
  if (cb.state === "closed" && failures >= cb.threshold) {
    await setCircuitState(provider, model, "open", failures, Date.now());
    console.error(JSON.stringify({ type: "circuit_opened", provider, model, failures }));
  } else {
    await setCircuitState(provider, model, cb.state, failures, cb.openedAt);
  }
}

export async function recordBreakerSuccess(provider, model) {
  const cb = await getCircuitBreaker(provider, model);
  if (cb.state !== "closed") {
    await setCircuitState(provider, model, "closed", 0, null);
    console.log(JSON.stringify({ type: "circuit_recovered", provider, model }));
  }
}

export async function getAllCircuitBreakers() {
  if (!redis) {
    const out = {};
    for (const [key, cb] of mem.cbs.entries()) {
      const shortKey = key.slice(PREFIX.length + 3); // strip "gw:m:cb:"
      out[shortKey] = cb;
    }
    return out;
  }
  const keys = await redis.smembers(cbSetKey());
  if (!keys.length) return {};
  const out = {};
  await Promise.all(keys.map(async (key) => {
    const raw = await redis.hgetall(key);
    if (!raw || !raw.state) return;
    const shortKey = key.slice(PREFIX.length + 3);
    out[shortKey] = {
      state: raw.state,
      failures: Number(raw.failures) || 0,
      openedAt: raw.openedAt ? Number(raw.openedAt) : null,
    };
  }));
  return out;
}

// ─── Snapshot for /metrics and /health ───────────────────────────────────────

async function readBucket(scope, name) {
  if (!redis) {
    const b = memBucket(scope === "global" ? "global:_" : `${scope}:${name}`);
    return serializeFromMem(b);
  }
  const bk = bucketKey(scope, name);
  const sk = statusKey(scope, name);
  const lk = latKey(scope, name);
  const tk = ttftKey(scope, name);
  const [counters, status, lat, ttft] = await Promise.all([
    redis.hgetall(bk),
    redis.hgetall(sk),
    redis.lrange(lk, 0, -1),
    redis.lrange(tk, 0, -1),
  ]);
  return serializeFromRedis(counters || {}, status || {}, (lat || []).map(Number), (ttft || []).map(Number));
}

function serializeFromRedis(c, status, lat, ttft) {
  return {
    requests: Number(c.requests) || 0,
    requests2xx: Number(c.requests2xx) || 0,
    requests4xx: Number(c.requests4xx) || 0,
    requests5xx: Number(c.requests5xx) || 0,
    upstreamErrors: Number(c.upstreamErrors) || 0,
    fallbacks: Number(c.fallbacks) || 0,
    tokens: {
      input: Number(c.tokensInput) || 0,
      output: Number(c.tokensOutput) || 0,
      cacheRead: Number(c.tokensCacheRead) || 0,
      cacheWrite: Number(c.tokensCacheWrite) || 0,
      reasoning: Number(c.tokensReasoning) || 0,
      total: (Number(c.tokensInput) || 0) + (Number(c.tokensOutput) || 0),
    },
    estimatedSpend: Number(Number(c.estimatedSpend || 0).toFixed(6)),
    latency: percentiles(lat),
    ttft: percentiles(ttft),
    statusBreakdown: status,
  };
}

function serializeFromMem(b) {
  const c = b.counters;
  return {
    requests: c.requests || 0,
    requests2xx: c.requests2xx || 0,
    requests4xx: c.requests4xx || 0,
    requests5xx: c.requests5xx || 0,
    upstreamErrors: c.upstreamErrors || 0,
    fallbacks: c.fallbacks || 0,
    tokens: {
      input: c.tokensInput || 0,
      output: c.tokensOutput || 0,
      cacheRead: c.tokensCacheRead || 0,
      cacheWrite: c.tokensCacheWrite || 0,
      reasoning: c.tokensReasoning || 0,
      total: (c.tokensInput || 0) + (c.tokensOutput || 0),
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
  if (!redis) {
    providerNames = [...new Set([...(mem.sets.get("providers") || []), ...knownProviders])];
    modelNames = [...new Set([...(mem.sets.get("models") || []), ...knownModels])];
  } else {
    const [seenProviders, seenModels] = await Promise.all([
      redis.smembers(providersSetKey()),
      redis.smembers(modelsSetKey()),
    ]);
    providerNames = [...new Set([...(seenProviders || []), ...knownProviders])];
    modelNames = [...new Set([...(seenModels || []), ...knownModels])];
  }

  const byProvider = {};
  await Promise.all(providerNames.map(async (name) => { byProvider[name] = await readBucket("provider", name); }));
  const byModel = {};
  await Promise.all(modelNames.map(async (name) => { byModel[name] = await readBucket("model", name); }));

  const circuitBreakers = await getAllCircuitBreakers();

  const activeRequests = await getGauge("activeRequests");
  const activeStreams = await getGauge("activeStreams");

  return {
    activeRequests,
    activeStreams,
    global,
    byProvider,
    byModel,
    circuitBreakers,
    providers: providerNames,
    modelCount: modelNames.length,
    providerCount: providerNames.length,
  };
}
