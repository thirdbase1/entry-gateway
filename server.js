import express from "express";
import { createHash, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  recordRequest,
  recordUpstreamError,
  recordBreakerFailure,
  recordBreakerSuccess,
  isCircuitOpen,
  getMetricsSnapshot,
  getAllCircuitBreakers,
  beginActiveLease,
  endActiveLease,
  countActiveLeases,
  getDailySpendUsd,
  flushPendingWrites,
  CB_COOLDOWN_MS,
  usingDb,
} from "./metrics-store.js";
import { evaluateSpendLimit, secondsUntilNextWatMidnight } from "./spend-guard.js";
import { getOrCreateCachedContent } from "./gemini-cache.js";
import { createUpstreamAbort } from "./upstream-abort.js";
import { validateStartupConfig } from "./config-validation.js";

const app = express();
// Vercel (and most PaaS) terminate TLS upstream and forward to this
// process over plain HTTP, setting X-Forwarded-Proto: https. Without
// trusting the proxy, Express's req.protocol always reports "http" even
// on a real https:// request -- which made the /admin auto-inject below
// emit an http:// gateway-url, and a browser on the https admin page
// mixed-content-blocks any fetch() to a plain http:// URL (shows up as
// yet another opaque "Failed to fetch").
app.set("trust proxy", true);

// Every response carries a gateway request id (rule.md rule 10). This runs
// FIRST, before express.json(), so even a 400 from body parsing or a 413 from
// the size limit -- both of which are raised by the parser itself, before any
// later middleware or route handler ever runs -- still carries a correlation
// id the operator can grep for. Previously only handle()'s success/502 paths
// set the header, so every rejected request arrived with no id at all.
app.use((req, res, next) => {
  const id = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.locals.requestId = id;
  res.setHeader("x-gateway-request-id", id);
  next();
});

app.use(express.json({ limit: "25mb" }));

// CORS: the settings/gateway dashboard on entry-agents.vercel.app calls
// CORS: the inference API is called SERVER-to-server by Entry Agents (no
// browser consumer remains -- the old browser dashboard moved behind the new
// authenticated dashboard app, which polls its own same-origin API). The
// allowlist is therefore trimmed to localhost development only; everything
// else gets no CORS headers, so browsers can never read the API cross-origin.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:8787",
]);
// Malformed Origin headers must never throw middleware errors (cheap DoS
// vector historically): a bad origin simply means "not allowed".
function originAllowed(origin) {
  return ALLOWED_ORIGINS.has(origin);
}
app.use((req, res, next) => {
  // Baseline security response headers on every response.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ─── Forwardable upstream response headers ──────────────────────────────────
// An ALLOWLIST, not the previous 4-item denylist. A denylist over
// attacker-influenced input is a guaranteed eventual miss: a provider only has
// to start emitting one new secret-bearing header and it is forwarded
// verbatim. Confirmed live against a mock upstream returning
// `Authorization: Bearer <upstream key>`, `x-api-key`, `set-cookie`, and a
// forged `x-gateway-request-id` -- all four reached the client before this.
// What the client genuinely needs is body/content metadata and rate-limit
// signals it can act on; everything else upstream-specific is dropped.
const FORWARDABLE_RESPONSE_HEADERS = new Set([
  "content-type",
  // provider rate-limit / retry hints
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-limit",
  "anthropic-ratelimit-output-tokens-remaining",
  "anthropic-ratelimit-output-tokens-reset",
  "openai-version",
  "openai-organization",
  "openai-processing-ms",
]);
// Never forwarded even if a future edit adds them above: the gateway's own
// correlation header plus every credential and cookie carrier.
const BLOCKED_RESPONSE_HEADERS = new Set([
  "x-gateway-request-id",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "www-authenticate",
]);
export function forwardableResponseHeader(name) {
  const lower = String(name).toLowerCase();
  if (BLOCKED_RESPONSE_HEADERS.has(lower)) return false;
  return FORWARDABLE_RESPONSE_HEADERS.has(lower);
}

const PORT = Number(process.env.PORT || 8787);
let discovered = [];
// The default per-attempt upstream hard-timeout (routes may override with
// timeoutMs). Exposed via /metrics definitions so the dashboard can
// distinguish "p95/p99 sit at the timeout ceiling" from ordinary clusters.
const DEFAULT_UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);

const parseJson = (name, fallback) => {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch (e) { console.error(`${name}: invalid JSON: ${e.message}`); return fallback; }
};
// PERF: keys()/adminKeys()/configured() used to re-parse env vars (JSON.parse
// across 6 route lists, plus split/trim/Set construction) on EVERY request.
// Under high concurrency that's pure wasted CPU on the hot path. These are
// memoized behind a short TTL so a rotated key / edited route list still takes
// effect within a few seconds without a redeploy, while steady-state traffic
// pays the parse cost at most once per window. The cached Set/array is only
// ever read (.has/.size/iteration), never mutated, so sharing the reference
// across requests is safe.
const CONFIG_CACHE_MS = Math.max(0, Number(process.env.CONFIG_CACHE_MS ?? 5000));
function ttlCache(build, ttlMs = CONFIG_CACHE_MS) {
  let at = -Infinity, value = null;
  return () => {
    const now = Date.now();
    if (now - at > ttlMs) { value = build(); at = now; }
    return value;
  };
}
const keys = ttlCache(() => new Set((process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean)));
// EXTRA_MODEL_ROUTES_JSON is a second, additive routes list -- kept
// separate from MODEL_ROUTES_JSON (a Vercel "Sensitive" env var, which
// Vercel makes permanently write-only/unreadable once set, by design) so
// new one-off routes can be added without ever needing to read back and
// re-paste the existing list. Same shape as MODEL_ROUTES_JSON entries.
//
// EXTRA_MODEL_ROUTES_JSON_2: turns out EXTRA_MODEL_ROUTES_JSON itself got
// created as Vercel type "sensitive" at some point too (confirmed via the
// API decrypt=true param returning decrypted:false for it), defeating the
// whole point of keeping a *readable* additive list. Rather than delete
// it blindly -- which would silently drop whatever routes are already in
// there with no way to recover them -- this adds a second slot, created
// as type "encrypted" (still hidden by default in the dashboard, but
// actually decryptable via the API), for all future one-off additions.
// EXTRA_MODEL_ROUTES_JSON_3: same story again -- checked 2026-08-17 via
// the API's decrypt=true param and EXTRA_MODEL_ROUTES_JSON_2 also came
// back type "sensitive"/decrypted:false, so it's just as unreadable as
// the first one now (whether it got re-typed at some point or was never
// actually "encrypted" as the comment above hoped). Same fix: a third
// slot for new additions, verified as type "encrypted" (readable via
// the API) when it was created this time.
//
// BUG FOUND 2026-08-28: EXTRA_MODEL_ROUTES_JSON_4 was created on Vercel
// at some point (type "encrypted", has a value) but was NEVER added to
// this array -- so whatever routes it holds have been completely inert
// in production this whole time, silently. Also confirmed the same day:
// the opaque base64 "eyJ2...` blob the Vercel API returns for
// decrypt=true on an "encrypted"-type var is NOT a double-encryption bug
// -- it's just Vercel's normal API representation for that var type
// (confirmed by creating EXTRA_MODEL_ROUTES_JSON_5 fresh with known
// plaintext and seeing the identical envelope shape come straight back
// in the creation response itself). So _2/_3/_4 are likely fine
// underneath; there's just no way to read the real plaintext back via
// this API for any of them. Wiring in both _4 and a new _5 now (used for
// the api.b.ai models added this same day: deepseek-v4-flash-vision-exp,
// glm-5.3-flash, qwen3.8-flash).
// EXTRA_MODEL_ROUTES_JSON_6: dedicated additive slot for Token Harbor routes so
// they follow the same env-driven configuration pattern as the B.AI routes.
// Keep TOKEN_HARBOR_API_KEY server-side; never place the secret in route JSON.
// EXTRA_MODEL_ROUTES_JSON_7: dedicated additive slot for StepFun routes.
// Keep provider API keys server-side; never place secrets in route JSON.

// ─── Public model ids: ":free" suffix stripping ──────────────────────────────
// Provider free tiers are configured with ids like "qwen3.8-flash:free", but
// clients should never see or type the ":free" suffix. The gateway exposes
// the STRIPPED id publicly (/v1/models, routing, metrics, breakers) while
// calling the upstream with the REAL id (kept in upstreamModel). These are
// genuinely different models from their paid namesakes (different upstream
// entries), so nothing is merged away: a stripped free route and an explicit
// paid route for the same public id simply coexist as priority-ordered
// fallback candidates, exactly like two providers for one model already do.
const FREE_ID_SUFFIX_RE = /:free$/i;
function normalizeRouteFreeId(r) {
  if (typeof r?.id === "string" && FREE_ID_SUFFIX_RE.test(r.id)) {
    return {
      ...r,
      id: r.id.replace(FREE_ID_SUFFIX_RE, ""),
      // The upstream still knows the model by its real ":free" id.
      upstreamModel: r.upstreamModel || r.id,
    };
  }
  return r;
}

const configured = ttlCache(() => [
  ...(Array.isArray(parseJson("MODEL_ROUTES_JSON", [])) ? parseJson("MODEL_ROUTES_JSON", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_2", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_2", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_3", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_3", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_4", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_4", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_5", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_5", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_6", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_6", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_7", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_7", []) : []),
].filter(r => r?.id && r?.upstreamBaseURL).map(r => ({ protocol: "openai-chat", priority: 100, enabled: true, ...r })).map(normalizeRouteFreeId));
const routes = ttlCache(() => {
  const m = new Map();
  // NOTE: upstreamApiKeyEnv is part of the dedup key -- without it, two
  // routes for the same id+protocol+baseURL+model but *different*
  // credentials (e.g. two OrcaRouter accounts used as primary/fallback
  // for the same model) silently collapsed into one, with whichever
  // entry appeared last in the configured() array clobbering the other.
  // Found 2026-08-16 wiring a second OrcaRouter key for qwen3.8-27b: the
  // fallback entry silently replaced the primary instead of coexisting
  // as a second candidates() entry, so handle()'s priority-ordered
  // fallback loop never actually got two routes to try.
  for (const r of [...configured(), ...discovered]) m.set(`${r.id}|${r.protocol}|${r.upstreamBaseURL}|${r.upstreamModel || r.id}|${r.upstreamApiKeyEnv || ""}`, r);
  return [...m.values()];
});
const bearerToken = req => ((req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "");

// SECURITY: constant-time key verification. The previous auth paths used
// Set.has(supplied) directly, which short-circuits on the first differing
// byte and leaks a per-position timing signal for every configured key.
// Instead of comparing raw key strings, both sides are SHA-256 hashed
// first (hashing always reads the full input, so the digest comparison is
// over uniform-length data) and then compared with timingSafeEqual. The
// hash set is memoized behind the same TTL cache as the raw key sets, so
// this adds no per-request hashing cost to the hot path beyond the cheap
// single hash of the supplied token.
const safeEquals = (a, b) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
const hashSet = list => new Set(list.map(k => createHash("sha256").update(k).digest("hex")));
const keyHashes = ttlCache(() => hashSet((process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean)));
// Static metrics fallback key (non-Vercel/self-hosted path; never issued to browsers).
const metricsKeyHashes = ttlCache(() => hashSet((process.env.METRICS_BEARER_KEY || "").split(",").map(x => x.trim()).filter(Boolean)));
// Vercel OIDC verification config, read lazily so tests can toggle per request.
// JWKS remote set is cached per URL; verification failures fail CLOSED.
const metricsOidcConfig = () => {
  const issuer = process.env.METRICS_OIDC_ISSUER;
  const audience = process.env.METRICS_OIDC_AUDIENCE;
  if (!issuer || !audience) return null;
  const jwksUrl = process.env.METRICS_OIDC_JWKS_URL || `${issuer.replace(/\/$/, "")}/.well-known/jwks`;
  if (!metricsOidcConfig.jwks || metricsOidcConfig.jwksUrl !== jwksUrl) {
    metricsOidcConfig.jwks = createRemoteJWKSet(new URL(jwksUrl));
    metricsOidcConfig.jwksUrl = jwksUrl;
  }
  return { issuer, audience, subject: process.env.METRICS_OIDC_SUBJECT || "", jwks: metricsOidcConfig.jwks };
};
const inHashSet = (set, value) => set.has(value) || [...set].some(h => safeEquals(h, createHash("sha256").update(value).digest("hex")));

// ─── Per-key rate limiting ──────────────────────────────────────────────────
// A single gateway key is shared by everything downstream of it, so without a
// cap one runaway/compromised client can hammer every upstream at once (blowing
// up cost and tripping provider quotas for everyone). This is a token bucket
// per API key. NOTE: like the metrics store's in-memory fallback, this is
// PER-WARM-INSTANCE -- it's a cheap first-line brake that keeps the hot path off
// the database, not a hard global quota. Set RATE_LIMIT_RPS=0 to disable.
const RATE_LIMIT_RPS = Number(process.env.RATE_LIMIT_RPS ?? 50);
const RATE_LIMIT_BURST = Math.max(1, Number(process.env.RATE_LIMIT_BURST ?? 100));
const _buckets = new Map(); // key -> { tokens, ts }
const BUCKET_SWEEP_INTERVAL_MS = 60_000;
let _lastSweep = Date.now();
// SECURITY 2026-09-21: the bucket Map was keyed on the RAW API key, which
// meant every live gateway key sat in process memory for as long as its
// bucket survived the sweep -- a heap dump, a core file, or any accidental
// `console.log(buckets)` would expose them. Keys are already SHA-256 hashed
// for the timingSafeEqual auth comparison, so reuse that digest as the bucket
// key: it is stable per key, uniform-length, and reveals nothing.
const bucketKeyFor = (key) => createHash("sha256").update(key).digest("hex");
function rateLimitAllowed(key) {
  if (!(RATE_LIMIT_RPS > 0)) return { allowed: true, remaining: Infinity };
  const bucketKey = bucketKeyFor(key);
  const now = Date.now();
  // Opportunistically evict idle buckets so the Map can't grow unbounded with
  // one entry per distinct key ever seen.
  if (now - _lastSweep > BUCKET_SWEEP_INTERVAL_MS) {
    _lastSweep = now;
    for (const [k, b] of _buckets) if (b.tokens >= RATE_LIMIT_BURST) _buckets.delete(k);
  }
  let b = _buckets.get(bucketKey);
  if (!b) { b = { tokens: RATE_LIMIT_BURST, ts: now }; _buckets.set(bucketKey, b); }
  b.tokens = Math.min(RATE_LIMIT_BURST, b.tokens + ((now - b.ts) / 1000) * RATE_LIMIT_RPS);
  b.ts = now;
  if (b.tokens >= 1) { b.tokens -= 1; return { allowed: true, remaining: Math.floor(b.tokens) }; }
  return { allowed: false, remaining: 0 };
}

const auth = (req, res, next) => {
  const supplied = bearerToken(req);
  const valid = keyHashes();
  if (!valid.size) return res.status(500).json({ error: { type: "ConfigError", message: "GATEWAY_API_KEYS is not configured." } });
  if (!inHashSet(valid, supplied)) return res.status(401).json({ error: { type: "AuthError", message: "Invalid or missing API key." } });
  const rl = rateLimitAllowed(supplied);
  if (!rl.allowed) {
    res.setHeader("Retry-After", "1");
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_BURST));
    res.setHeader("X-RateLimit-Remaining", "0");
    return res.status(429).json({ error: { type: "RateLimitError", message: "Too many requests for this API key. Please slow down." } });
  }
  if (Number.isFinite(rl.remaining)) res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  next();
};

