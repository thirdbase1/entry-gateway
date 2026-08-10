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
