# Entry Gateway — Improvement Plan

## Highest priority

1. **Persist structured request logs**
   Write JSON Lines to a rotating file or database instead of relying only on stdout. Store request ID, timestamp, user/tenant label if supplied, provider, model, protocol, status, latency, time-to-first-token, input tokens, output tokens, cache tokens, billing multiplier, estimated cost, retry count, and error type.

2. **Improve streaming usage capture**
   Support provider-specific final usage events and OpenAI `stream_options.include_usage`. Keep `usage: null` when the upstream truly provides no usage; never estimate silently.

3. **Add a `/metrics` endpoint**
   Expose request totals, status classes, latency histograms, active requests, in-flight streams, provider errors, fallback count, tokens, and estimated spend. Protect it with the central key or a separate admin key.

4. **Add request cancellation propagation**
   Connect the client disconnect signal to an `AbortController` so abandoned streams stop consuming upstream tokens.

5. **Add circuit breakers**
   Temporarily remove a provider/model route after repeated 5xx, timeout, or 429 failures. Use cooldowns and half-open probes.

## Routing and compatibility

- Add native OpenAI Responses API support for providers/models that expose `/v1/responses`.
- Add provider-specific auth styles and headers from config.
- Add per-route retry policy with exponential backoff and jitter.
- Add configurable health checks for every provider.
- Add explicit model aliases and a route explanation endpoint for debugging.
- Add protocol validation so a model never falls back to a route with a different native protocol.
- Add configuration schema validation at startup with clear errors before listening.
- Add hot reload with atomic config replacement and rollback on invalid JSON.
- Add per-provider rate limits and concurrency controls rather than global caps.

## Cost and token accounting

- Add provider-specific rounding rules to match dashboards exactly.
- Add cached-read and cached-write pricing separately.
- Add reasoning-token fields when upstreams expose them.
- Add billing currency and provider invoice IDs where available.
- Add daily/monthly spend alarms.
- Add an option to reject requests when estimated spend exceeds a configured budget.
- Record whether cost is exact, provider-reported, or estimated.

## Security

- Hash gateway keys at rest and support key IDs, rotation, expiry, and revocation.
- Never echo upstream `Authorization`, `x-api-key`, or secret-bearing headers.
- Add request body size limits per route.
- Add SSRF protection for configured upstream URLs.
- Restrict discovery URLs to an allowlist.
- Add admin/read-only roles for metrics and configuration management.
- Add audit records for route changes and secret environment changes.
- Add optional IP/network allowlists for the gateway.

## Reliability and operations

- Add graceful shutdown: stop accepting requests, drain streams, then exit.
- Add readiness and liveness separation: `/health/live` and `/health/ready`.
- Add Docker healthcheck and non-root runtime user.
- Add structured log correlation with `x-gateway-request-id`.
- Add deployment version and git commit to `/health`.
- Add automated smoke tests for every configured route after deployment.
- Add load-test scripts that record token usage, not only status/latency/bytes.
- Add a test mode that uses mock upstreams so fallback and errors can be tested without spend.

## Findings from current tests

- OpenCode catalog contains `ling-3.0-flash-free`, but live inference returned `503 Endpoint is unavailable`; route health checks should detect and quarantine this.
- OpenCode MiMo streaming works reliably for short requests.
- OpenCode MiMo long non-stream requests can exceed a 120-second test window.
- Some streamed responses do not carry final usage metadata; the gateway correctly avoids fabricating cost.
- UniModel's dashboard applies a default 5x multiplier; billing multipliers must be route configuration, not hardcoded globally.
- Native forwarding works without payload translation for the tested OpenAI and Anthropic paths.
- 172-request, 8-worker soak test returned 100% HTTP 200 on working routes.

## Suggested next release

Implement persistent JSONL logs, `/metrics`, request cancellation, circuit breakers, config validation, OpenAI Responses support, and a token-aware load-test report before production deployment.

## 100-user burst findings

- Exact 100-user concurrent burst: 77 HTTP 200, 10 upstream Ling 502s, 13 client timeouts.
- MiMo: 40/40 successful under this burst.
- UniModel: 37/50 successful before the 45-second client limit; latency and timeouts show saturation.
- Ling: 0/10; upstream remained unavailable.
- The load script should be upgraded to capture parsed usage for every stream response and to distinguish gateway timeout, client timeout, upstream 429, and upstream 5xx as separate counters.
- Add queueing, per-provider concurrency, circuit breaking, and backpressure before attempting 100 production users.