// ─── Optional daily spend ceiling (MAX_DAILY_SPEND_USD) ──────────────────────
// Server-side cost protection for the paid proxy routes: once the gateway's
// recorded ESTIMATED spend for the current WAT day reaches the ceiling, new
// upstream calls are rejected with 429 + Retry-After until the 12am WAT
// reset. Disabled unless MAX_DAILY_SPEND_USD is set to a positive number.
// See spend-guard.js for the enforcement model (best-effort: the check is
// cached for SPEND_CHECK_TTL_MS and a request's future output cost is
// unknowable, so in-flight traffic can overshoot within that window). A
// metrics-store failure degrades this to disabled (fail-open), consistent
// with "metrics must never block the proxy path".
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 0);
const SPEND_CHECK_TTL_MS = Math.max(1000, Number(process.env.SPEND_CHECK_TTL_MS ?? 15000));
const cachedDailySpend = ttlCache(() => getDailySpendUsd(), SPEND_CHECK_TTL_MS);
const spendLimitGuard = async (req, res, next) => {
  if (!(MAX_DAILY_SPEND_USD > 0)) return next();
  // The cached read holds the promise itself, so concurrent requests within
  // one TTL window share a single database round-trip.
  const decision = evaluateSpendLimit(await cachedDailySpend(), MAX_DAILY_SPEND_USD);
  if (decision.allowed) return next();
  const retryAfter = secondsUntilNextWatMidnight();
  res.setHeader("Retry-After", String(retryAfter));
  log({ type: "spend_limit_reached", spent: decision.spent, limit: decision.limit, retryAfter });
  return res.status(429).json({
    error: {
      type: "SpendLimitError",
      message: `Daily estimated spend ceiling reached ($${decision.spent.toFixed(2)} of $${decision.limit.toFixed(2)}). Resets at 12am WAT.`,
    },
  });
};

// PER-ROUTE BODY SIZE. express.json applies one global 25mb ceiling, which
// means a route for a small model accepts a 25mb prompt -- a cost and timeout
// risk the route's own configuration cannot express. This enforces the
// selected route's `maxBodyBytes` (falling back to the global ceiling) against
// the actual received body length, so the tighter of the two always wins.
// Runs after auth: an unauthenticated caller should not be able to make the
// gateway parse and measure a body it will reject anyway, and the route is
// only knowable once the model has been resolved.
const bodySizeGuard = (req, res, next) => {
  const p = protocol(req.path);
  const model = modelFor(req, p);
  if (!model) return next(); // no model -> handle()'s own 400/404 path
  const route = candidates(model, p)[0];
  const limit = Number(route?.maxBodyBytes);
  if (!Number.isFinite(limit) || limit <= 0) return next();
  // req.body is already parsed at this point (express.json ran first), so the
  // serialized length is the real received size rather than a re-encoding.
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(req.body ?? {}));
  } catch {
    return next(); // unserializable body is handle()'s problem, not ours
  }
  if (bytes > limit) {
    return res.status(413).json({
      error: {
        type: "InvalidRequestError",
        message: `Request body exceeds the ${limit}-byte limit configured for this route.`,
      },
    });
  }
  next();
};
// ─── metricsAuth: the metrics/configuration permission boundary ──────────────
// The inference API key (GATEWAY_API_KEYS) authorizes ONLY /v1/* inference.
// Metrics and route-configuration access require a separate credential:
//   1. A platform workload identity (Vercel OIDC): the caller (the dashboard's
//      server runtime) presents a Bearer JWT minted by Vercel; it is verified
//      against Vercel's public JWKS for signature, issuer, audience, subject
//      (which binds the dashboard PROJECT and ENVIRONMENT), and expiry. No
//      shared secret exists anywhere for this path.
//   2. A static fallback key (METRICS_BEARER_KEY) for non-Vercel/self-hosted
//      deployments -- narrowly scoped to these routes, never issued to browsers.
// Legacy privilege surfaces (gateway-key fallback, ADMIN_API_KEYS, the
// auto-issued gw_dash session) were removed; the env vars are ignored with a
// startup warning so stale deployments fail closed loudly, not silently open.
const metricsAuth = async (req, res, next) => {
  const supplied = bearerToken(req);
  if (!supplied) {
    console.error(JSON.stringify({ type: "metrics_authz_failed", reason: "missing_credential", path: req.path }));
    return res.status(401).json({ error: { type: "AuthError", message: "Metrics access requires a metrics credential." } });
  }
  // Path 1: static fallback key (only when configured).
  const fallbackHashes = metricsKeyHashes();
  if (fallbackHashes.size && inHashSet(fallbackHashes, supplied)) return next();
  // Path 2: Vercel OIDC (only when configured). JWTs have the classic 3-part shape.
  const oidc = metricsOidcConfig();
  if (oidc && supplied.split(".").length === 3) {
    try {
      const { payload } = await jwtVerify(supplied, oidc.jwks, {
        issuer: oidc.issuer,
        audience: oidc.audience,
        subject: oidc.subject || undefined,
        clockTolerance: 5,
      });
      // Defense in depth: the subject must bind the dashboard project regardless
      // of an over-broad METRICS_OIDC_SUBJECT configuration.
      if (process.env.METRICS_OIDC_EXPECT_PROJECT && !String(payload.sub || "").includes(`project:${process.env.METRICS_OIDC_EXPECT_PROJECT}`)) {
        throw new Error("subject does not bind the dashboard project");
      }
      return next();
    } catch (e) {
      console.error(JSON.stringify({ type: "metrics_authz_failed", reason: "oidc_rejected", detail: e instanceof Error ? e.message : String(e), path: req.path }));
      return res.status(401).json({ error: { type: "AuthError", message: "Metrics credential rejected." } });
    }
  }
  console.error(JSON.stringify({ type: "metrics_authz_failed", reason: "unknown_credential", path: req.path }));
  return res.status(401).json({ error: { type: "AuthError", message: "Invalid metrics credential." } });
};

