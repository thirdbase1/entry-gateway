// ─── Transparent Gemini explicit-context-cache manager ────────────────────────
//
// WHY THIS EXISTS: Google's Gemini API has two caching modes --
//   - Implicit caching: automatic, opportunistic, "no cost saving
//     guarantee" (Google's own words). It only helps if two requests
//     happen to share an identical prefix within Google's (undocumented,
//     short) TTL window. Fine for casual savings, useless as a target you
//     can actually hit and hold (e.g. "80%+ cache rate").
//   - Explicit caching: you create a `cachedContents` resource once
//     (pinning the model + systemInstruction), Google gives you back a
//     resource name, and every subsequent request that references that
//     name via `cachedContent` gets a *guaranteed* cache-read discount on
//     those tokens, for as long as the resource's TTL is kept alive.
//
// This module makes explicit caching automatic and transparent for every
// Gemini-protocol request the gateway proxies, with zero changes required
// on the calling app's side:
//   1. Every open-agents chat turn resends the SAME static system prompt
//      (CORE_SYSTEM_PROMPT + the Gemini family overlay) as
//      `systemInstruction` -- that's exactly the kind of large, byte-stable,
//      repeated-on-every-call content explicit caching exists for.
//   2. On each gemini-generate request, hash (model, systemInstruction) and
//      look up a previously-created cache for that exact pair.
//   3. If found and not expired: strip `systemInstruction` from the
//      outgoing body (it's already baked into the cache -- resending it
//      would just double the tokens billed) and set `cachedContent` to the
//      cache's resource name instead.
//   4. If not found (or expired): create it via Google's
//      `cachedContents.create`, remember the resource name (Redis-backed,
//      cross-instance-consistent -- same store metrics-store.js already
//      uses), and use it starting with THIS request.
//   5. Any failure here (network error, content below Google's per-model
//      minimum token count, Redis unavailable) must never break the
//      underlying chat request -- always fall back to sending
//      `systemInstruction` unmodified, which still gets Google's automatic
//      implicit caching for free.
//
// Google's per-model minimum cacheable token counts (from
// https://ai.google.dev/gemini-api/docs/caching, checked 2026-08-13):
//   Gemini 3.7/3.6/3.5 Flash, 3.1 Pro Preview -> 4,096 tokens
//   Gemini 2.5 Flash / Pro                    -> 2,048 tokens
// We don't have a tokenizer here, so a conservative ~3.2 chars/token
// estimate (English prose skews slightly more than 4 chars/token, but
// system prompts are dense with code/markdown, which tends toward fewer
// chars/token -- 3.2 keeps us safely under-caching rather than
// over-attempting and eating Google's 400 on every call) gates the attempt
// before we ever call Google; Google's own validation is the real
// backstop if this estimate is ever wrong.
const CHARS_PER_TOKEN_ESTIMATE = 3.2;
const MIN_TOKENS_BY_PREFIX = [
  [/^gemini-(3\.7|3\.6|3\.5)-flash/, 4096],
  [/^gemini-3\.1-pro/, 4096],
  [/^gemini-2\.5-(flash|pro)/, 2048],
];
const DEFAULT_MIN_TOKENS = 4096; // safe default for any Gemini model not in the table above

// Gemma models are NOT Gemini models -- Google's caching docs only cover
// "Gemini 2.5 and newer", Gemma is a separate open-weights family served
// through a look-alike endpoint. Never attempt cache creation for these;
// Google will just 400 every time and we'd pay the latency for nothing.
const isGemmaModel = (model) => /^gemma-/.test(model);

function minTokensFor(model) {
  for (const [re, min] of MIN_TOKENS_BY_PREFIX) if (re.test(model)) return min;
  return DEFAULT_MIN_TOKENS;
}

const TTL_SECONDS = 3600; // 1 hour -- refreshed automatically well before expiry
const REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000; // recreate 5 min before Google would expire it
const PREFIX = "gw:gc:"; // namespaced alongside metrics-store.js's "gw:m:"

// In-memory fallback (single-instance-only, same tradeoff metrics-store.js
// accepts for its own dev fallback) -- used only when Redis isn't
// configured, or if a Redis call itself fails.
const memCache = new Map(); // hash -> { name, expiresAtMs }

let redisClient = null;
async function getRedis() {
  if (redisClient !== null) return redisClient;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { Redis } = await import("@upstash/redis");
  redisClient = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  return redisClient;
}

async function readCacheEntry(hash) {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`${PREFIX}${hash}`);
      if (raw) return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error(JSON.stringify({ type: "gemini_cache_redis_read_error", message: e.message }));
    }
  }
  return memCache.get(hash) ?? null;
}

async function writeCacheEntry(hash, entry, ttlSeconds) {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(`${PREFIX}${hash}`, JSON.stringify(entry), { ex: ttlSeconds });
      return;
    } catch (e) {
      console.error(JSON.stringify({ type: "gemini_cache_redis_write_error", message: e.message }));
    }
  }
  memCache.set(hash, entry);
}

async function sha256Hex(text) {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Returns a cachedContent resource name for (model, systemInstruction), or
 * null if caching isn't applicable/available for this call (caller must
 * fall back to sending systemInstruction as-is).
 */
export async function getOrCreateCachedContent({ model, systemInstruction, apiKey }) {
  if (!systemInstruction || isGemmaModel(model)) return null;

  const text = JSON.stringify(systemInstruction);
  const estimatedTokens = text.length / CHARS_PER_TOKEN_ESTIMATE;
  if (estimatedTokens < minTokensFor(model)) return null; // too small to be worth (or eligible for) explicit caching

  const hash = await sha256Hex(`${model}:${text}`);
  const now = Date.now();

  const existing = await readCacheEntry(hash);
  if (existing && existing.expiresAtMs > now + REFRESH_SAFETY_MARGIN_MS) {
    return existing.name;
  }

  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/cachedContents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: `models/${model}`,
        systemInstruction,
        ttl: `${TTL_SECONDS}s`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(JSON.stringify({ type: "gemini_cache_create_failed", model, status: response.status, error: errText.slice(0, 300) }));
      return null;
    }
    const body = await response.json();
    if (!body?.name) return null;
    await writeCacheEntry(hash, { name: body.name, expiresAtMs: now + TTL_SECONDS * 1000 }, TTL_SECONDS);
    return body.name;
  } catch (e) {
    console.error(JSON.stringify({ type: "gemini_cache_create_error", model, message: e.message }));
    return null;
  }
}