## Public pricing and cache accounting

- Public pricing is provider-specific: do not label Zen Free routes as universal model pricing.
- Ling 3.0 Flash references currently disagree by provider: DeepInfra shows $0.06 input / $0.18 output / $0.012 cached; OpenRouter shows $0.021 input / $0.063 output.
- Xiaomi's official MiMo V2.5 page shows $0.14 uncached input / $0.0028 cache-hit input / $0.28 output.
- Usage normalization now keeps cache-read, cache-write, and reasoning tokens.
- The cache-aware cost formula separates uncached input from cached input. Add provider-specific cache-write semantics when a provider documents them.

## Lessons learned (2026-08-17)

- FreeModel API key rotated (`FREEMODEL_API_KEY`, Sensitive-type Vercel env var on this project). Sensitive vars are write-only once set -- `vercel env pull`/`ls` always shows `[SENSITIVE]`, never the real value. To rotate: `vercel env rm FREEMODEL_API_KEY production`, then pipe the new key into `vercel env add FREEMODEL_API_KEY production --sensitive`, then `vercel deploy --prod` (existing deployments keep the old value baked in until redeployed).
- Verified a rotated upstream key directly against the provider (e.g. `POST https://vip-sg.freemodel.dev/v1/chat/completions` with the new bearer token) before trusting it end-to-end through the gateway -- useful when the gateway's own client-facing `GATEWAY_API_KEY` is also Sensitive-type and thus unavailable locally to build a full round-trip test.
- Found and fixed stale "Pxxl" hosting references left over in rule.md, gateway.md, and README.md from before the Vercel migration -- when migrating hosting providers, grep every doc file in the repo for the old provider name, not just the deploy scripts/configs.

## 2026-08-18: Tiered context-length pricing was dead config, now wired up

Found while researching a competitor's caching architecture and cross-checking
OpenCode Zen's public pricing docs against our own route config: grok-4.5's
route already had a `context_over_200k` cost override sitting in its config,
but `costOf()` in server.js never read that key at all -- it only ever looked
at `r.cost.input/output/cache_read/cache_write` flat fields. That tier had
been silently inert since whenever it was added; every Grok request over
200K tokens was billed at the <=200K rate regardless of actual size.

Fix: generalized into `tieredCost(baseCost, totalInputTokens)` -- scans
`cost` for any `context_over_Nk` key, picks the highest threshold the
request's total input tokens (already includes cached tokens as a subset,
per every provider's usage schema) exceeds, and merges that tier's fields
over the base cost. Zero code change needed for future tiered models --
just add `context_over_Nk` to that model's `cost` object in the route JSON.

Added `context_over_272k` to gpt-5.6-sol/terra/luna (Sol/Terra confirmed via
opencode.ai/docs/zen; Luna inferred from the same 2x-input/1.5x-output ratio
Sol/Terra use between tiers -- not independently confirmed).

Also added a `gemini-`/`gemma-` prefix entry to
`CACHE_RATE_MULTIPLIERS_BY_PREFIX` (10% cache_read, 0% cache_write, matching
OpenCode Zen's published ratio) as a safety net -- did NOT touch the actual
gemini-* routes in the sensitive (write-only) env vars since their live
content can't be read back to verify before overwriting. The fallback only
applies when a route doesn't already have its own `cost.cache_read` set, so
it's safe regardless of what's actually configured there.

Lesson: when a route config has a field, grep the actual billing code to
confirm it's read, not just that it parses as valid JSON. Config and code
can silently drift apart.

## 2026-08-18: Cache observability added; prefix-optimization is a real, separate follow-up

External review (accurate) pointed out: the gateway correctly bills
whatever cache hits an upstream reports, but for OpenAI-compatible routes
(GPT-5.6 sol/terra/luna) it has no explicit cache-control/prefix-management
layer -- unlike Gemini, which has gemini-cache.js actively creating and
reusing a persistent cachedContents resource. GPT-5.6 caching is entirely
upstream-automatic; the gateway just forwards the request as-is and reads
whatever prompt_tokens_details.cached_tokens comes back.

Verdict after checking the actual code: correct. This was cache-price
*accounting*, not cache-hit *optimization* -- confirmed by re-reading
today's own tiered-pricing commit.

Shipped now (cheap, uses data already being collected, no new tracking):
- Per-request `cache: {inputTokens, cachedTokens, cacheWriteTokens,
  cacheRatio, cacheStatus}` on every request log line (server.js).
- `tokens.cacheHitRate` on every /metrics bucket (global/provider/model) --
  metrics-store.js already tracked cacheRead/input counters, this just
  exposes the ratio instead of making callers compute it themselves.
- `estimatedCacheSavingsUsd` per model in /metrics -- reuses
  cacheRateMultipliersFor so it can never drift from what costOf() actually
  billed.

NOT done (deliberately, needs its own dedicated investigation): actively
guaranteeing a maximally-reusable prompt prefix for OpenAI-compatible
routes. Checked entry-agents' prompt construction (buildSystemPrompt +
addCacheControl in packages/agent/open-agent.ts) -- system prompt is
static, dynamic content appended after, and addCacheControl only inserts
explicit cache_control breakpoints for Anthropic's protocol (correct,
since OpenAI's caching is automatic-only, no client-side control exists
to set). So there's no obvious client-side bug causing the low cache
ratio -- more likely causes are conversation length distribution
(automatic caching only pays off past ~1024 stable tokens and gets better
the longer a session runs) and normal churn from tool results/workspace
state changing the prefix. Worth measuring with the new per-request
cacheRatio field over a real traffic sample before deciding whether a
Gemini-style explicit layer is even justified for OpenAI-compat routes.