// Deprecation notice for removed privilege env vars (fail closed, loudly).
for (const legacy of ["ADMIN_API_KEYS", "ADMIN_AUTOAUTH", "ADMIN_STRICT_KEYS", "DASHBOARD_SESSION_SECRET"]) {
  if (process.env[legacy]) {
    console.error(JSON.stringify({ type: "deprecated_env_ignored", variable: legacy, note: "Privilege env removed: the inference key no longer grants metrics/admin access; use METRICS_BEARER_KEY / METRICS_OIDC_* for the dashboard." }));
  }
}

// /v1/models is part of the OpenAI-compatible inference surface (SDK clients
// list models with their inference key), and the dashboard also renders it.
// Inference keys go through auth() so they keep per-key rate limiting and
// headers; the metrics credential is accepted as the second path.
const modelsAuth = (req, res, next) => {
  const supplied = bearerToken(req);
  if (!keyHashes().size) return res.status(500).json({ error: { type: "ConfigError", message: "GATEWAY_API_KEYS is not configured." } });
  if (inHashSet(keyHashes(), supplied)) return auth(req, res, next);
  if (inHashSet(metricsKeyHashes(), supplied) || metricsOidcConfig()) return metricsAuth(req, res, next);
  return res.status(401).json({ error: { type: "AuthError", message: "Invalid or missing API key." } });
};
// Case-insensitive match: Google's two action names differ only in the
// capitalization of the shared "GenerateContent" tail --
// ":generateContent" (non-streaming, lowercase g) vs
// ":streamGenerateContent" (streaming, uppercase G, since it's
// stream+Generate+Content). A case-SENSITIVE path.includes("generateContent")
// only ever matched the non-streaming action -- every streaming Gemini
// call (i.e. every real chat turn, since the app always streams) fell
// through to the "openai-chat" branch instead, which then 400'd with "A
// model is required" because Gemini-shaped bodies have no top-level
// `model` field. Found 2026-08-13 while validating explicit caching.
const protocol = path => path === "/v1/messages" ? "anthropic-messages" : /generatecontent/i.test(path) ? "gemini-generate" : "openai-chat";
const modelFor = (req, p) => {
  if (p !== "gemini-generate") return req.body?.model;
  const raw = req.params.modelAction || "";
  const idx = raw.lastIndexOf(":");
  return idx === -1 ? raw || req.body?.model : raw.slice(0, idx);
};
// Gemini-generate action ("generateContent" vs "streamGenerateContent") --
// the AI SDK's Google provider calls :streamGenerateContent?alt=sse for
// streaming requests, encoded in the same :modelAction path segment as the
// model id (e.g. "gemini-3.5-flash:streamGenerateContent"). modelFor()
// above only extracts the model half; this extracts the action half so
// upstreamUrl() can forward the *same* action upstream instead of always
// hardcoding :generateContent, which silently broke Gemini streaming (the
// upstream would return a single JSON blob instead of an SSE stream, with
// no error -- just a client-side parse failure on the caller's side).
const actionFor = (req, p) => {
  if (p !== "gemini-generate") return null;
  const raw = req.params.modelAction || "";
  const idx = raw.lastIndexOf(":");
  const action = idx === -1 ? "generateContent" : raw.slice(idx + 1);
  // SECURITY: `action` is an attacker-controlled path segment (it comes
  // straight from the request URL). It gets interpolated into the upstream
  // request path in upstreamUrl(). Previously it was forwarded verbatim, so a
  // request to `/v1beta/models/gemini-3.5-flash:foo/../../admin` (or any other
  // crafted action) could steer the proxied POST at an unintended endpoint on
  // the configured upstream host. Gemini's chat API only has two real actions,
  // so anything else is collapsed to the safe non-streaming default.
  return action === "streamGenerateContent" || action === "generateContent" ? action : "generateContent";
};
const candidates = (model, p) => routes().filter(r => r.id === model && r.protocol === p && r.enabled !== false).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

