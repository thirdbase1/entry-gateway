import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  recordRequest,
  recordUpstreamError,
  recordBreakerFailure,
  recordBreakerSuccess,
  isCircuitOpen,
  incrGauge,
  getGauge,
  getMetricsSnapshot,
  getAllCircuitBreakers,
  usingRedis,
} from "./metrics-store.js";
import { getOrCreateCachedContent } from "./gemini-cache.js";

const app = express();
// Vercel (and most PaaS) terminate TLS upstream and forward to this
// process over plain HTTP, setting X-Forwarded-Proto: https. Without
// trusting the proxy, Express's req.protocol always reports "http" even
// on a real https:// request -- which made the /admin auto-inject below
// emit an http:// gateway-url, and a browser on the https admin page
// mixed-content-blocks any fetch() to a plain http:// URL (shows up as
// yet another opaque "Failed to fetch").
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));

// CORS: the settings/gateway dashboard on entry-agents.vercel.app calls
// /health, /metrics, /v1/models, /v1/debug/routes directly from the
// browser (client component, no Next.js proxy route in between). Express
// sends no CORS headers by default, so every one of those cross-origin
// fetch() calls was silently blocked by the browser and surfaced to the
// user as a generic "Failed to fetch" -- even with a correct gateway URL
// and API key, since the request never actually reached this server for
// GET requests, and for the CORS preflight OPTIONS it got a 404 with no
// Access-Control-Allow-* headers. Reflecting a small allowlist of known
// dashboard origins (plus localhost for local dev) fixes this without
// opening the API itself to arbitrary origins.
const ALLOWED_ORIGINS = new Set([
  "https://entry-agents.vercel.app",
  "https://entry-agents-thirdbase1s-projects.vercel.app",
  "https://entry-agents-oneshotsx-thirdbase1s-projects.vercel.app",
  "http://localhost:3000",
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || /\.vercel\.app$/.test(new URL(origin).hostname))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
const PORT = Number(process.env.PORT || 8787);
let discovered = [];

const parseJson = (name, fallback) => {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch (e) { console.error(`${name}: invalid JSON: ${e.message}`); return fallback; }
};
const keys = () => new Set((process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean));
const adminKeys = () => new Set((process.env.ADMIN_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean));
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
const configured = () => [
  ...(Array.isArray(parseJson("MODEL_ROUTES_JSON", [])) ? parseJson("MODEL_ROUTES_JSON", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_2", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_2", []) : []),
  ...(Array.isArray(parseJson("EXTRA_MODEL_ROUTES_JSON_3", [])) ? parseJson("EXTRA_MODEL_ROUTES_JSON_3", []) : []),
].filter(r => r?.id && r?.upstreamBaseURL).map(r => ({ protocol: "openai-chat", priority: 100, enabled: true, ...r }));
const routes = () => {
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
};
const auth = (req, res, next) => {
  const supplied = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  const valid = keys();
  if (!valid.size) return res.status(500).json({ error: { type: "ConfigError", message: "GATEWAY_API_KEYS is not configured." } });
  if (!valid.has(supplied)) return res.status(401).json({ error: { type: "AuthError", message: "Invalid or missing API key." } });
  next();
};
const adminAuth = (req, res, next) => {
  const supplied = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  const valid = keys();
  const admins = adminKeys();
  if (!valid.size && !admins.size) return res.status(500).json({ error: { type: "ConfigError", message: "No keys configured." } });
  if (admins.size && admins.has(supplied)) return next();
  if (valid.has(supplied)) return next();
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
  return idx === -1 ? "generateContent" : raw.slice(idx + 1);
};
const candidates = (model, p) => routes().filter(r => r.id === model && r.protocol === p && r.enabled !== false).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
const upstreamUrl = (r, p, model, action) => {
  const base = r.upstreamBaseURL.replace(/\/$/, "");
  const geminiAction = action || "generateContent";
  const path = r.upstreamPath || (p === "openai-chat" ? "/chat/completions" : p === "anthropic-messages" ? "/messages" : `/models/${encodeURIComponent(r.upstreamModel || model)}:${geminiAction}`);
  const url = `${base}${path.replace("{model}", encodeURIComponent(r.upstreamModel || model))}`;
  // Gemini's SSE framing (data: {...} lines, matching the OpenAI/Anthropic
  // shape this gateway's SSE parsing loop already understands) is opt-in
  // via ?alt=sse -- without it, streamGenerateContent returns a bare JSON
  // array instead.
  return p === "gemini-generate" && geminiAction === "streamGenerateContent" ? `${url}?alt=sse` : url;
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

const costOf = (r, u) => {
  if (!u || !r.cost) return null;
  // u.input from usageOf() is the request's TOTAL prompt token count
  // (OpenAI/Anthropic/Gemini all report cached tokens as a SUBSET of this,
  // not an addition to it), so it's already the right value to compare
  // against a model's total-context pricing tier -- no need to add
  // cache_read/cache_write back in.
  const cost = tieredCost(r.cost, u.input || 0);
  const cacheRead = Math.min(u.cache_read || 0, u.input || 0);
  const cacheWrite = Math.min(u.cache_write || 0, Math.max(0, (u.input || 0) - cacheRead));
  const uncachedInput = Math.max(0, (u.input || 0) - cacheRead - cacheWrite);
  const fallbackMultipliers = cacheRateMultipliersFor(r.id);
  const cacheReadRate = cost.cache_read ?? (fallbackMultipliers ? (cost.input || 0) * fallbackMultipliers.cacheRead : (cost.input || 0));
  const cacheWriteRate = cost.cache_write ?? (fallbackMultipliers ? (cost.input || 0) * fallbackMultipliers.cacheWrite : (cost.input || 0));
  return ((uncachedInput / 1e6) * (cost.input || 0) + (cacheRead / 1e6) * cacheReadRate + (cacheWrite / 1e6) * cacheWriteRate + ((u.output || 0) / 1e6) * (cost.output || 0)) * (r.billingMultiplier ?? 1);
};

// ─── Metrics + circuit breakers ──────────────────────────────────────────────
//
// Durable, cross-instance state now lives in metrics-store.js (Redis via
// Upstash REST when KV_REST_API_URL/KV_REST_API_TOKEN are set, otherwise
// an in-memory fallback for local dev). See that file for why: this
// process runs as stateless Vercel serverless functions, so a plain
// module-level object here would only ever reflect one instance's slice
// of traffic instead of the gateway's real, aggregate usage.

const startTime = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = x => process.env.REQUEST_LOG !== "false" && console.log(JSON.stringify({ type: "request", at: new Date().toISOString(), ...x }));

// Per-request cache summary attached to the request log line (see the
// call site in handle() below) -- input already includes cache_read as a
// subset (every provider's usage schema reports it that way, see the
// comment in usageOf above), so cacheRatio is share-of-total-input, not
// share-of-uncached-input. Returns null when there's no usage at all
// (failed/aborted requests) so log lines for those don't carry a
// misleading cache: {ratio: 0} that looks like a real cache miss.
function cacheSummary(usage) {
  if (!usage) return null;
  const input = usage.input || 0;
  const cacheRead = usage.cache_read || 0;
  const ratio = input > 0 ? cacheRead / input : 0;
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

// ─── Proxy ────────────────────────────────────────────────────────────────────

async function proxy(req, res, r, p, model, action, id, isFallback) {
  const key = process.env[r.upstreamApiKeyEnv];
  if (!key) throw new Error(`Missing secret ${r.upstreamApiKeyEnv}`);
  const provider = r.provider || r.upstreamApiKeyEnv || "unknown";

  // Circuit breaker check
  if (await isCircuitOpen(provider, model)) {
    // Record both the provider-level error counter AND a per-model request
    // (status 0 = failed before any upstream response) so this attempt is
    // visible in that model's own row, not just an orphaned provider-level
    // error number that doesn't reconcile against any visible request.
    await recordUpstreamError(provider, model);
    await recordRequest(provider, model, 0, null, null, null, null, isFallback);
    throw new Error(`Circuit breaker open for ${provider}:${model}`);
  }

  const started = Date.now();
  let ttft = null;
  let streaming = false;
  await incrGauge("activeRequests", 1);

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

  try {
    const response = await fetch(upstreamUrl(r, p, model, action), {
      method: "POST",
      headers: headers(r, p),
      body: JSON.stringify(outgoingBody),
      signal: AbortSignal.timeout(Number(r.timeoutMs || 120000)),
    });

    if (response.status >= 500 || response.status === 429) {
      const text = await response.text();
      await recordBreakerFailure(provider, model);
      // Record the real upstream status against this model (not just an
      // anonymous provider-level error) so failed attempts on one model
      // (e.g. a circuit-tripping route) don't show up as unexplained
      // provider errors sitting next to a different model's clean 2xx row.
      await recordUpstreamError(provider, model);
      await recordRequest(provider, model, response.status, Date.now() - started, ttft, null, null, isFallback);
      const e = new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`);
      e.retryable = true;
      throw e;
    }

    res.status(response.status).set("x-gateway-request-id", id);
    for (const [k, v] of response.headers)
      if (!["content-encoding", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase()))
        res.setHeader(k, v);

    let usage = null;
    const contentType = response.headers.get("content-type") || "";

    if (!response.body || !contentType.includes("text/event-stream")) {
      const text = await response.text();
      try { usage = usageOf(JSON.parse(text)); } catch {}
      res.send(text);
    } else {
      streaming = true;
      await incrGauge("activeStreams", 1);
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

    await recordBreakerSuccess(provider, model);
    await recordRequest(provider, model, response.status, latencyMs, ttft, usage, estimatedCost, isFallback);
    log({ requestId: id, model, protocol: p, provider, status: response.status, latencyMs, ttftMs: ttft, usage, cache: cacheSummary(usage), estimatedCost, isFallback });
  } catch (e) {
    await recordBreakerFailure(provider, model);
    await recordUpstreamError(provider, model);
    // Only record here if we haven't already recorded this exact attempt
    // above (the 5xx/429 branch records before throwing). e.retryable is
    // only set by that branch, so its absence means this is a genuine
    // network-level failure (timeout, DNS, abort, missing key, etc.) that
    // never got a recordRequest call yet.
    if (!e.retryable) await recordRequest(provider, model, 0, Date.now() - started, ttft, null, null, isFallback);
    throw e;
  } finally {
    await incrGauge("activeRequests", -1);
    if (streaming) await incrGauge("activeStreams", -1);
  }
}

async function handle(req, res) {
  const p = protocol(req.path), model = modelFor(req, p), action = actionFor(req, p), id = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!model) return res.status(400).json({ error: { type: "ModelError", message: "A model is required." } });
  const available = candidates(model, p);
  if (!available.length) return res.status(404).json({ error: { type: "ModelError", message: `No ${p} route is configured for ${model}.` } });
  const failures = [];
  for (let i = 0; i < available.length; i++) {
    const r = available[i];
    const provider = r.provider || r.upstreamApiKeyEnv || "unknown";
    if (available.length > 1 && (await isCircuitOpen(provider, model))) continue; // skip open circuits if alternatives exist
    try {
      await proxy(req, res, r, p, model, action, id, i > 0);
      return;
    } catch (e) {
      failures.push(`${provider}: ${e.message}`);
      console.error(JSON.stringify({ type: "upstream_failure", requestId: id, model, protocol: p, provider, error: e.message }));
    }
  }
  if (!res.headersSent) res.status(502).json({ error: { type: "UpstreamError", message: "All compatible upstream routes failed.", requestId: id, failures } });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const [activeRequests, activeStreams, cbDetails] = await Promise.all([
    getGauge("activeRequests"),
    getGauge("activeStreams"),
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
    activeRequests,
    activeStreams,
    metricsBackend: usingRedis() ? "redis" : "in-memory (single instance only)",
  });
});

app.get("/metrics", adminAuth, async (_req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const configuredModels = [...new Set(allRoutes.map(r => r.id))];

  const snapshot = await getMetricsSnapshot(configuredProviders, configuredModels);

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
    metricsBackend: usingRedis() ? "redis" : "in-memory (single instance only)",
  });
});

app.get("/v1/models", auth, (_req, res) => {
  const m = new Map();
  for (const r of routes().filter((r) => r.enabled !== false)) {
    const x = m.get(r.id) || { id: r.id, object: "model", name: r.name || r.id, owned_by: r.provider || "gateway", protocols: [], context_window: r.context_window, cost: r.cost };
    if (!x.protocols.includes(r.protocol)) x.protocols.push(r.protocol);
    m.set(r.id, x);
  }
  res.json({ object: "list", data: [...m.values()] });
});

app.post("/v1/chat/completions", auth, handle);
app.post("/v1/messages", auth, handle);
app.post("/v1beta/models/:modelAction", auth, handle);

app.get("/v1/debug/routes", adminAuth, (_req, res) => {
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

// ─── Admin Dashboard ──────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// When serving /admin, inject the gateway URL and admin key from env so the
// dashboard auto-connects with zero manual config on Vercel or self-hosted.
// No adminAuth guard here (unlike /metrics, /v1/debug/routes): this route's
// whole job is to auto-inject the admin key into the page for a zero-config
// visit (see comment above). Gating it behind adminAuth was circular -- a
// plain browser GET has no Authorization header, so it always 401'd before
// the auto-inject logic below ever ran, and the dashboard could never load
// on a first visit. The embedded key is only as exposed as the URL itself.
const serveAdminDashboard = (req, res) => {
  try {
    let html = readFileSync(join(__dirname, "public", "admin.html"), "utf-8");
    // Auto-detect gateway URL: always prefer the actual request host, not
    // process.env.VERCEL_URL. VERCEL_URL resolves to this specific
    // deployment's unique hash subdomain (e.g. entry-gateway-abc123...),
    // which differs from the friendly alias (entry-gateway-six.vercel.app)
    // the browser is actually on -- injecting the hash URL made every
    // fetch() below a cross-origin request depending on CORS, when it
    // could just be same-origin and need no CORS at all.
    const gatewayUrl = `${req.protocol}://${req.get("host")}`;
    // Auto-detect admin key from env (ADMIN_API_KEYS takes priority, then GATEWAY_API_KEYS)
    const adminKey = (process.env.ADMIN_API_KEYS || process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean)[0] || "";
    // Inject into HTML as meta tags the frontend reads
    html = html.replace("</head>", `  <meta name="gateway-url" content="${gatewayUrl}" />
  <meta name="gateway-key" content="${adminKey}" />
</head>`);
    res.set("Content-Type", "text/html").send(html);
  } catch {
    res.status(404).send("Admin dashboard not found.");
  }
};

// Serve the dashboard at the bare domain root, not just /admin -- so you
// can just visit the gateway's normal URL and land straight on the
// credentials/dashboard screen instead of having to remember and type
// "/admin" every time. /admin is kept as an alias for old bookmarks/links.
app.get("/", serveAdminDashboard);
app.get("/admin", serveAdminDashboard);

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discover() {
  const sources = parseJson("MODEL_DISCOVERY_JSON", []);
  if (!Array.isArray(sources)) return;
  const fresh = [];
  for (const s of sources) try {
    const key = process.env[s.apiKeyEnv]; if (!key) continue;
    const response = await fetch(s.url, { headers: { Authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json(), list = Array.isArray(body) ? body : body.data || body.models || [];
    for (const item of list) {
      const upstreamModel = typeof item === "string" ? item : item.id || item.name;
      if (!upstreamModel) continue;
      for (const p of s.protocols || ["openai-chat"])
        fresh.push({ id: s.aliases?.[upstreamModel] || upstreamModel, upstreamModel, protocol: p, provider: s.provider, upstreamBaseURL: s.baseURL, upstreamApiKeyEnv: s.apiKeyEnv, priority: s.priority ?? 100, cost: s.cost, context_window: item.context_window || s.context_window });
    }
  } catch (e) { console.error(`Discovery failed for ${s.provider || s.url}: ${e.message}`); }
  discovered = fresh;
  console.log(`Discovered ${fresh.length} model/protocol routes`);
}

await discover();
setInterval(discover, Number(process.env.DISCOVERY_REFRESH_MS || 21600000)).unref();

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Entry Gateway listening on :${PORT}; models=${[...new Set(routes().map(r => r.id))].join(",") || "none"}`));
}
export default app;