## 2026-08-18: Reverted FreeModel cc./api. fast-failover addition

Owner asked to revert the same-day FreeModel fast-failover route addition
(commits 0f1a5af + 8af0670) -- reverted via `git revert 8af0670 0f1a5af`
(commits c4c1a1a, addeaa7), pushed, redeployed. `/health` route count
back to 46 (pre-change baseline), confirmed live. No other changes in
this session were touched by the revert.

## 2026-08-19: prompt_cache_key for gpt-5.6 FreeModel routes (stable cache affinity)

Triggered by real production usage data from an 88-step gpt-5.6-luna
session: overall cache hit rate was ~80%, but several consecutive steps
showed ZERO cached tokens even though the immediately preceding step's
full context should have been a cache hit (e.g. step 6 cached 67,072 of
68,336 in; step 7's in only grew to 69,545 yet cached was 0 -- the whole
67K-token prefix that was cached one step earlier should still have
matched). Ruled out gateway-side load balancing first: `candidates()` is
deterministic (sorted by `priority`, same route picked every time absent
a circuit-breaker trip), so this isn't the gateway routing to different
endpoints.

Root cause: OpenAI's implicit/automatic prompt caching (used by
gpt-5.6-family models, no explicit cache_control needed) is best-effort
and depends on the request landing on the same backend machine that
already holds the KV cache for that prefix. OpenAI's own docs describe
`prompt_cache_key` (top-level Chat Completions param, common values are
session/user IDs) as the mechanism for pinning that -- and nothing in
the stack was ever sending it. Checked packages/agent/models.ts in
entry-agents: `attributionHeaders` only carries app name/url, no
session/chat id, so there was no existing identifier to forward even if
the gateway wanted to pass one through as-is.

Fix (server.js, `proxy()`): added `derivePromptCacheKey()`, which hashes
the first user-role message's content (sha1, first 500 chars, truncated
to 32 hex chars) as a synthetic session key -- stable across every step
of one session (that message never changes/moves once the session
starts) and differs across unrelated sessions. Injected into
`outgoingBody.prompt_cache_key` only when: protocol is `openai-chat`,
`route.provider === "freemodel"`, model id starts with `gpt-5.6`, and the
caller hasn't already set one. Deliberately NOT derived from the system
message -- that's byte-identical across every session of the same agent
type, so keying on it would've collapsed all concurrent unrelated
sessions onto one shard instead of giving each session its own affinity.
Deliberately scoped narrowly (freemodel + gpt-5.6-* only, not the whole
openai-chat protocol) since that protocol label is shared with Claude
routes proxied through a translation layer that may not tolerate an
OpenAI-specific field.

Verified: `node --check` clean, and locally simulated the hash function
against synthetic multi-step/multi-session message arrays to confirm the
key is stable within a session (including across a multimodal
content-array shape) and differs across sessions, plus null-safe when no
user message exists (falls back to sending nothing, not throwing).
Could not fire a real paid smoke-test call before shipping --
`GATEWAY_API_KEYS`/`FREEMODEL_API_KEY` are both Vercel "Sensitive" type
vars (write-only, unreadable via any API even to the project owner, same
limitation hit before -- see the 2026-08-18 gpt-5.6 pricing entry above).
Deployed via direct `vercel deploy --prod` (commit 9c17c91, dpl_9yPxuAk8);
health check 200. Follow-up: watch cache-hit-rate metrics and the
freemodel/gpt-5.6-* error rate over the next real traffic to confirm (a)
FreeModel's upstream tolerates the extra field with no new errors and
(b) the intermittent no-cache pattern actually goes away.