// SSRF GUARD: every proxied request and every discovery poll fetches a URL
// built from operator-configured env vars. If an attacker could ever inject
// or influence MODEL_ROUTES_JSON / MODEL_DISCOVERY_JSON contents (a leaked
// Vercel team token, a compromised dashboard, copy-pasted config), a route
// with `upstreamBaseURL: "file:///proc/self/environ"` or an internal-network
// host turns this gateway into an arbitrary-fetch oracle that also attaches
// provider keys to the request. These two checks confine outbound fetches to
// http(s) and, optionally, to an explicit allowlist of upstream hosts
// (UPSTREAM_HOST_ALLOWLIST=comma,separated,hosts -- empty/unset keeps the
// historical behavior of trusting whatever the operator configured).
export function isHttpUpstream(baseURL) {
  try {
    const u = new URL(baseURL);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
const upstreamHostAllowlist = ttlCache(() =>
  new Set((process.env.UPSTREAM_HOST_ALLOWLIST || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean))
);
export function upstreamHostAllowed(baseURL) {
  const allow = upstreamHostAllowlist();
  if (!allow.size) return true; // no allowlist configured -> trust operator config
  try {
    return allow.has(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const upstreamUrl = (r, p, model, action) => {
  const base = r.upstreamBaseURL.replace(/\/$/, "");
  // actionFor() already allowlists this, but encode it too as defense-in-depth
  // so no crafted segment can ever escape the intended `/models/<id>:<action>`
  // shape regardless of how this function is called.
  const geminiAction = encodeURIComponent(action || "generateContent");
  const path = r.upstreamPath || (p === "openai-chat" ? "/chat/completions" : p === "anthropic-messages" ? "/messages" : `/models/${encodeURIComponent(r.upstreamModel || model)}:${geminiAction}`);
  const url = `${base}${path.replace("{model}", encodeURIComponent(r.upstreamModel || model))}`;
  // Gemini's SSE framing (data: {...} lines, matching the OpenAI/Anthropic
  // shape this gateway's SSE parsing loop already understands) is opt-in
  // via ?alt=sse -- without it, streamGenerateContent returns a bare JSON
  // array instead.
  return p === "gemini-generate" && (action || "generateContent") === "streamGenerateContent" ? `${url}?alt=sse` : url;
};
const headers = (r, p) => {
  const key = process.env[r.upstreamApiKeyEnv];
  const h = { "Content-Type": "application/json", ...(r.headers || {}) };
  if (r.authStyle === "x-api-key" || p === "anthropic-messages") h["x-api-key"] = key;
  // Google's Generative Language API rejects `Authorization: Bearer` for
  // API-key auth (401 API_KEY_SERVICE_BLOCKED) and doesn't accept
  // `x-api-key` either (403 PERMISSION_DENIED) -- it needs its own
  // `x-goog-api-key` header (or a `?key=` query param, which would leak
  // the key into logs/URLs, so the header is used instead). Confirmed via
  // live probe against generativelanguage.googleapis.com, 2026-08-13.
  else if (r.authStyle === "x-goog-api-key") h["x-goog-api-key"] = key;
  else h.Authorization = `Bearer ${key}`;
  if (p === "anthropic-messages" && r.anthropicVersion) h["anthropic-version"] = r.anthropicVersion;
  return h;
};
const usageOf = x => {
  // Anthropic's streaming Messages API only reports cache_creation_input_tokens
  // and cache_read_input_tokens on the message_start event, and there they're
  // nested at message_start.message.usage -- NOT top-level x.usage like every
  // other event (message_delta) or non-streaming response. Without checking
  // x.message?.usage here, message_start's usage object was never found, so
  // every Claude cache_read/cache_write count was silently lost for ANY
  // streaming Claude call (confirmed 2026-08-18: claude-sonnet-4.5 showed
  // 30.5M input tokens but a flat 0 cache_read across all of it in
  // production /metrics, despite the app's own addCacheControl() correctly
  // requesting prompt caching on every request -- caching was genuinely
  // happening upstream, this gateway just never read the field reporting it).
  // Confirmed against Anthropic's docs: cache fields only ever appear on
  // message_start (streaming) or the single response.usage (non-streaming).
  const u = x?.usage || x?.response?.usage || x?.usageMetadata || x?.message?.usage;
  if (!u) return null;
  const promptDetails = u.prompt_tokens_details || u.input_tokens_details || {};
  const completionDetails = u.completion_tokens_details || u.output_tokens_details || {};
  // prompt_cache_hit_tokens/prompt_cache_miss_tokens is DeepSeek's own
  // field naming for the same concept (their OpenAI-compat endpoint
  // doesn't use cached_tokens) -- added 2026-08-17 alongside the
  // OpenAI-style fields already handled below, so any DeepSeek route
  // reports cache hits correctly too, not just OpenAI/Anthropic-shaped
  // ones.
  const cacheRead = u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_tokens ?? promptDetails.cached_tokens ?? u.cachedContentTokenCount ?? u.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? u.cache_write_tokens ?? promptDetails.cache_write_tokens ?? 0;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    reasoning: u.reasoning_tokens ?? completionDetails.reasoning_tokens ?? u.thoughtsTokenCount ?? 0
  };
};

// Merges usage across SSE events instead of last-non-null-wins. Anthropic's
// message_start (has real cache_read/cache_creation, only output_tokens=1)
// arrives BEFORE message_delta (cumulative output_tokens, but no cache
// fields at all -- see usageOf's comment above), so simply overwriting with
// the latest non-null usageOf() result clobbered message_start's real cache
// counts with message_delta's zeroed-out ones. Every field only grows or
// stays flat across one response's events, so taking the max per-field
// across all events seen is always correct and never double-counts.
function mergeUsage(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  return {
    input: Math.max(prev.input || 0, next.input || 0),
    output: Math.max(prev.output || 0, next.output || 0),
    cache_read: Math.max(prev.cache_read || 0, next.cache_read || 0),
    cache_write: Math.max(prev.cache_write || 0, next.cache_write || 0),
    reasoning: Math.max(prev.reasoning || 0, next.reasoning || 0),
  };
}

// Fallback cache-pricing MULTIPLIERS (relative to a route's own `cost.input`)
// for model families that support prompt caching but don't have explicit
// cost.cache_read/cost.cache_write set in the MODEL_ROUTES_JSON* route
// config. Added 2026-08-17: found gpt-5.6-sol/terra/luna's usage responses
// already report real cache hits via prompt_tokens_details.cached_tokens
// (OpenAI's standard automatic prompt-caching field, parsed by usageOf
// above), but the routes had no cost.cache_read/cache_write set, so those
// cached tokens were being silently billed at the FULL input rate --
// caching was working upstream, we just weren't passing the discount
// through. Ratios below are OpenAI's own official cached-token pricing
// ratio, confirmed by cross-checking developers.openai.com/api/docs/pricing
// against openai.com's gpt-5.6-sol prices ($5.00 input / $0.50 cached
// input / $6.25 cache write / $30.00 output -- 0.50/5.00 = 0.1x,
// 6.25/5.00 = 1.25x) and independently corroborated on the OpenAI
// community forum for gpt-5.6-luna post price-cut ("1.25x for write
// cache and 0.1x for read cache"). Only applied when the route's own
// static cost config doesn't already specify a rate, so any
// intentionally-configured route (e.g. Claude's, which already has real
// cost.cache_read/cache_write) is completely unaffected.
const CACHE_RATE_MULTIPLIERS_BY_PREFIX = [
  ["gpt-5.6-", { cacheRead: 0.1, cacheWrite: 1.25 }],
  // Added 2026-08-18: Gemini models on OpenCode Zen bill cached reads at a
  // flat 10% of the input rate across every variant (3.7/3.6/3.5/3.5-lite/
  // 3.1-pro/3-flash all show this exact ratio on opencode.ai/docs/zen's own
  // pricing table), and never report cache_write tokens at all (Gemini's
  // caching is automatic/implicit -- there's no explicit cache-creation
  // step like Anthropic's, so u.cache_write is always 0 for this family
  // regardless of what rate we'd apply to it). This is a safety-net
  // default for any gemini-*/gemma-* route that doesn't have its own
  // explicit cost.cache_read set in MODEL_ROUTES_JSON*; routes that
  // already carry a real cache_read are unaffected (same precedence rule
  // as the gpt-5.6- entry above).
  ["gemini-", { cacheRead: 0.1, cacheWrite: 0 }],
  ["gemma-", { cacheRead: 0.1, cacheWrite: 0 }],
];
function cacheRateMultipliersFor(routeId) {
  for (const [prefix, multipliers] of CACHE_RATE_MULTIPLIERS_BY_PREFIX) {
    if (routeId && routeId.startsWith(prefix)) return multipliers;
  }
  return null;
}

// Matches cost-object keys like "context_over_200k" or "context_over_272k".
// Added 2026-08-18: found this convention already present in live route
// data (grok-4.5's context_over_200k) but costOf() below never actually
// read it -- so that tier was configured and completely inert since
// whenever it was added. Generalized here instead of hardcoding one
// model's threshold, since gpt-5.6-sol/terra/luna need the same treatment
// at a different cutoff (272K, per opencode.ai/docs/zen's own pricing
// table) and any future tiered model can just add its own
// context_over_Nk key to cost{} with no code change.
const CONTEXT_TIER_KEY_RE = /^context_over_(\d+)k$/i;
function tieredCost(baseCost, totalInputTokens) {
  let winningThreshold = -1;
  let winningTier = null;
  for (const key of Object.keys(baseCost)) {
    const m = CONTEXT_TIER_KEY_RE.exec(key);
    if (!m) continue;
    const thresholdTokens = Number(m[1]) * 1000;
    if (totalInputTokens > thresholdTokens && thresholdTokens > winningThreshold) {
      winningThreshold = thresholdTokens;
      winningTier = baseCost[key];
    }
  }
  // Tier objects only need to override what changes (e.g. just input/output);
  // anything they omit (like cache_read) falls back to the base rate.
  return winningTier ? { ...baseCost, ...winningTier } : baseCost;
}

// Normalizes a route's raw usageOf() output into TRUE, mutually-exclusive
// buckets: uncachedInput (never includes cache_read/cache_write),
// cacheRead, cacheWrite. CORRECTED 2026-08-18: this used to assume
// input_tokens is the TOTAL prompt size with cache_read/cache_write as a
// SUBSET of it, for every protocol. That's true for OpenAI/DeepSeek/Gemini
// (confirmed against DeepSeek's real 89.94% hit rate and Gemini's own
// context-caching docs: promptTokenCount already includes
// cachedContentTokenCount), but FALSE for Anthropic -- its Messages API
// reports input_tokens, cache_creation_input_tokens, and
// cache_read_input_tokens as three mutually exclusive, ADDITIVE buckets
// (confirmed via Anthropic's own prompt-caching docs). This was dormant
// and harmless while cache_read/cache_write were always captured as 0 for
// Anthropic (see the usageOf() fix above) -- now that real cache counts
// are captured, the old Math.min(cache_read, input) clamp would have
// thrown away almost the entire cache_read/cache_write count whenever the
// new turn's uncached input was small, which is the common case for a
// coding agent (most of the prompt is cached system/tool defs). Confirmed
// against real production data: claude-opus-5 showed input=8,
// cache_read=12684 -- the old clamp would bill for 8 cached tokens
// instead of 12684.
//
// Both costOf() (billing) and recordRequest() (metrics/cacheHitRate) now
// consume THIS normalized breakdown instead of raw usage, so the two
// never disagree and metrics-store.js's cacheHitRate formula can stay a
// single, protocol-agnostic cacheRead/(uncachedInput+cacheRead+cacheWrite)
// without re-deriving protocol assumptions at read time.
function cacheBreakdownOf(r, u) {
  if (!u) return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0 };
  const isAnthropic = r.protocol === "anthropic-messages";
  if (isAnthropic) {
    return { uncachedInput: u.input || 0, cacheRead: u.cache_read || 0, cacheWrite: u.cache_write || 0 };
  }
  const cacheRead = Math.min(u.cache_read || 0, u.input || 0);
  const cacheWrite = Math.min(u.cache_write || 0, Math.max(0, (u.input || 0) - cacheRead));
  const uncachedInput = Math.max(0, (u.input || 0) - cacheRead - cacheWrite);
  return { uncachedInput, cacheRead, cacheWrite };
}

const costOf = (r, u) => {
  if (!u || !r.cost) return null;
  const { uncachedInput, cacheRead, cacheWrite } = cacheBreakdownOf(r, u);
  const cost = tieredCost(r.cost, uncachedInput + cacheRead + cacheWrite);
  const fallbackMultipliers = cacheRateMultipliersFor(r.id);
  const cacheReadRate = cost.cache_read ?? (fallbackMultipliers ? (cost.input || 0) * fallbackMultipliers.cacheRead : (cost.input || 0));
  const cacheWriteRate = cost.cache_write ?? (fallbackMultipliers ? (cost.input || 0) * fallbackMultipliers.cacheWrite : (cost.input || 0));
  return ((uncachedInput / 1e6) * (cost.input || 0) + (cacheRead / 1e6) * cacheReadRate + (cacheWrite / 1e6) * cacheWriteRate + ((u.output || 0) / 1e6) * (cost.output || 0)) * (r.billingMultiplier ?? 1);
};

// ─── Metrics + circuit breakers ──────────────────────────────────────────────
//
// Durable, cross-instance state now lives in metrics-store.js (Postgres/
// Neon via GATEWAY_METRICS_DATABASE_URL when set, otherwise an in-memory
// fallback for local dev -- migrated off Upstash Redis entirely
// 2026-08-27, see that file's HISTORY note). See that file for why a
// shared external store is needed at all: this process runs as stateless
// Vercel serverless functions, so a plain module-level object here would
// only ever reflect one instance's slice of traffic instead of the
// gateway's real, aggregate usage.

const startTime = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = x => process.env.REQUEST_LOG !== "false" && console.log(JSON.stringify({ type: "request", at: new Date().toISOString(), ...x }));

// Client-facing upstream failure detail. The 502/503 `failures` array is the
// only place upstream response content is relayed verbatim into a caller's
// payload, so it is redacted (credential-shaped strings stripped) and
// tightened from 500 to 200 chars. Server-side logs keep the fuller detail
// via upstream_failure lines, and request credentials are never logged.
const CLIENT_ERROR_SNIPPET_MAX = 200;
export function redactUpstreamDetail(text) {
  return String(text)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(x-api-key|api-key|apikey|api_key|access-token|token)\s*[=:]\s*[^\s,;"']{8,}/gi, "$1=[redacted]")
    .slice(0, CLIENT_ERROR_SNIPPET_MAX);
}

// Per-request cache summary attached to the request log line (see the
// call site in handle() below) -- input already includes cache_read as a
// subset (every provider's usage schema reports it that way, see the
// comment in usageOf above), so cacheRatio is share-of-total-input, not
// share-of-uncached-input. Returns null when there's no usage at all
// (failed/aborted requests) so log lines for those don't carry a
// misleading cache: {ratio: 0} that looks like a real cache miss.
function cacheSummary(usage) {
  if (!usage) return null;
  // BUGFIX 2026-09-21: this divided cache_read by `usage.input` alone, which
  // is only correct while `input` still INCLUDES cache_read as a subset. The
  // caller passes the ALREADY-NORMALIZED usage from cacheBreakdownOf(), whose
  // `input` is uncached-only and whose cache_read/cache_write are separate,
  // mutually-exclusive buckets (true for every protocol after normalization).
  // So a request with uncached input 100 and cache_read 900 produced
  // cacheRatio: 9 -- i.e. 900% -- meaningless as "share of prompt served from
  // cache" and it breaks any dashboard rendering it as a percentage bar.
  // Measured live against a plain OpenAI-shaped route. Denominator is now the
  // same total-prompt figure metrics-store's cacheHitRateOf uses, so the two
  // can never disagree.
  const cacheRead = usage.cache_read || 0;
  const cacheWrite = usage.cache_write || 0;
  const denom = (usage.input || 0) + cacheRead + cacheWrite;
  const ratio = denom > 0 ? cacheRead / denom : 0;
  const input = usage.input || 0;
  return {
    inputTokens: input,
    cachedTokens: cacheRead,
    cacheWriteTokens: usage.cache_write || 0,
    cacheRatio: Number(ratio.toFixed(4)),
    // "hit" if any meaningful fraction of input came from cache, "miss" if
    // there was cacheable-looking input (i.e. any input at all) but none of
    // it hit, "n/a" for the (rare) zero-input case. Threshold is loose on
    // purpose -- this is a human-scannable log tag, not a billing figure.
    cacheStatus: input === 0 ? "n/a" : cacheRead > 0 ? "hit" : "miss",
  };
}


// Derive a stable-per-conversation `prompt_cache_key` for OpenAI-family
// routes. OpenAI's implicit/automatic caching for gpt-5.6+ models is
// best-effort and depends on repeat requests landing on the SAME backend
// machine that already holds the KV cache -- prompt_cache_key is OpenAI's
// own documented mechanism for that ("common values include session IDs
// and user IDs"), but nothing upstream of this gateway currently sends
// any session identifier at all, so every request relies purely on luck.
// Found via production usage data showing intermittent full-cache-misses
// on gpt-5.6-luna even between consecutive steps of the same session
// where the prior step's entire prefix should have been cacheable.
//
// We don't have a real session/chat id forwarded from the agent (nothing
// upstream sends one -- see packages/agent/models.ts attributionHeaders,
// which only carries app name/url, not anything session-scoped), so this
// derives a synthetic one from the conversation's own content instead:
// the first user-role message never changes for the life of a session
// (it's the original task/turn-1 prompt, always present at the same
// position in every subsequent request's message array since the agent
// resends full history each step) and differs across unrelated sessions.
// Hashing it gives a stable-per-session, differs-across-sessions key
// without requiring any agent-side plumbing changes.
//
// Deliberately NOT derived from the system message: that's byte-identical
// across EVERY session of the same agent type, so keying on it would
// collapse all concurrent unrelated sessions onto one shard instead of
// giving each session its own affinity.
// Hosts whose backend needs a stable prompt_cache_key to have a real
// chance of landing repeat requests on the same warm machine. Pure and
// exported so this decision is unit-testable without spinning up any
// network mock (see needs-session-affinity.test.js).
export const NEEDS_SESSION_AFFINITY_HOSTS = new Set(["api.b.ai"]);

export function needsSessionAffinity(provider, model, upstreamBaseURL) {
  if (provider === "freemodel" && typeof model === "string" && model.startsWith("gpt-5.6")) {
    return true;
  }
  let host = null;
  try {
    host = new URL(upstreamBaseURL).host;
  } catch {
    return false;
  }
  return NEEDS_SESSION_AFFINITY_HOSTS.has(host);
}

function derivePromptCacheKey(body) {
  try {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const firstUserMsg = messages.find(m => m?.role === "user");
    if (!firstUserMsg) return null;
    const raw = typeof firstUserMsg.content === "string"
      ? firstUserMsg.content
      : Array.isArray(firstUserMsg.content)
        ? firstUserMsg.content.map(part => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
    if (!raw) return null;
    // First 500 chars is plenty of entropy to disambiguate sessions while
    // staying cheap to hash on every request.
    return createHash("sha1").update(raw.slice(0, 500)).digest("hex").slice(0, 32);
  } catch {
    return null; // never let a derivation failure break the actual request
  }
}

// ─── Proxy ────────────────────────────────────────────────────────────────────

// Fire-and-forget a metrics/circuit-breaker write off the request hot path.
// metrics-store.js's own contract is that these are non-critical and "must
// never be able to block or slow down the actual proxy request", but every
// call used to be `await`ed inline -- so each proxied request paid ~9 serial
// Neon HTTP round-trips (gauge +/-, breaker read+write, 3-way bucket upserts)
// before the handler could return. Under load that dominates latency and
// hammers the metrics DB. These functions already never reject (they fail
// open internally), so the .catch here is just a belt-and-braces guard
// against an unhandled rejection ever surfacing. Circuit-breaker *reads*
// (isCircuitOpen) stay awaited -- they gate routing -- and metrics-store keeps
// a synchronous in-memory overlay so a deferred write still trips the breaker
// immediately on this instance.
//
// On Vercel the invocation may be frozen shortly after res.end() -- before
// plain fire-and-forget promises finish -- which silently dropped usage/
// spend records and, worse, half of every active-request gauge update (the
// direct cause of the phantom "1124 active requests"). When the platform's
// request context exposes waitUntil (the same Symbol.for("@vercel/request-
// context") contract @vercel/functions wraps -- used directly so no
// dependency is added), deferred work is registered with it so the runtime
// keeps the invocation alive until the writes settle. Outside Vercel (long-
// lived Docker/node processes) the old fire-and-forget path is correct.
const VERCEL_REQ_CONTEXT = Symbol.for("@vercel/request-context");
const defer = (p) => {
  if (!p || typeof p.catch !== "function") return;
  const guarded = p.catch(e => console.error(JSON.stringify({ type: "metrics_bg_error", error: e instanceof Error ? e.message : String(e) })));
  try {
    const ctx = globalThis[VERCEL_REQ_CONTEXT]?.get?.();
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(guarded);
      return;
    }
  } catch {}
};

async function proxy(req, res, r, p, model, action, id, isFallback, cbProvider) {
  const key = process.env[r.upstreamApiKeyEnv];
  if (!key) {
    // Config error, not an upstream failure: handle()'s catch skips breaker/
    // metrics recording for configError, so it must stay a bare "Missing
    // secret <ENV>" with no route detail -- env-var NAMES are internal and
    // this string is echoed to clients in the 502 `failures` array.
    const e = new Error(`Missing secret ${r.upstreamApiKeyEnv}`);
    e.configError = true;
    throw e;
  }
  if (!isHttpUpstream(r.upstreamBaseURL) || !upstreamHostAllowed(r.upstreamBaseURL)) {
    // SSRF guard: refuse non-http(s) upstreams (file:, data:, gopher:, ...)
    // and any host outside the optional UPSTREAM_HOST_ALLOWLIST before
    // fetch() ever sees the URL.
    const e = new Error("Invalid upstream configuration");
    e.configError = true;
    throw e;
  }
  const provider = r.provider || r.upstreamApiKeyEnv || "unknown";
  // All breaker state for this model flows through the single per-model
  // identity chosen by handle() (see cbProvider there) so a fallback chain
  // can't multiply one request's failures across several provider rows.
  const breakerId = cbProvider || provider;

  // Circuit breaker check
  if (await isCircuitOpen(breakerId, model)) {
    // Record the attempt (status 0 = rejected before any upstream response)
    // so it is visible in the model's own row, but do NOT count it as an
    // upstream error: nothing reached the provider, so inflating
    // upstream_errors here made provider health look worse than it is and
    // made the error total irreconcilable with actual upstream failures.
    // The rejection is surfaced to the client as a 503 (see handle()).
    recordRequest(provider, model, 0, null, null, null, null, isFallback);
    const e = new Error(`Circuit breaker open for ${provider}:${model}`);
    e.circuitOpen = true;
    throw e;
  }

  const started = Date.now();
  let ttft = null;
  let streaming = false;
  // Self-healing in-flight tracking (see beginActiveLease in metrics-store):
  // the old +/- gauge permanently leaked +1 on every dropped decrement and
  // drifted into the thousands. The lease is begun immediately (not awaited
  // -- it must not delay the upstream call) and the end is CHAINED after the
  // begin settles so the DELETE can never race ahead of the INSERT.
  const leaseId = `${id}:${Math.random().toString(36).slice(2, 10)}`;
  const requestLease = beginActiveLease("requests", leaseId);
  defer(requestLease.then(() => endActiveLease("requests", leaseId)).catch(() => {}));

  // CRITICAL: the client sends OUR public model id (e.g. "hy3"), but the
  // upstream provider may expose that model under a different literal
  // string (e.g. Opencode Zen's real id is "hy3-free"). r.upstreamModel
  // carries that real id, but it was previously only used for the gemini
  // URL-path template -- for openai-chat/anthropic-messages the body was
  // forwarded completely unchanged, silently leaking our internal id to
  // the upstream instead. Substitute it into the outgoing body whenever
  // the two differ, for every protocol that carries model in the body.
  let outgoingBody =
    p !== "gemini-generate" && r.upstreamModel && r.upstreamModel !== model
      ? { ...req.body, model: r.upstreamModel }
      : req.body;

  // Pin gpt-5.6-family FreeModel requests, AND every api.b.ai-hosted model
  // (deepseek-v4-flash-vision-exp, glm-5.3-flash, qwen3.8-flash -- added
  // 2026-08-28), to a stable per-session cache key so best-effort implicit
  // caching has a real chance of hitting on every step, not just when luck
  // lands us on the same backend machine.
  //
  // Found 2026-08-28: confirmed live (two sequential direct calls via the
  // admin reasoning-probe route, same >1024-token prefix) that all three
  // api.b.ai models DO cache correctly when repeat requests land on the
  // same backend -- cached_tokens went from 0 to ~2048/1920 on the second
  // call. So "these models don't cache in production" is the exact same
  // root cause as the gpt-5.6 bug this key was built for: nothing sent a
  // session-affinity hint, so concurrent real users' requests scatter
  // across api.b.ai's backend replicas instead of reliably landing warm.
  // Matched by upstreamBaseURL rather than by provider, since api.b.ai's
  // three routes are labelled with three different provider values
  // (deepseek/zai/qwen, matching each model's real creator for pricing
  // purposes) despite sharing one physical backend that needs the same
  // affinity treatment.
  //
  // Scoped to openai-chat only (not blanket-applied) since that protocol
  // label is also used for Claude routes proxied through a translation
  // layer that may not tolerate -- or even want -- an OpenAI-specific field.
  if (p === "openai-chat" && needsSessionAffinity(r.provider, model, r.upstreamBaseURL) && !outgoingBody.prompt_cache_key) {
    const cacheKey = derivePromptCacheKey(req.body);
    if (cacheKey) outgoingBody = { ...outgoingBody, prompt_cache_key: cacheKey };
  }

  // Transparent Gemini explicit context caching (see gemini-cache.js for
  // the full rationale): if this request carries a systemInstruction big
  // enough to be cache-eligible, swap it out for a `cachedContent`
  // reference so the (large, byte-identical-every-turn) system prompt gets
  // Google's *guaranteed* cache-read discount instead of relying on
  // best-effort implicit caching. Any failure here is swallowed --
  // outgoingBody just falls back to the original, unmodified body.
  if (p === "gemini-generate" && outgoingBody?.systemInstruction) {
    try {
      const cachedContentName = await getOrCreateCachedContent({
        model: r.upstreamModel || model,
        systemInstruction: outgoingBody.systemInstruction,
        apiKey: key,
      });
      if (cachedContentName) {
        const { systemInstruction: _drop, ...rest } = outgoingBody;
        outgoingBody = { ...rest, cachedContent: cachedContentName };
      }
    } catch (e) {
      console.error(JSON.stringify({ type: "gemini_cache_wire_error", model, message: e.message }));
    }
  }

  // Abort the upstream fetch on the hard timeout OR as soon as the client
  // disconnects (res close) -- without this, an abandoned SSE stream keeps
  // consuming upstream provider tokens until the timeout fires.
  const upstreamAbort = createUpstreamAbort({
    req,
    res,
    requestId: id,
    model,
    protocol: p,
    provider,
    timeoutMs: Number(r.timeoutMs || process.env.UPSTREAM_TIMEOUT_MS || 120000),
  });

  try {
    const response = await fetch(upstreamUrl(r, p, model, action), {
      method: "POST",
      headers: headers(r, p),
      body: JSON.stringify(outgoingBody),
      signal: upstreamAbort.signal,
    });

    if (response.status >= 500 || response.status === 429) {
      const text = await response.text();
      defer(recordBreakerFailure(breakerId, model));
      // Record the real upstream status against this model (not just an
      // anonymous provider-level error) so failed attempts on one model
      // (e.g. a circuit-tripping route) don't show up as unexplained
      // provider errors sitting next to a different model's clean 2xx row.
      recordUpstreamError(provider, model);
      recordRequest(provider, model, response.status, Date.now() - started, ttft, null, null, isFallback);
      const e = new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`);
      e.retryable = true;
      throw e;
    }

    res.status(response.status).set("x-gateway-request-id", id);
    for (const [k, v] of response.headers)
      if (forwardableResponseHeader(k))
        res.setHeader(k, v);
    // The upstream's own request id is useful for provider-side support
    // tickets, but it must not share the gateway's header name -- an operator
    // reading `x-gateway-request-id` has to be able to trust it identifies OUR
    // request, and a provider echoing back a value of its choosing would let a
    // hostile upstream forge correlation ids (and poison log joins).
    const upstreamRequestId = response.headers.get("x-request-id");
    if (upstreamRequestId) res.setHeader("x-upstream-request-id", upstreamRequestId);
    // "x-request-id" is deliberately NOT in the allowlist: it is read here and
    // re-emitted under the gateway's own name above, so it can never arrive at
    // the client under a header that looks like it might be ours.

    let usage = null;
    const contentType = response.headers.get("content-type") || "";

    if (!response.body || !contentType.includes("text/event-stream")) {
      const text = await response.text();
      try { usage = usageOf(JSON.parse(text)); } catch {}
      res.send(text);
    } else {
      streaming = true;
      const streamLease = beginActiveLease("streams", `${leaseId}:s`);
      defer(streamLease.then(() => endActiveLease("streams", `${leaseId}:s`)).catch(() => {}));
      const reader = response.body.getReader();
      // Persistent decoder + carry-over buffer: an SSE "data: {...}" frame
      // (especially the final one carrying usage) can land split across two
      // separate reader.read() chunks at the TCP level. Decoding each chunk
      // in isolation and splitting on \n without keeping the trailing
      // partial line meant that split frame silently failed JSON.parse and
      // got swallowed by the catch -- usage (and any other data in that
      // frame) was just lost. Buffering the leftover across iterations and
      // using {stream:true} on the decoder for multi-byte-safe decoding
      // fixes this.
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        if (upstreamAbort.isAborted()) {
          // Client is gone: cancel the reader so the upstream connection is
          // released immediately instead of draining the rest of the stream.
          try { await reader.cancel("Client disconnected"); } catch {}
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (ttft === null) ttft = Date.now() - started;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the last (possibly incomplete) line for next round
        for (const line of lines)
          if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
            try { usage = mergeUsage(usage, usageOf(JSON.parse(line.slice(5).trim()))); } catch {}
        res.write(value);
      }
      // Flush any trailing partial line left in the buffer after the stream ends.
      if (buffer.startsWith("data:") && buffer.slice(5).trim() !== "[DONE]")
        try { usage = mergeUsage(usage, usageOf(JSON.parse(buffer.slice(5).trim()))); } catch {}
      res.end();
    }

    const latencyMs = Date.now() - started;
    const estimatedCost = costOf(r, usage);
    // Feed metrics the SAME normalized (protocol-corrected) token
    // breakdown costOf() just billed against, not the raw usageOf()
    // output -- otherwise metrics-store's cacheHitRate would need to
    // re-derive the Anthropic-additive-vs-subset distinction itself at
    // read time with no protocol info available, which is exactly the
    // bug that regressed DeepSeek's hit rate (89.94% -> 47.35%) when
    // cacheHitRate's formula was first generalized. See cacheBreakdownOf().
    const normalizedUsage = usage ? { ...usage, input: cacheBreakdownOf(r, usage).uncachedInput, cache_read: cacheBreakdownOf(r, usage).cacheRead, cache_write: cacheBreakdownOf(r, usage).cacheWrite } : usage;

    defer(recordBreakerSuccess(breakerId, model));
    recordRequest(provider, model, response.status, latencyMs, ttft, normalizedUsage, estimatedCost, isFallback);
    log({ requestId: id, model, protocol: p, provider, status: response.status, latencyMs, ttftMs: ttft, usage: normalizedUsage, cache: cacheSummary(normalizedUsage), estimatedCost, isFallback });
  } catch (e) {
    // The 5xx/429 branch records the failure before throwing so it can retain
    // the real upstream status. Only network-level failures reach this catch
    // unrecorded; counting retryable responses again would trip the breaker
    // twice per failed attempt and double the upstream-error metric.
    if (upstreamAbort.reason() === "client") {
      // The CALLER hung up (abandoned request or mid-stream disconnect).
      // Record the attempt (status 0) so volume still reconciles, but no
      // breaker failure and no upstream error: the provider did nothing
      // wrong, and counting client aborts against it opened breakers on
      // healthy providers and polluted upstream_errors.
      recordRequest(provider, model, 0, Date.now() - started, ttft, null, null, isFallback);
    } else if (!e.retryable && !e.configError) {
      defer(recordBreakerFailure(breakerId, model));
      recordUpstreamError(provider, model);
      recordRequest(provider, model, 0, Date.now() - started, ttft, null, null, isFallback);
    } else if (e.configError) {
      // Config errors are deterministic GATEWAY-side problems (missing
      // secret / invalid upstream URL): count the attempt for observability
      // but neither the breaker nor upstream_errors -- the provider was
      // never validly called (handle()'s catch skips the breaker for
      // configError too, so exactly one recordRequest lands per attempt).
      recordRequest(provider, model, 0, Date.now() - started, ttft, null, null, isFallback);
    }
    throw e;
  } finally {
    upstreamAbort.cleanup();
  }
}

async function handle(req, res) {
  // Reuse the id minted by the request-id middleware so the header the client
  // already received and every log line from here on agree. Falling back to a
  // fresh id keeps this correct even if handle() is ever invoked without that
  // middleware (e.g. mounted directly in a test).
  const id = res.locals?.requestId || `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const p = protocol(req.path);
  let model = modelFor(req, p);
  // Accept legacy ":free"-suffixed client requests too: they route to the
  // same stripped public id, so old callers keep working after the public
  // catalog switched to clean ids.
  if (typeof model === "string" && FREE_ID_SUFFIX_RE.test(model)) model = model.replace(FREE_ID_SUFFIX_RE, "");
  const action = actionFor(req, p);
  if (!model) return res.status(400).json({ error: { type: "ModelError", message: "A model is required." } });
  const available = candidates(model, p);
  if (!available.length) return res.status(404).json({ error: { type: "ModelError", message: `No ${p} route is configured for ${model}.` } });
  // SECURITY: reject a non-object JSON body (e.g. `"hi"` or `[1,2]`, which
  // express.json happily parses) before it reaches proxy(). There, the model
  // substitution does `{ ...req.body, model }` -- spreading a string explodes
  // into {"0":"h","1":"i"} and sends garbage upstream; worse, a huge array
  // body would be re-serialized per candidate. A clean 400 keeps this
  // OpenAI-compatible endpoint behaving like one.
  if (req.body !== undefined && (typeof req.body !== "object" || req.body === null || Array.isArray(req.body))) {
    return res.status(400).json({ error: { type: "InvalidRequestError", message: "Request body must be a JSON object." } });
  }
  const failures = [];
  // Providers whose routes are known-bad for THIS request (missing secret /
  // invalid upstream URL) -- deterministic config errors, skip immediately.
  const brokenProviders = new Set();
  // Rejection accounting so the final status can distinguish "every route
  // was refused locally by its circuit breaker" (gateway-side: 503) from
  // "we really called upstream and it failed" (502), per the counting rules
  // in the README.
  let openCircuitRejections = 0;
  let otherFailures = 0;
  // STABILITY: one breaker/metrics identity per model id, regardless of how
  // many provider routes serve it. Every failure path in this handler and in
  // proxy() records against THIS key rather than the individual candidate's
  // provider label -- otherwise a fallback chain of N failing providers
  // counts N failures against a threshold tuned for one-per-request, and a
  // primary outage silently opens the backup's circuit too (cascading
  // failover death). A single-route model behaves exactly as before.
  const cbProvider = `model:${model}`;
  for (let i = 0; i < available.length; i++) {
    // A previous candidate already sent headers (and possibly streamed
    // partial body bytes) to the real client before failing mid-stream.
    // Retrying here would call res.setHeader() on an already-sent
    // response and throw ERR_HTTP_HEADERS_SENT, which used to get
    // silently swallowed by the catch below as "just another failure" --
    // leaving the client connection half-written and never closed. Fail
    // closed instead: stop trying candidates and cleanly end the stream.
    if (res.headersSent) {
      console.error(JSON.stringify({ type: "upstream_mid_stream_failure", requestId: id, model, protocol: p, failures }));
      break;
    }
    const r = available[i];
    const provider = r.provider || r.upstreamApiKeyEnv || "unknown";
    if (brokenProviders.has(provider)) {
      failures.push(`${provider}: skipped (known-bad configuration)`);
      otherFailures += 1;
      continue;
    }
    // isCircuitOpen() is guaranteed to never throw (fails open internally
    // in metrics-store.js) -- this bare await used to be the actual cause
    // of real requests hanging until Vercel's 300s function timeout during
    // a 2026-08-27 Upstash rate-limit incident, since it sat outside the
    // try/catch below with nothing to catch a raw Redis error escaping it.
    if (available.length > 1 && (await isCircuitOpen(cbProvider, model))) {
      openCircuitRejections += 1;
      continue; // skip open circuits if alternatives exist
    }
    try {
      await proxy(req, res, r, p, model, action, id, i > 0, cbProvider);
      return;
    } catch (e) {
      // proxy() owns ALL breaker/metrics recording for real upstream failures
      // (5xx/429 inline, network/stream errors in its own catch, circuit-open
      // before the try). This handler must NOT re-record them or every failure
      // would count twice against the breaker and metrics. What stays here is
      // only bookkeeping proxy() couldn't do: the client-facing failure line
      // and marking a known-bad provider to skip its duplicate routes.
      if (e.configError) {
        // Deterministic config error (missing secret / invalid upstream URL):
        // never counted against the breaker, and the env-var name stays
        // server-side only -- the client-facing list gets a generic line.
        failures.push(`${provider}: configuration error`);
        console.error(JSON.stringify({ type: "upstream_config_error", requestId: id, model, protocol: p, provider, error: e.message }));
        brokenProviders.add(provider);
        otherFailures += 1;
      } else {
        failures.push(`${provider}: ${redactUpstreamDetail(e.message)}`);
        console.error(JSON.stringify({ type: "upstream_failure", requestId: id, model, protocol: p, provider, error: e.message }));
        if (e.circuitOpen) openCircuitRejections += 1;
        else otherFailures += 1;
      }
    }
  }
  // Persist this request's queued metrics. On Vercel this registers the
  // window flush with the invocation's waitUntil so the runtime stays alive
  // until the batch containing this request's events is written; on
  // long-lived processes it flushes immediately (a no-op when the queue is
  // empty). See metrics-store.js's micro-batcher.
  defer(flushPendingWrites());
  if (!res.headersSent) {
    if (openCircuitRejections > 0 && otherFailures === 0) {
      // Every candidate was refused locally by its circuit breaker -- no
      // upstream was contacted on this request, so a 502 "All compatible
      // upstream routes failed" would misattribute a gateway-side rejection
      // to the providers. 503 + Retry-After matched to the breaker cooldown
      // is the honest classification (and what retry-aware clients expect).
      res.setHeader("Retry-After", String(Math.ceil(CB_COOLDOWN_MS / 1000)));
      res.status(503).json({ error: { type: "ServiceUnavailableError", message: `All routes for ${model} are temporarily unavailable: circuit breaker open after repeated upstream failures.`, requestId: id, failures } });
    } else {
      res.status(502).json({ error: { type: "UpstreamError", message: "All compatible upstream routes failed.", requestId: id, failures } });
    }
  } else if (!res.writableEnded) {
    // Headers (and likely partial body) already went out on a prior
    // candidate that then failed mid-stream. There is no way to signal
    // an error to the client inside an already-started SSE/JSON stream,
    // so the best we can do is close the connection cleanly instead of
    // leaving it hanging open forever.
    res.end();
  }
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// LIVENESS: is this process alive and able to serve? Must be a pure
// in-process check -- no database, no network, no upstream. An orchestrator's
// liveness probe restarts the container when this fails, so a slow or
// unavailable metrics DB must never be able to take down a gateway that is
// otherwise serving traffic perfectly well. Previously /health was the only
// probe and it did live Postgres reads first, which is exactly the coupling
// that turns a metrics outage into a restart loop.
app.get("/health/live", (_req, res) => {
  res.json({
    ok: true,
    status: "alive",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// READINESS: can this instance usefully serve proxied traffic? Distinguishes
// "process is up" from "process has a usable route table", so an orchestrator
// can hold traffic until configuration has loaded instead of burning user
// requests on 404s during a cold start. Deliberately does NOT probe providers
// or the metrics DB: both are allowed to be degraded without the instance
// being unable to do its job, and the circuit breakers already handle that at
// request time.
app.get("/health/ready", (_req, res) => {
  const allRoutes = routes();
  const ready = allRoutes.length > 0;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    status: ready ? "ready" : "no-routes",
    routes: allRoutes.length,
    routedModels: [...new Set(allRoutes.map(r => r.id))].length,
    // Build identity so an operator can tell which deploy is actually serving
    // instead of matching timestamps by hand. GIT_SHA / VERCEL_GIT_COMMIT_SHA
    // are injected by the platform; the rest fall back rather than lying.
    version: process.env.GATEWAY_VERSION || undefined,
    gitSha: process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    bootedAt: new Date(startTime).toISOString(),
  });
});

// Detailed health (unchanged shape, still does live reads). Kept at /health so
// existing dashboards and uptime checks keep working.
app.get("/health", async (_req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const [activeRequests, activeStreams, cbDetails] = await Promise.all([
    countActiveLeases("requests"),
    countActiveLeases("streams"),
    getAllCircuitBreakers(),
  ]);
  const circuitBreakers = {};
  for (const [key, cb] of Object.entries(cbDetails)) circuitBreakers[key] = cb.state;
  res.json({
    ok: true,
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    routes: allRoutes.length,
    routedModels: [...new Set(allRoutes.map(r => r.id))],
    providers: configuredProviders,
    circuitBreakers,
    // Leases alive right now: genuinely in-flight upstream attempts /
    // streams, self-healing (see beginActiveLease) -- the old +/- gauge
    // drifted to thousands on dropped decrements.
    activeRequests,
    activeStreams,
    metricsBackend: usingDb() ? "postgres" : "in-memory (single instance only)",
    version: process.env.GATEWAY_VERSION || undefined,
    gitSha: process.env.GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    bootedAt: new Date(startTime).toISOString(),
  });
});

app.get("/metrics", metricsAuth, async (req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const configuredModels = [...new Set(allRoutes.map(r => r.id))];

  // ?daily=global trims the daily-history payload to the scope the built-in
  // dashboard renders (the entry-agents dashboard consumes the unfiltered
  // shape and does not pass this param, so its behavior is unchanged).
  const dailyScope = ["global", "provider", "model"].includes(req.query.daily) ? req.query.daily : undefined;
  const snapshot = await getMetricsSnapshot(configuredProviders, configuredModels, { dailyScope });

  // Attach estimatedCacheSavingsUsd per model: what those cacheRead tokens
  // WOULD have cost at the route's full input rate, minus what they
  // actually cost at the route's real cache-read rate (same precedence --
  // explicit cost.cache_read first, else the CACHE_RATE_MULTIPLIERS_BY_PREFIX
  // fallback, else full input rate / no discount at all) -- reuses
  // cacheRateMultipliersFor so this can never drift from what costOf()
  // actually billed. Only meaningful per-model (a single, known cost
  // config); global/byProvider mix models with different rates, so no
  // savings figure is attached there.
  for (const [modelId, bucket] of Object.entries(snapshot.byModel)) {
    const route = allRoutes.find(r => r.id === modelId);
    const cacheRead = bucket.tokens.cacheRead || 0;
    if (!route?.cost?.input || cacheRead === 0) {
      bucket.estimatedCacheSavingsUsd = 0;
      continue;
    }
    const fallback = cacheRateMultipliersFor(route.id);
    const cacheReadRate = route.cost.cache_read ?? (fallback ? route.cost.input * fallback.cacheRead : route.cost.input);
    bucket.estimatedCacheSavingsUsd = Number((((route.cost.input - cacheReadRate) * cacheRead) / 1e6).toFixed(6));
  }

  res.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    ...snapshot,
    metricsBackend: usingDb() ? "postgres" : "in-memory (single instance only)",
    // Explicit metric definitions so every consumer (and operator) reads
    // these numbers the same way they are produced. Additive metadata only.
    definitions: {
      upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
      requests: "upstream attempts, one record per candidate tried (fallback attempts included); a client request that exhausted N routes counts N - use requests minus fallbacks for an approximation of client-visible requests",
      status0: "status code 0 marks an attempt that produced no upstream response: client disconnect, timeout, circuit-open rejection, or gateway config error",
      upstreamErrors: "attempts that failed against an actual upstream: 5xx/429 responses, transport errors, and timeouts - excludes client disconnects, circuit-open rejections, and gateway config errors",
      activeRequests: "upstream attempts with a live lease right now (self-healing; see ACTIVE_LEASE_TTL_MS)",
      activeStreams: "streaming responses with a live lease right now",
      latency: `percentiles (nearest-rank) plus arithmetic mean (avg), over the most recent ${500} recorded attempts per bucket`,
      tokens: "input is uncached-only input; cacheRead/cacheWrite are separate buckets; total = input + cacheRead + cacheWrite + output",
      estimatedSpend: "estimate from each route's configured per-million prices times recorded tokens - not a provider invoice",
      dayBoundary: "Africa/Lagos (WAT, UTC+1, no DST) - daily rollups start at 12am WAT",
      dailyRetention: "unbounded (gw_metrics_daily rows are never deleted)",
    },
  });
});

// Resolves a route's exposed `cost` so cache_read/cache_write are never
// left undefined when a route only qualifies for the FALLBACK multiplier
// (see CACHE_RATE_MULTIPLIERS_BY_PREFIX above) instead of its own explicit
// rate. CRITICAL FIX 2026-08-19: this endpoint used to return `r.cost`
// completely raw -- costOf() (real billing, this file) resolves the
// fallback internally, but the entry-agents app's OWN cost estimator
// (apps/web/lib/models.ts, `estimateModelUsageCost`) fetches this exact
// /v1/models response as its pricing source, for BOTH the UI's displayed
// "Usage breakdown" estimate AND the actual credit-ledger debit
// (apps/web/app/workflows/chat-post-finish.ts, debitForModelUsage) --
// there is no separate real-billing path on the app side. With
// cache_read left undefined for gpt-5.6-*, its estimator's own
// `costTier?.cache_read ?? inputPrice` fallback silently billed 100% of
// cached tokens at the FULL input rate, for real, out of users' actual
// credit balance -- not just a display glitch. Confirmed against real
// usage data: an 88-step gpt-5.6-luna session with 9.5M of 11.9M input
// tokens cache-hit was billed ~$2.43 (full-price-equivalent) instead of
// the correct ~$0.75 with the discount applied. Baking the resolved rate
// in here fixes both call sites (display + real debit) with one change,
// without touching either of the app's cost-estimation functions.
function resolvedCostFor(r) {
  if (!r.cost) return r.cost;
  const fallback = cacheRateMultipliersFor(r.id);
  if (!fallback) return r.cost;
  const resolved = {
    ...r.cost,
    cache_read: r.cost.cache_read ?? (r.cost.input || 0) * fallback.cacheRead,
    cache_write: r.cost.cache_write ?? (r.cost.input || 0) * fallback.cacheWrite,
  };
  // Also resolve cache_read/cache_write inside every context_over_Nk tier
  // object, using THAT TIER's own (possibly higher) input rate -- not the
  // base rate -- for the fallback multiplier. Added 2026-08-19 alongside
  // the app-side fix that made resolveCostTier() (apps/web/lib/models.ts)
  // actually match tiers other than the hardcoded 200k one: without this,
  // a large-context gpt-5.6 request crossing into its 272k tier would
  // apply the tier's higher input/output rate but still get the BASE
  // tier's cache_read rate (e.g. luna's $0.02, from 0.1x of the $0.20
  // base input) instead of the correct $0.04 (0.1x of the tier's $0.40
  // input) -- a smaller, second-order version of the same
  // undiscounted-relative-to-the-right-rate class of bug.
  for (const key of Object.keys(resolved)) {
    if (!CONTEXT_TIER_KEY_RE.test(key)) continue;
    const tier = resolved[key];
    if (!tier || (typeof tier.input !== "number" && typeof tier.output !== "number")) continue;
    const tierInput = typeof tier.input === "number" ? tier.input : r.cost.input || 0;
    resolved[key] = {
      ...tier,
      cache_read: tier.cache_read ?? (tierInput * fallback.cacheRead),
      cache_write: tier.cache_write ?? (tierInput * fallback.cacheWrite),
    };
  }
  return resolved;
}

app.get("/v1/models", modelsAuth, (_req, res) => {
  const m = new Map();
  for (const r of routes().filter((r) => r.enabled !== false)) {
    const x = m.get(r.id) || { id: r.id, object: "model", name: r.name || r.id, owned_by: r.provider || "gateway", protocols: [], context_window: r.context_window, cost: resolvedCostFor(r) };
    if (!x.protocols.includes(r.protocol)) x.protocols.push(r.protocol);
    m.set(r.id, x);
  }
  res.json({ object: "list", data: [...m.values()] });
});

app.post("/v1/chat/completions", auth, spendLimitGuard, bodySizeGuard, handle);
app.post("/v1/messages", auth, spendLimitGuard, bodySizeGuard, handle);
app.post("/v1beta/models/:modelAction", auth, spendLimitGuard, bodySizeGuard, handle);

app.get("/v1/debug/routes", metricsAuth, (_req, res) => {
  res.json({
    routes: routes().map(r => ({
      id: r.id,
      protocol: r.protocol,
      provider: r.provider,
      upstreamBaseURL: r.upstreamBaseURL,
      upstreamModel: r.upstreamModel || r.id,
      upstreamApiKeyEnv: r.upstreamApiKeyEnv,
      priority: r.priority ?? 100,
      enabled: r.enabled !== false,
      cost: r.cost,
      context_window: r.context_window,
      source: discovered.includes(r) ? "discovered" : "configured",
    })),
  });
});

// ─── Dashboard + landing redirect ─────────────────────────────────────────────
// The admin dashboard and the public landing page moved to the dedicated
// Next.js app (dashboard/, deployed as its own Vercel project with its own
// OTP-based authentication). The gateway is an API surface only now: these
// routes redirect humans to the dashboard (when DASHBOARD_PUBLIC_URL is
// configured) and answer 410 Gone otherwise. No HTML is served from the
// gateway anymore, and no session cookie is ever issued by it.
const dashboardUrl = () => (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/+$/, "");
const serveRedirectToDashboard = (_req, res) => {
  const url = dashboardUrl();
  if (!url) return res.status(410).json({ error: { type: "GoneError", message: "The gateway HTML dashboard was removed. Configure DASHBOARD_PUBLIC_URL to redirect to the new dashboard." } });
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url + "/");
};

app.get("/", serveRedirectToDashboard);
app.get("/admin", serveRedirectToDashboard);

// Catch-all 404 in JSON: no route serves HTML anymore, so Express's default
// HTML 404 page must never appear on this API surface.
app.use((_req, res) => {
  res.status(404).json({ error: { type: "NotFoundError", message: "Unknown API route." } });
});


// ─── Error handling ─────────────────────────────────────────────────────────
// Express's default error handler returns an HTML page (with a stack trace
// when NODE_ENV != production) for anything that reaches it -- malformed JSON
// from express.json, unexpected middleware throws, etc. Everything else in
// this API answers with OpenAI-shaped JSON errors, so normalize here and
// never leak internals to clients. Must be registered AFTER all routes.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (res.headersSent) return res.end();
  const status = Number(err?.status || err?.statusCode) || 500;
  // Body-too-large is a real, expected condition on a proxy accepting big
  // prompts; report it as a clean 413 instead of a generic 500.
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { type: "InvalidRequestError", message: "Request body exceeds the maximum allowed size." } });
  }
  if (status === 400 && (err?.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: { type: "InvalidRequestError", message: "Request body is not valid JSON." } });
  }
  console.error(JSON.stringify({ type: "unhandled_error", error: err instanceof Error ? err.message : String(err) }));
  res.status(status === 400 ? 400 : 500).json({ error: { type: "GatewayError", message: status === 400 ? "Bad request." : "Internal gateway error." } });
});

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discover() {
  const sources = parseJson("MODEL_DISCOVERY_JSON", []);
  if (!Array.isArray(sources)) return;
  const fresh = [];
  for (const s of sources) try {
    if (!s || typeof s.url !== "string" || !isHttpUpstream(s.url)) {
      console.error(`Discovery skipped for ${s?.provider || String(s?.url)}: url must be a valid http(s) URL`);
      continue; // never let one malformed source entry abort the whole round
    }
    const key = process.env[s.apiKeyEnv]; if (!key) continue;
    const response = await fetch(s.url, { headers: { Authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json(), list = Array.isArray(body) ? body : body.data || body.models || [];
    for (const item of list) {
      const upstreamModel = typeof item === "string" ? item : item.id || item.name;
      if (!upstreamModel) continue;
      for (const p of s.protocols || ["openai-chat"])
        fresh.push(normalizeRouteFreeId({ id: s.aliases?.[upstreamModel] || upstreamModel, upstreamModel, protocol: p, provider: s.provider, upstreamBaseURL: s.baseURL, upstreamApiKeyEnv: s.apiKeyEnv, priority: s.priority ?? 100, cost: s.cost, context_window: item.context_window || s.context_window }));
    }
  } catch (e) { console.error(`Discovery failed for ${s.provider || s.url}: ${e.message}`); }
  // STABILITY: if EVERY source errored this round, treat it as a transient
  // discovery-endpoint outage and keep the previous catalog instead of
  // atomically wiping every discovered route until the next refresh window.
  const allFailed = sources.length > 0 && fresh.length === 0;
  if (allFailed && discovered.length > 0) {
    console.error(JSON.stringify({ type: "discovery_all_sources_failed", keeping: discovered.length }));
    return;
  }
  discovered = fresh;
  console.log(`Discovered ${fresh.length} model/protocol routes`);
}

await discover();
setInterval(discover, Number(process.env.DISCOVERY_REFRESH_MS || 21600000)).unref();

// Validate the operator's route/discovery configuration once at startup.
// Deliberately runs AFTER the first discover() so the report covers the full
// effective route set, and deliberately does not throw: a malformed route
// must not stop the gateway from booting and serving the routes that are
// valid. Everything it reports is a problem that would otherwise only ever
// surface as a user-visible 502 on the first request that hits it.
validateStartupConfig({
  routeSources: [
    ["MODEL_ROUTES_JSON", parseJson("MODEL_ROUTES_JSON", [])],
    ["EXTRA_MODEL_ROUTES_JSON", parseJson("EXTRA_MODEL_ROUTES_JSON", [])],
    ["EXTRA_MODEL_ROUTES_JSON_2", parseJson("EXTRA_MODEL_ROUTES_JSON_2", [])],
    ["EXTRA_MODEL_ROUTES_JSON_3", parseJson("EXTRA_MODEL_ROUTES_JSON_3", [])],
    ["EXTRA_MODEL_ROUTES_JSON_4", parseJson("EXTRA_MODEL_ROUTES_JSON_4", [])],
    ["EXTRA_MODEL_ROUTES_JSON_5", parseJson("EXTRA_MODEL_ROUTES_JSON_5", [])],
    ["EXTRA_MODEL_ROUTES_JSON_6", parseJson("EXTRA_MODEL_ROUTES_JSON_6", [])],
    ["EXTRA_MODEL_ROUTES_JSON_7", parseJson("EXTRA_MODEL_ROUTES_JSON_7", [])],
  ],
  discoverySources: parseJson("MODEL_DISCOVERY_JSON", []),
});

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`Entry Gateway listening on :${PORT}; models=${[...new Set(routes().map(r => r.id))].join(",") || "none"}`));
  // LONG STREAMS: Node's default requestTimeout (300s) kills legitimately
  // long streaming completions (max-reasoning turns can run longer). The
  // upstream hard timeout (route timeoutMs / UPSTREAM_TIMEOUT_MS) already
  // governs every proxied request, so the HTTP server layer must not impose
  // a second, tighter ceiling. headersTimeout stays at its default so slow
  // clients cannot hold headers forever; an idle keep-alive socket still
  // times out normally. Vercel enforces its own maxDuration regardless.
  server.requestTimeout = 0;

  // STABILITY: graceful shutdown for the self-hosted/Docker path. On SIGTERM
  // (docker stop, orchestrator rollout) stop accepting new connections, give
  // in-flight proxied requests a bounded window to finish -- these can be
  // long streaming calls -- then force-close so the process never hangs the
  // container's kill timeout.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ type: "shutdown_start", signal }));
    const forceTimer = setTimeout(() => {
      console.error(JSON.stringify({ type: "shutdown_force_close" }));
      server.closeAllConnections?.();
      process.exit(0);
    }, Number(process.env.SHUTDOWN_GRACE_MS || 30000)).unref();
    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) { console.error(JSON.stringify({ type: "shutdown_error", error: err.message })); process.exit(1); }
      console.log(JSON.stringify({ type: "shutdown_complete" }));
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Crash loudly rather than limping along in an undefined state: Node 20
  // already throws on unhandled rejections by default, but that surfaces as
  // an opaque stack trace; log a structured line and exit non-zero so
  // supervisors/containers restart cleanly with full context in the logs.
  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({ type: "unhandled_rejection", error: reason instanceof Error ? reason.message : String(reason) }));
    process.exit(1);
  });
}
export default app;
