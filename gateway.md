# Entry Gateway — Build and Test Record

**Project:** self-hosted native-protocol AI gateway on Pxxl
**Repository:** `thirdbase1/entry-gateway`
**Test date:** 2026-08-10
**Timezone:** Africa/Lagos (gateway console timestamps were emitted in UTC)

## Purpose and architecture

The gateway is a smart proxy. It accepts one central gateway API key, identifies the requested model and native protocol, selects a configured provider route, and forwards the request without translating the payload. Provider API keys stay server-side in environment variables.

Implemented native routes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` — OpenAI-compatible
- `POST /v1/messages` — Anthropic Messages
- `POST /v1beta/models/:model:generateContent` — Gemini-style

The route system supports JSON configuration, provider-specific key environment variables, model aliases, priority ordering, duplicate-model fallback, periodic model discovery, stream passthrough, token usage extraction, billing multipliers, estimated cost logging, timeouts, request IDs, and Docker deployment.

## Files created or changed

- `server.js` — native protocol routing, auth, fallback, discovery, streaming, usage and cost logging
- `README.md` — configuration and deployment documentation
- `Dockerfile` — Node 20 Alpine deployment image
- `soak-test.sh` — repeatable multi-user soak test
- `gateway.md` — this build/test record
- `improve.md` — improvement backlog
- `rule.md` — operating rules and standing requirements

No provider secret or gateway key is stored in these files.

## Secret handling

The following secrets were captured securely by the platform and used only through environment variables:

- `$OPENAI_API_KEY` — UniModel key
- `$OPEN_ZEN_API_KEY` — OpenCode Zen key

The actual values are intentionally not written here, printed in logs, or committed.

## OpenCode Zen catalog and pricing check

Endpoint tested:

```text
https://opencode.ai/zen/v1
```

Authenticated `GET /models` result:

```text
HTTP 200
model_count=53
```

Relevant model IDs returned by the live catalog:

```text
mimo-v2.5-free
ling-3.0-flash-free
ling-3.0-tiny-free
```

The requested IDs `ling-3.0-flash-free` and `mimo-v2.5-free` are present. OpenCode Zen documentation lists both as **Free / Free / Free / Free** for input, output, cached read, and cached write. The docs list their native endpoint family as OpenAI-compatible `/v1/chat/completions`.

The live OpenCode docs also list these relevant routes:

```text
DeepSeek V4 Flash: deepseek-v4-flash
MiMo V2.5 Free: mimo-v2.5-free
Ling 3.0 Flash Free: ling-3.0-flash-free
```

## UniModel key verification

Provider endpoint tested:

```text
https://www.unimodel.ai/v1
```

Authenticated `GET /models` result:

```text
HTTP 200
model_count=14
sample IDs:
deepseek-v4-flash
deepseek-v4-pro
glm-5
glm-5.1
glm-5.2
kimi-k2.6
MiniMax-M2.5
MiniMax-M2.7
MiniMax-M3
qwen3.6-flash
```

## UniModel gateway smoke test

Model: `deepseek-v4-flash`

Request went through the gateway using the central gateway key. Provider key remained server-side.

```text
HTTP 200
response model: deepseek-v4-flash-ga-260731
assistant text: gateway-ok
usage: prompt_tokens=11, completion_tokens=69, total_tokens=80
reasoning_tokens=65
```

Gateway log:

```json
{"type":"request","model":"deepseek-v4-flash","protocol":"openai-chat","provider":"unimodel","status":200,"usage":{"input":11,"output":69,"cache_read":0}}
```

## UniModel 30-second-boundary tests

Configured upstream timeout: `30000ms`.

### Non-stream

```text
HTTP 200
elapsed: 11.5 seconds
model: deepseek-v4-flash-ga-260731
prompt tokens: 25
completion tokens: 707
total tokens: 732
reasoning tokens: 611
```

### Stream

```text
HTTP 200
elapsed: 3.6 seconds
SSE data events: 81
final data: [DONE]: yes
prompt tokens: 17
completion tokens: 78
```

These completed before the 30-second timeout; the timeout was a ceiling, not an artificial delay.

## UniModel long-generation test

Configured upstream timeout: `30000ms`, requested `2048` output tokens.

### Non-stream

```text
HTTP 200
elapsed: 27.9 seconds
prompt tokens: 146
completion tokens: 2048
total tokens: 2194
reasoning tokens: 1461
estimated raw provider cost: $0.00059388
```

### Stream

```text
HTTP 200
elapsed: 21.8 seconds
SSE data events: 2050
final data: [DONE]: yes
prompt tokens: 134
completion tokens: 2048
estimated raw provider cost: $0.00059220
```

## UniModel dashboard cost reconciliation

UniModel displayed a default `5x` billing multiplier and Standard prices of `$0.14/M input` and `$0.28/M output`.

Non-stream calculation:

```text
raw: $0.00059388
billed: $0.00059388 × 5 = $0.00296940
UniModel dashboard: $0.002970
```

Stream calculation:

```text
raw: $0.00059220
billed: $0.00059220 × 5 = $0.00296100
UniModel dashboard: $0.002962
```

Gateway was updated with per-route `billingMultiplier`; UniModel routes should use `billingMultiplier: 5`.

## Provider errors observed

OpenCode Zen returned this for `ling-3.0-flash-free` during the long test:

```json
{"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Endpoint is unavailable."}}
```

The gateway exposed it as:

```json
{"error":{"type":"UpstreamError","message":"All compatible upstream routes failed.","failures":["opencode-zen: Upstream 503: Endpoint is unavailable."]}}
```

Both Ling stream and non-stream attempts failed quickly with HTTP `502` from the gateway because the upstream returned `503`.

MiMo non-stream reached the `120s` test timeout during the long-generation test. MiMo streaming continued producing output through the client window and returned a partial stream capture when the test client stopped. Short MiMo requests later succeeded.

## OpenCode and UniModel five-minute soak test

The completed soak used 8 virtual workers, one request every 8 seconds per worker, across working routes:

- MiMo stream: 2 workers
- MiMo non-stream: 2 workers
- UniModel stream: 2 workers
- UniModel non-stream: 2 workers

Ling was excluded from the soak after the confirmed upstream `503 Endpoint is unavailable`; it was not repeatedly hammered.

Results:

```text
Total requests: 172
HTTP 200 responses: 172
Errors: 0
```

By route:

```text
OpenCode Zen non-stream: 42 requests, 42 successful, average 6.651s, p95 9.693s
OpenCode Zen stream:     42 requests, 42 successful, average 6.657s, p95 9.662s
UniModel non-stream:     48 requests, 48 successful, average 4.967s, p95 12.916s
UniModel stream:         40 requests, 40 successful, average 7.331s, p95 16.004s
```

Gateway token/cost records confirmed usage extraction on successful non-stream and many stream responses. Example records from the gateway console:

```json
{"model":"mimo-v2.5-free","provider":"opencode-zen","status":200,"usage":{"input":262,"output":48,"cache_read":0},"estimatedCost":0}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"usage":{"input":20,"output":641,"cache_read":0},"estimatedCost":0.0009114}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"usage":{"input":20,"output":782,"cache_read":0},"estimatedCost":0.0011088}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"usage":{"input":99,"output":48,"cache_read":0},"estimatedCost":0.0001365}
```

Some streaming upstream responses did not include a final usage event, so those records correctly show `usage: null` and `estimatedCost: null` rather than inventing token counts.

## Validation summary

```text
Node syntax check: passed
Dockerfile created: yes
Central gateway-key auth: passed
OpenCode /models: HTTP 200
UniModel /models: HTTP 200
OpenAI native forwarding: passed
Anthropic native forwarding: passed with mock upstream
Gemini route: implemented
Priority fallback: passed with mock upstream
UniModel non-stream: passed
UniModel stream: passed
OpenCode MiMo non-stream: passed on short requests
OpenCode MiMo stream: passed
OpenCode Ling: upstream unavailable / 503
5-minute soak: 172/172 HTTP 200 on working routes
```

## 100-virtual-user test

The next test is recorded below after execution. It is a bounded 100-user concurrent burst: exactly 100 virtual users, one request per user, mixed across the configured providers and stream modes. It is not an unbounded/infinite traffic generator; unbounded traffic would risk uncontrolled spend and provider abuse.

## 100-virtual-user concurrent burst

Test command used exactly 100 concurrent one-shot virtual users. Distribution:

```text
Ling 3.0 Flash Free: 5 stream + 5 non-stream = 10
MiMo v2.5 Free:      20 stream + 20 non-stream = 40
UniModel DeepSeek:   25 stream + 25 non-stream = 50
Total:               100 virtual users
```

Each user sent one request with a 45-second client/upstream timeout and a short health-check prompt. This was a bounded concurrent-user test, not an unlimited traffic generator.

Overall result:

```text
Total virtual users: 100
HTTP 200: 77
Gateway HTTP 502: 10
Client timeout/status 000: 13
```

Route result:

```text
OpenCode Ling non-stream: 5, 0 successful, 5 errors, average 4.390s, p95 5.244s
OpenCode Ling stream:     5, 0 successful, 5 errors, average 3.566s, p95 5.247s
OpenCode MiMo non-stream: 20, 20 successful, 0 errors, average 6.062s, p95 8.973s
OpenCode MiMo stream:     20, 20 successful, 0 errors, average 6.691s, p95 9.278s
UniModel non-stream:      25, 14 successful, 11 client timeouts, average 27.234s, p95 45.151s
UniModel stream:          25, 23 successful, 2 client timeouts, average 23.218s, p95 45.223s
```

Token usage captured from completed JSON responses:

```text
OpenCode MiMo: input 5,100, output 1,266, cost $0.000000 (free route)
UniModel DeepSeek: input 1,037, output 2,388, successful JSON usage records 14, billed estimate $0.00406910
```

Representative gateway records from the 100-user run:

```json
{"model":"mimo-v2.5-free","provider":"opencode-zen","status":200,"latencyMs":8354,"usage":{"input":255,"output":64,"cache_read":0},"estimatedCost":0}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"latencyMs":9902,"usage":{"input":91,"output":64,"cache_read":0},"estimatedCost":0.0001533}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"latencyMs":38250,"usage":{"input":12,"output":414,"cache_read":0},"estimatedCost":0.000588}
{"model":"deepseek-v4-flash","provider":"unimodel","status":200,"latencyMs":44363,"usage":{"input":12,"output":879,"cache_read":0},"estimatedCost":0.001239}
```

The 10 Ling failures were the same upstream error already observed:

```text
Upstream 503: Endpoint is unavailable
```

The 13 status-000 results were client-side timeouts at the 45-second test limit while UniModel was under concurrent load. They are not counted as successful gateway responses. The gateway process and temporary test sessions were stopped after the test.

## Interpretation

- MiMo handled 40 simultaneous requests successfully across both stream modes.
- Ling is catalog-visible but currently not inference-available through OpenCode Zen; it needs route health quarantine and should not be selected until the provider recovers.
- UniModel handled 37/50 requests before the 45-second client boundary, but latency rose sharply under this burst. It is not ready for 100 concurrent users without queueing, per-provider concurrency controls, retries/circuit breaking, and a longer/explicit upstream timeout policy.
- The gateway preserved native OpenAI-compatible payloads and separated provider behavior correctly.

## Public non-Zen pricing research

OpenCode Zen marks these routes as Free, but that is Zen/provider-wrapper pricing. The underlying models have provider-specific public prices, so there is no single universal “public model price.” The gateway should store pricing per provider route, not per model name globally.

### Ling 3.0 Flash

Public references found:

- DeepInfra model page: https://deepinfra.com/inclusionAI/Ling-3.0-flash
- OpenRouter model page: https://openrouter.ai/inclusionai/ling-3.0-flash

DeepInfra currently displays:

```text
Input:  $0.06 / 1M tokens
Output: $0.18 / 1M tokens
Cached: $0.012 / 1M tokens
```

OpenRouter search result currently displays:

```text
Input:  $0.021 / 1M tokens
Output: $0.063 / 1M tokens
```

These are different public provider prices for the same underlying model. For a DeepInfra route, use input `0.06`, output `0.18`, and cache-read `0.012`. For an OpenRouter route, use the OpenRouter rates and do not copy DeepInfra pricing.

The OpenCode Zen route named `ling-3.0-flash-free` is not equivalent to claiming Ling is always free everywhere. The live Zen endpoint returned `503 Endpoint is unavailable` during our tests.

### MiMo V2.5

Official Xiaomi pricing page:

- https://mimo.mi.com/docs/price/pay-as-you-go

Official Xiaomi API pricing currently displays:

```text
Input cache hit:  $0.0028 / 1M tokens
Input cache miss: $0.14 / 1M tokens
Output:          $0.28 / 1M tokens
```

Public OpenRouter reference:

- https://openrouter.ai/xiaomi/mimo-v2.5

OpenRouter currently displays:

```text
Input:  $0.14 / 1M tokens
Output: $0.28 / 1M tokens
```

For an official Xiaomi route, configure `input: 0.14`, `output: 0.28`, and `cache_read: 0.0028`. For OpenRouter, confirm whether cache billing is exposed before setting a cache rate.

## Cache-aware token logging update

The gateway usage normalizer now preserves:

```json
{
  "input": 1000,
  "output": 100,
  "cache_read": 400,
  "cache_write": 0,
  "reasoning": 70
}
```

It recognizes common fields from OpenAI-compatible, Anthropic-compatible, and Gemini-style responses:

- `prompt_tokens`, `input_tokens`, `promptTokenCount`
- `completion_tokens`, `output_tokens`, `candidatesTokenCount`
- `cache_read_input_tokens`, `cache_read_tokens`, `cached_tokens`, `cachedContentTokenCount`
- `cache_creation_input_tokens`, `cache_write_input_tokens`, `cache_write_tokens`
- nested `prompt_tokens_details.cached_tokens`
- nested `completion_tokens_details.reasoning_tokens`
- `thoughtsTokenCount`

Cost calculation now separates uncached input from cache-read and cache-write tokens instead of charging the full input rate plus cache tokens. The final log continues to show `usage: null` and `estimatedCost: null` when a streaming provider does not send usage metadata; no token count is fabricated.

### Cache logging verification

A local mock OpenAI-compatible response containing nested cache and reasoning metadata was forwarded through the gateway. The emitted log was:

```json
{"usage":{"input":1000,"output":100,"cache_read":400,"cache_write":0,"reasoning":70},"estimatedCost":0.00011312}
```

Using input `$0.14/M`, cache-read `$0.0028/M`, and output `$0.28/M`, the calculation is:

```text
600 uncached input × $0.14/M
+ 400 cached input × $0.0028/M
+ 100 output × $0.28/M
= $0.00011312
```

The cache-aware verification passed.

## Upstream research and clean reclone — 2026-08-10

### Research sources

- Repository: https://github.com/thirdbase1/entry-gateway
- Upstream README: https://raw.githubusercontent.com/thirdbase1/entry-gateway/main/README.md
- Remote: `https://github.com/thirdbase1/entry-gateway`