## 2026-08-19: /v1/models exposed raw cost, silently overcharging real credit balances on gpt-5.6-*

User did the manual math on the same usage-breakdown session used for
the prompt_cache_key fix above and got $0.75 (with the 0.1x cache
discount OpenAI publishes for gpt-5.6) vs the $2.43 the app actually
showed/charged -- a ~3.2x overcharge, matching almost exactly what full
undiscounted pricing on the same tokens would produce (~$2.46).

Traced it: costOf() in this file (real gateway-side billing) already
resolves CACHE_RATE_MULTIPLIERS_BY_PREFIX's fallback for gpt-5.6-*/
gemini-*/gemma-* routes lacking an explicit cost.cache_read (added
2026-08-17, see that entry above) -- but that resolution only happened
*inside* costOf(). The `/v1/models` endpoint returned `route.cost`
completely raw. entry-agents' own cost estimator
(apps/web/lib/models.ts estimateModelUsageCost) fetches this exact
endpoint as its ONLY pricing source, for both: (1) the UI's displayed
"Usage breakdown" popover, and (2) the REAL credit-ledger debit
(apps/web/app/workflows/chat-post-finish.ts, debitForModelUsage) --
there's no separate real-billing path on the app side, both read the
same catalog fetch. With cache_read undefined there, the estimator's
`costTier?.cache_read ?? inputPrice` fallback billed 100% of cached
tokens at the full input rate for real, out of users' actual account
balance -- not a cosmetic display bug.

Fix: added resolvedCostFor() in the /v1/models handler, reusing the same
cacheRateMultipliersFor() fallback costOf() already applies, so the
exposed catalog's cache_read/cache_write are never left undefined when
only the fallback multiplier (not an explicit rate) applies. Fixes both
the display and the real debit with one change since they share the
same source. Deployed commit 53af209, dpl (entry-gateway-5lvdxw844),
health check 200.

Scope/impact: this has been live (mis-billing) since 2026-08-17, when
the cache-discount fallback was added to costOf() but never mirrored
into /v1/models -- i.e. since that date, EVERY gpt-5.6-sol/terra/luna
request with a cache hit was overcharged, not just an edge case. Have
NOT reconciled historical ledger entries yet -- unlike the tiny 2-account
$15 case from 2026-08-18, this one likely spans many more real user
accounts and a ~2-day window; needs the owner's decision on whether/how
to look at scope and reconcile, same as the earlier "owner chose not to
auto-adjust" precedent but potentially much larger $ this time.

