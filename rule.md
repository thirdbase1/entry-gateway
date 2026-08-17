# Entry Gateway — Operating Rules

This file is part of the gateway project. Read it before changing the gateway or running provider tests.

## Core product rules

1. The gateway is a self-hosted smart proxy on Vercel.
2. Incoming clients use one central gateway API key.
3. Provider API keys stay private in server-side environment variables and must never be committed, printed, returned, or copied into documentation.
4. Route requests by both model and native protocol.
5. Do not translate request or response payloads between protocols.
6. Provider base URLs, provider key environment names, model IDs, aliases, protocol, priority, pricing, multiplier, timeout, and headers belong in JSON configuration.
7. Adding or removing a provider/model should not require changing gateway code.
8. Keep provider-specific headers and authentication server-side.
9. Preserve upstream status, response headers where safe, body format, SSE events, and `[DONE]` markers.
10. Every request should receive a gateway request ID.

## Supported native protocol families

- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages: `/v1/messages`
- Gemini-style generateContent: `/v1beta/models/:model:generateContent`
- Add OpenAI Responses `/v1/responses` when configured; do not force Responses models through Chat Completions.

## Routing rules

1. Exact model + protocol match is required.
2. Duplicate model routes sort by ascending priority.
3. Retry only retryable upstream failures such as 429, 5xx, network errors, or timeouts.
4. Never fall back across incompatible native protocols.
5. Do not retry after response headers have been sent.
6. Discovery may add routes, but configured explicit routes remain authoritative.
7. Disabled or unhealthy routes must be skipped.
8. Provider errors must remain visible in structured logs.

## Token and cost rules

1. Prefer upstream-reported usage.
2. Capture input, output, cache-read, cache-write, and reasoning-token fields when provided.
3. If usage is unavailable, log `usage: null`; never invent a number silently.
4. Cost rates are per-million-token values in route config.
5. Apply `billingMultiplier` per route. UniModel Standard currently uses input `$0.14/M`, output `$0.28/M`, and the observed default multiplier is `5`.
6. Log raw usage, raw rate, multiplier, and final estimated cost when available.
7. Mark estimates as estimated; they are not provider invoices.
8. Keep free OpenCode models at zero configured cost.

## Testing rules

1. Record every test in `gateway.md` or a dated test log.
2. Record provider, endpoint, model, mode, timeout, request count, response status, duration, first-token timing when available, token usage, cost, and errors.
3. Never include API keys or secrets in logs.
4. Test streaming and non-streaming separately.
5. Test model discovery and central-key authentication.
6. Test fallback using mock upstreams before relying on paid providers.
7. If a provider returns an upstream-unavailable error, stop repeated retries and document it.
8. Load tests must be authorized and must not become an infinite/unbounded traffic generator.
9. A virtual-user count means concurrent simulated clients; state the request count and duration separately.
10. Do not use unlimited output or infinite loops in provider load tests. Use a defined request count, duration, timeout, and stop condition.
11. For paid providers, use a controlled test shape and report estimated spend.
12. Stop temporary test servers, sessions, and listeners after testing.

## Documentation rules

1. Every implementation change updates an `.md` file.
2. `gateway.md` contains the factual build and test record.
3. `improve.md` contains findings, risks, and the next engineering backlog.
4. `rule.md` contains standing architecture, security, testing, and documentation rules.
5. Do not delete prior test results when adding new results; append a dated section.
6. Include exact provider errors and explain whether they came from the gateway or upstream.
7. Separate measured facts from assumptions and recommendations.

## Current confirmed provider facts

- UniModel endpoint tested: `https://www.unimodel.ai/v1`.
- OpenCode Zen endpoint tested: `https://opencode.ai/zen/v1`.
- UniModel key is available as `$OPENAI_API_KEY`.
- OpenCode Zen key is available as `$OPEN_ZEN_API_KEY`.
- OpenCode `mimo-v2.5-free` and `ling-3.0-flash-free` were present in the live catalog.
- OpenCode Ling inference returned `503 Endpoint is unavailable` during testing.
- OpenCode MiMo short stream and non-stream requests succeeded.
- UniModel DeepSeek V4 Flash stream and non-stream requests succeeded.
- UniModel dashboard default billing multiplier observed: `5x`.

## Change discipline

Before deployment, run syntax checks, configuration validation, central-auth checks, model-list checks, one request per native protocol, streaming checks, fallback checks, and a bounded load test. Then update `gateway.md` with the result.

## 100-user test decision

A request for “100 virtual users” means exactly 100 concurrent simulated users with a defined one-request workload unless a separate duration and request-rate plan is explicitly approved. Do not interpret it as permission for infinite traffic, unlimited retries, unlimited output, or an uncapped loop. This protects provider accounts, cost, service availability, and the gateway itself while still measuring concurrency.

## Public pricing rule

“Free” at a gateway or reseller does not mean the underlying model has universal zero pricing. Store public rates per provider route with source URL and retrieval date. Never overwrite one provider's pricing with another provider's pricing for the same model.

## Cache accounting rule

Always log input, output, cache_read, cache_write, and reasoning tokens when the upstream supplies them. For cache-aware pricing, subtract cached input from uncached input before applying rates. If a stream has no usage event, log null rather than estimating silently.