The repository is public and currently has two commits on `main`:

```text
fe28d87 README: add deploy command and provider setup walkthrough
306fbc4 Initial entry-gateway: OpenAI-compatible self-hosted AI gateway
```

The upstream README describes a Pxxl deployment with:

- `GATEWAY_API_KEYS`
- `OPENCODEZEN_BASE_URL`
- `OPENCODEZEN_API_KEY`
- optional `MODEL_ROUTES_JSON`
- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

The upstream default map contains four OpenCode Zen models:

```text
kimi-k3
grok-4.5
ling-3.0-flash-free
mimo-v2.5-free
```

The upstream implementation research found these current limitations:

- Only OpenAI-compatible `/v1/chat/completions` is implemented.
- No `/v1/messages` Anthropic route.
- No Gemini `generateContent` route.
- No protocol field in routing; all routes append `/chat/completions`.
- No provider priority or fallback between duplicate routes.
- No request timeout or upstream abort signal.
- No request ID response header.
- No token usage extraction.
- No cache-read, cache-write, or reasoning-token logging.
- No estimated cost logging.
- No stream-aware usage parsing; it simply pipes the upstream body.
- No provider health/circuit breaker state.
- Default routes are OpenCode-specific and use `OPENCODEZEN_API_KEY`.
- `MODEL_ROUTES_JSON` overrides are selected by model ID only.