Also found (NOT fixed, separate follow-up): apps/web/lib/models.ts's
`resolveCostTier` hardcodes the literal key `context_over_200k` (built
for grok-4.5's threshold) instead of matching any `context_over_Nk` key
generically the way this gateway's own tieredCost() does. gpt-5.6-sol/
terra/luna's large-context tier lives under `context_over_272k`, so the
app-side estimator/debit currently never applies it at all -- it always
uses the base rate regardless of context size for those three models.
Direction of error is the opposite of the cache bug (undercharges large-
context gpt-5.6 requests, doesn't overcharge), and the hardcoded key
appears in several more files (admin-usage.ts, admin-user-detail.ts,
models-with-context.ts, settings/profile/page.tsx) -- a wider, separate
change, deliberately not bundled into this fix.

## Fixed 2026-08-20 — fallback loop didn't check res.headersSent before retrying

While grounding a Base44-agent-authored architecture-review doc against
the real code (entry-agents PR #8, docs/ENTRY_HARNESS_REVIEW.md), found a
real, reproducible reliability gap in `handle()`'s candidate-fallback
loop:

```js
for (let i = 0; i < available.length; i++) {
  try {
    await proxy(req, res, r, p, model, action, id, i > 0);
    return;
  } catch (e) {
    failures.push(`${provider}: ${e.message}`);
  }
}
if (!res.headersSent) res.status(502).json({ ... });
```

`res.headersSent` is only checked on the final failure response, never
before attempting the next candidate. `proxy()` calls
`res.status(response.status).set("x-gateway-request-id", id)` then copies
upstream headers via `res.setHeader(k, v)` before streaming the body. If
candidate #1 fails partway through an SSE stream (headers already sent,
some `res.write()` already flushed to the real client) and the loop falls
through to candidate #2, that `proxy()` call hits `res.setHeader()` on an
already-sent response -- Node throws `ERR_HTTP_HEADERS_SENT` synchronously.
That throw gets caught by `handle()`'s own try/catch and recorded as just
another failure; the loop keeps trying remaining candidates, each hitting
the same error, until candidates are exhausted. At that point
`res.headersSent` is `true` so the 502 branch is correctly skipped, but
`res.end()` is never called either -- net effect: the real end user's
connection is left half-written and never cleanly closed.

Fix shape (not yet implemented): guard the retry attempt itself, not just
the final failure response --

```js
for (let i = 0; i < available.length; i++) {
  if (res.headersSent) break; // a previous candidate already started
                               // streaming to the real client; fail
                               // closed instead of corrupting the stream
  try {
    await proxy(req, res, r, p, model, action, id, i > 0);
    return;
  } catch (e) {
    failures.push(`${provider}: ${e.message}`);
  }
}
if (!res.headersSent) res.status(502).json({ ... });
else res.end(); // close the half-written stream cleanly
```

Fixed same day: handle()'s loop now checks `res.headersSent` at the top
of each iteration and `break`s instead of attempting the next candidate;
falls through to `res.end()` (clean close) instead of a 502 when headers
were already sent. Added `fallback.test.js` (Node built-in `node:test`,
zero new deps) -- spins up two fake local upstreams, one that sends SSE
headers + a partial chunk then destroys the socket mid-stream, one
healthy. Confirmed the test fails against the pre-fix code (`providerB:
Cannot set headers after they are sent to the client`, connection hangs
forever past a 5s safety timeout) and passes against the fix (candidate
#2 receives zero requests, connection closes cleanly, client sees only
candidate #1's partial data). `npm test` now runs this suite.

## 2026-08-21: Smart routing for FreeModel models across two base URLs

Owner asked to wire both `https://api.freemodel.dev` and
`https://vip-sg.freemodel.dev` in with "smart routing" for gpt-5.6-sol/
terra/luna. No server.js code change needed -- `candidates()` already
sorts ascending by `priority` and `handle()`'s fallback loop already
tries each candidate until one succeeds; this only needed a route-config
change in `EXTRA_MODEL_ROUTES_JSON_3` (Vercel env var):

- Added `api.freemodel.dev/v1` as a priority-1 candidate for all three
  models (`timeoutMs: 5000` for fast failover).
- Kept the existing `vip-sg.freemodel.dev/v1` candidates as priority-100
  fallback, untouched.
- Dedup key in `routes()` includes `upstreamBaseURL`, so both candidates
  coexist correctly rather than clobbering each other (see the
  `upstreamApiKeyEnv`-in-dedup-key note earlier in this file for the same
  class of gotcha).

Verified live via direct probe: gpt-5.6-sol and gpt-5.6-terra both
return 200 through the new `api.freemodel.dev` candidate. gpt-5.6-luna
still fails on BOTH domains -- the error payloads carry the identical
upstream distributor-group/pool id either way, confirming the two
domains share the same backend pool for Luna specifically. So this
smart-routing change *does* add real redundancy for Sol/Terra, but
cannot route around Luna's current outage since there's no second
underlying pool to fail over to for that model.

Separately, this same edit also folded in the ling-3.0-flash-free fix
from earlier today (moved from the disconnected EXTRA_MODEL_ROUTES_JSON_4
slot into this live one) and deduped an accidental double gpt-5.6-luna
entry left over from an earlier pass.

## 2026-08-27: metrics-store.js Redis calls could hang or crash real requests

Found while checking runtime logs: Upstash rate-limited this project's
Redis instance (`UpstashError: Your database has been temporarily
rate-limited`). This exposed two real bugs in metrics-store.js, both
now fixed:

1. Every exported function did an unguarded `await redis.xxx()` /
   `await pipeline.exec()` with no try/catch. When Redis errored, that
   propagated straight up as a raw exception.
2. In `server.js`'s `handle()` fallback loop, the `isCircuitOpen()` call
   made *before* the `try { await proxy(...) }` block (used to skip
   already-open circuits when there are 2+ candidate routes) had nothing
   to catch it -- an uncaught rejection there just hangs the request with
   no response ever sent, until Vercel's hard 300s function timeout kills
   it. Confirmed in real logs: several `/v1/chat/completions` requests hit
   exactly this, logged as `Unhandled Rejection: UpstashError...` followed
   by `Vercel Runtime Timeout Error: Task timed out after 300 seconds`.
   Single-candidate models (e.g. claude-opus-4-6) instead hit bug #1 inside
   `proxy()`, which *is* wrapped by `handle()`'s own try/catch, so those
   just got a fast but misleading 502 whose `error` field was the raw
   Upstash message -- looked like an upstream model failure, but it was
   actually our own metrics/circuit-breaker store.

Fix: added an in-process Redis-health circuit breaker inside
metrics-store.js (`isRedisCircuitOpen`/`recordRedisFailure`, 15s cooldown
-- same pattern as entry-agents' `lib/rate-limit.ts`) and wrapped every
real Redis call in try/catch that falls back to the existing in-memory
path on failure. `isCircuitOpen()` specifically is now guaranteed to
never throw, since `server.js` relies on that at a call site with no
try/catch of its own by design (documented inline at both ends). New
`metrics-store-redis-failure.test.js` points the module at a real,
unreachable host (no mocking lib in this repo, same philosophy as
`fallback.test.js`) and asserts every exported function resolves quickly
with a safe fallback instead of throwing/hanging -- confirmed it fails
hard against the pre-fix code (ENOTFOUND propagates straight through)
and passes against the fix.

Not fixed / out of scope: the *first* Redis rate-limit event itself is
an Upstash-side condition (same recurring issue class already seen and
partly remediated for entry-agents' own Redis instance) -- this fix only
makes the gateway resilient *to* that condition, it doesn't prevent
Upstash from rate-limiting the account again.

## 2026-08-27 (same day, follow-up): migrated entirely off Upstash Redis

Owner asked, after the fail-open fix above: why does entry-agents even
use Upstash, and can the gateway move off it entirely instead of just
being resilient to its outages? Answer to the first part: Vercel
serverless functions are stateless between invocations, so anything that
needs to be shared/consistent across concurrent instances (rate limits,
skills cache, this gateway's own metrics/circuit-breakers) needs a fast
external store -- Upstash Redis was the store used for that. But this is
now the second real incident in about a week traced back to Upstash-side
throttling (first hit entry-agents' own separate Redis instance, this one
hit the gateway's), so worth actually removing the dependency here rather
than just tolerating it.

Migrated metrics-store.js (and gemini-cache.js, which had its own smaller
Redis usage for the Gemini explicit-cache resource-name lookup) from
`@upstash/redis` to `@neondatabase/serverless`, pointed at the SAME Neon
Postgres database entry-agents already runs on (reused rather than
provisioning new infra -- new `GATEWAY_METRICS_DATABASE_URL` env var,
namespaced tables `gw_metrics_buckets` / `gw_metrics_gauges` /
`gw_circuit_breakers` / `gw_kv` so nothing collides with entry-agents' own
tables in that DB). Chose the Neon serverless HTTP driver specifically
because it needs no persistent connection/pool, matching how the REST-
based Upstash client worked -- still a good fit for stateless functions.

Counters use `INSERT ... ON CONFLICT DO UPDATE SET col = table.col +
EXCLUDED.col` for atomic increments (including a dynamic-key JSONB
increment for the per-status-code breakdown); latency/ttft samples are
appended to a Postgres array column and trimmed to the last 500 in the
same statement. Circuit-breaker state and gauges are straightforward
upsert tables. `usingRedis()` renamed to `usingDb()` (also updated
server.js's one call site + the `/health` and `/metrics` `metricsBackend`
field, now reports `"postgres"` instead of `"redis"`).

Kept the exact same fail-open discipline from the earlier same-day fix
(15s in-process circuit breaker around DB calls, falls back to the
existing in-memory path) -- Postgres isn't immune to outages either, this
just means it's no longer sharing Upstash's specific account/quota with
everything else.

Verified: renamed `metrics-store-redis-failure.test.js` ->
`metrics-store-db-failure.test.js`, updated to point at an unreachable
Postgres host instead of an unreachable Redis host -- all 9 tests pass.
Separately ran a real manual script against the actual Neon DB
(recordRequest/recordUpstreamError/gauges/circuit-breaker open-close-
recover/kv get-set) to confirm the SQL itself is correct, not just the
fail-open path -- confirmed correct, then cleaned up the test rows.
Removed `KV_REST_API_URL`/`KV_REST_API_TOKEN` from the Vercel project and
`@upstash/redis` from package.json -- zero Upstash usage left anywhere in
this repo.