These limitations are why the enhanced implementation was developed in the preserved backup rather than silently assuming the upstream repo already contained the full gateway architecture.

### Recloning procedure

The previous customized working tree was preserved before recloning at:

```text
entry-gateway-custom-20260810-2009/
```

That backup contains the enhanced `server.js`, Dockerfile, test harnesses, pricing research, token/cost work, and all project reports.

The primary directory was then freshly cloned from GitHub:

```text
entry-gateway/
```

Fresh clone verification:

```text
branch: main
HEAD: fe28d87
remote: https://github.com/thirdbase1/entry-gateway
npm ci: passed
packages audited: 69
npm audit vulnerabilities: 0
node --check server.js: passed
```

The documentation and repeatable test harnesses were copied into the fresh clone without copying over the fresh upstream `server.js` or `README.md`:

```text
gateway.md
improve.md
rule.md
soak-test.sh
vu100-test.sh
```

This deliberately leaves the primary checkout as a recognizable fresh upstream clone while retaining the enhanced implementation in the dated backup. No API key values were copied into either location.

### Fresh-clone smoke behavior

The upstream process refuses authenticated model operations if `GATEWAY_API_KEYS` is absent, as expected. With the gateway key configured but without the OpenCode Zen base URL, the health response reports no routed models. The source syntax check and dependency install pass.

### Recommended next action

Port the enhanced native-protocol router, timeout/fallback behavior, token/caching logger, billing multiplier, and structured request logging from `entry-gateway-custom-20260810-2009/server.js` into the fresh clone deliberately, preserving the fresh upstream baseline for comparison. Do not overwrite the backup.
