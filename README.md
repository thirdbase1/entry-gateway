# Entry Gateway

Self-hosted, config-driven native-protocol AI gateway. Clients use one gateway API key; provider keys stay in server-side environment variables managed by Vercel.

## Routes

- `GET /health` — gateway status, uptime, providers, circuit breakers, active requests
- `GET /health/live` — liveness probe: pure in-process check, never touches the database or network
- `GET /health/ready` — readiness probe: 503 until this instance has a usable route table, plus build identity (version, git sha, boot time)
- `GET /metrics` — per-provider and aggregate metrics (public through the read-only dashboard session by default)
- `GET /` — public landing page (static, no auth)
- `GET /admin` — built-in public, read-only admin dashboard UI
- `GET /v1/models` — deduplicated public models with protocol metadata
- `POST /v1/chat/completions` — OpenAI-compatible passthrough
- `POST /v1/messages` — Anthropic Messages passthrough
- `POST /v1beta/models/:model:generateContent` — Gemini-style passthrough
- `GET /v1/debug/routes` — route configuration debug view (public through the read-only dashboard session by default)

No payload translation is performed. A request is routed only to upstreams configured for the same native protocol. Duplicate models use ascending `priority` and fall back to the next compatible upstream after retryable upstream failures.

### Public model ids: ":free" suffix stripping

Provider free tiers are often configured with ids like `qwen3.8-flash:free`. Clients should never see that suffix: the gateway **strips a trailing `:free` (case-insensitive) from every configured route id** and exposes the clean id publicly — in `/v1/models`, routing, metrics, and circuit-breaker keys — while calling the upstream with the **real** id (kept internally as the route's `upstreamModel`; an explicit `upstreamModel` in your config still wins). Legacy clients that still send the `:free` id keep working: the request-side alias resolves to the same stripped model. These are genuinely different models from their paid namesakes, not duplicates — a stripped free route and an explicit paid route for the same public id coexist as priority-ordered fallback candidates.

## Admin Dashboard

The dashboard is a static page served at `/admin` (the domain root `/` is the public landing page). By design, opening it creates a signed, read-only session with access to `/metrics`, `/v1/models`, and `/v1/debug/routes`, so those operational views are public when `ADMIN_AUTOAUTH` is enabled (the default). The session cannot call paid proxy routes, which always require a real gateway key.

### Zero credentials in the page

The page is hardened so that a user watching DevTools sees **no credential anywhere**:

- The server injects exactly one meta tag — `gateway-url` (the public URL, not a secret). No API key is ever embedded in the HTML, in any form, for any visitor. (An earlier version echoed a validated Bearer token back into a `<meta>` tag for authenticated requests — removed: the credential then sat in View Source for the whole session.)
- Authentication for the read-only endpoints flows through the short-lived signed session cookie, which is `HttpOnly` — JavaScript, the DevTools console, and the page's network inspector (no `Authorization` header is even sent) never see it.
- All dashboard JavaScript runs inside an IIFE: no connection state, keys, or payloads are reachable as `window.*` globals from the console.
- The optional key input (only needed when `ADMIN_AUTOAUTH=0`) is a masked password field; after Connect the value is cleared from the DOM and kept only in the script closure.
- `/admin` and `/` ship a strict Content-Security-Policy (`default-src 'none'`, no external script/style/network origins) so even an injected script could not exfiltrate anything off-origin.
- The page is served with `Cache-Control: no-store`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.

### Accessing the dashboard

```bash
# Open in a browser — read-only dashboard data loads automatically
open https://your-gateway.vercel.app/admin
```

Set `ADMIN_AUTOAUTH=0` to require an admin or gateway Bearer key for the read-only endpoints; the dashboard then shows the key input bar (paste, connect — the value never leaves your browser's closure).

### What the dashboard shows

Real-time metrics polling every 5 seconds:
- **Stat cards** — total requests, avg latency, total tokens, estimated spend
- **Per-provider breakdown** — requests, 2xx/4xx/5xx, tokens in/out, spend, p50 latency, errors, and circuit breaker state for each provider
- **Latency distribution** — p50/p95/p99 percentile bars
- **Request status** — color-coded 2xx/4xx/5xx bars
- **Circuit breakers** — closed (green), half_open (amber), open (red)
- **Model routes** and **available models** tables

Set `ADMIN_API_KEYS` for separate admin-only access. Falls back to `GATEWAY_API_KEYS` if not set.

## Metrics API

`GET /metrics` returns per-provider and aggregate tracking:

```json
{
  "global": {
    "requests": 42,
    "requests2xx": 40,
    "tokens": { "input": 500, "output": 200, "total": 700, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0 },
    "estimatedSpend": 0.0042,
    "latency": { "p50": 340, "p95": 1200,"p99": 1800,"min": 50,"max": 2000, "count": 42 },
    "upstreamErrors": 2,
    "fallbacks": 1
  },
  "byProvider": {
    "freemodel": { "requests": 20, "tokens": { "total": 300 }, "estimatedSpend": 0.002, ... },
    "unimodel":  { "requests": 22, "tokens": { "total": 400 }, "estimatedSpend": 0.0022, ... }
  },
  "byModel": {
    "claude-sonnet": { "requests": 42, "tokens": { "total": 700 }, ... }
  },
  "circuitBreakers": { "freemodel:claude-sonnet": { "state": "closed", "failures": 0 } },
  "activeRequests": 0,
  "activeStreams": 0
}
```

## Circuit Breakers

Each model has a circuit breaker (identity `model:<id>`, shared by every provider route serving it, so a primary outage cannot cascade into the backup's circuit too):

- Opens after 5 consecutive upstream failures (5xx, 429, timeout)
- Transitions to half-open after 30s cooldown, allowing a probe request
- Closes on success, resets failure count
- Skips open circuits during fallback when alternatives exist
- While a breaker is open, requests that cannot fall back elsewhere answer **503 ServiceUnavailableError** with `Retry-After: 30` — a gateway-side rejection, distinct from a 502 (an upstream was actually called and failed)
- Logs state transitions as `circuit_opened` / `circuit_recovered`

Legacy `provider:model` rows from before the per-model hardening may linger in the metrics store; they are inert and flagged `identity: "legacy"` in `/metrics`.

## Metric definitions (as produced by the gateway)

The `/metrics` response carries a `definitions` object repeating these rules, so consumers never have to guess:

| Field | Definition |
|---|---|
| `requests` | **Upstream attempts** — one record per candidate tried; fallback retries count once per attempt. `requests - fallbacks` approximates client-visible requests. |
| `statusBreakdown."0"` | Attempt produced **no upstream response**: client disconnect, timeout, circuit-open rejection, or gateway config error. |
| `upstreamErrors` | Attempts that failed **against an actual upstream**: 5xx/429 responses, transport errors, timeouts. Excludes client disconnects, circuit-open rejections and config errors. |
| `activeRequests` / `activeStreams` | Upstream attempts / streaming responses with a **live lease right now** (self-healing TTL rows; the old +/- gauge drifted permanently upward — production reached 1,124 phantom "active" requests). |
| `latency` | p50/p95/p99 by **nearest-rank** plus arithmetic mean (`avg`), over the most recent **500 recorded attempts** per bucket (all-time cumulative buckets). A p95/p99 clustered at the upstream timeout means that share of attempts hits the hard timeout — a real population, not gradual slowness. |
| `tokens` | `input` is **uncached-only** input; `cacheRead`/`cacheWrite` are separate buckets; `total = input + cacheRead + cacheWrite + output`. |
| `estimatedSpend` | Estimate from each route's configured per-million `cost` prices × recorded tokens (times `billingMultiplier`). **Not a provider invoice.** |
| daily rollups | Day boundary is **Africa/Lagos (WAT, UTC+1, no DST)** — each day starts at 12am WAT. Retention is **unbounded**; days with no traffic have no row. |
| HTTP methods | The gateway records proxied **POST** traffic only; there is no per-method metric, and the dashboard no longer labels rows "GET". |

`GET /metrics?daily=global` trims the `daily` array to `scope=global` rows (what the built-in dashboard renders); without the parameter the historical all-scopes shape is returned.

## Cost protection

- Per-key request rate limit (token bucket, per warm instance): `RATE_LIMIT_RPS` (default 50), `RATE_LIMIT_BURST` (default 100). Set `RATE_LIMIT_RPS=0` to disable.
- **Optional daily spend ceiling**: set `MAX_DAILY_SPEND_USD` (e.g. `20`) and paid proxy routes answer `429 SpendLimitError` with `Retry-After` once the gateway's **recorded estimated spend** for the current WAT day reaches the ceiling; it resets at 12am WAT. This is a **best-effort brake, not a hard guarantee**: the check is cached (`SPEND_CHECK_TTL_MS`, default 15s) and a request's future output cost is unknowable, so in-flight traffic can overshoot within the window. A metrics-store failure degrades it to disabled (fail-open), consistent with "metrics must never block the proxy path".

## Operations environment variables

| Variable | Default | Purpose |
|---|---|---|
| `METRICS_FLUSH_MS` | `200` | Micro-batch window for metrics writes: per-request events merge into per-bucket accumulators and flush as one statement per touched bucket. At 1000 rps this is ~40 statements per window instead of ~6000 single-row writes. Durability is preserved: each request registers the window flush with the serverless `waitUntil`, so a batch containing its events always persists. |
| `ACTIVE_LEASE_TTL_MS` | `360000` | Lease lifetime for in-flight tracking. Must exceed the longest possible request (Vercel `maxDuration` is 300s); a dropped cleanup write self-heals after this TTL. |
| `MAX_DAILY_SPEND_USD` | unset (off) | Daily estimated-spend ceiling, enforced server-side on paid routes (see above). |
| `SPEND_CHECK_TTL_MS` | `15000` | Cache window for the spend-ceiling check. |
| `ADMIN_STRICT_KEYS` | unset (off) | `1` rejects ordinary gateway keys on the admin surface (`/metrics`, `/v1/debug/routes`) — only `ADMIN_API_KEYS` or the dashboard session authorize them. Default off because single-key deployments and the entry-agents settings dashboard authenticate with the gateway key. `/v1/models` is ordinary OpenAI-compatible surface and is never affected. |
| `DASHBOARD_SESSION_SECRET` | derived | Dedicated HMAC secret for the dashboard session cookie; strongly recommended over key derivation. |

## Required environment

```text
GATEWAY_API_KEYS=one-or-more-comma-separated-client-keys
ADMIN_API_KEYS=optional-separate-admin-keys
MODEL_ROUTES_JSON=[...]
# VERCEL_URL is set automatically by Vercel — no action needed
# For self-hosted, the dashboard auto-detects from the request origin
```

Example route configuration:

```json
[
  {
    "id": "claude-sonnet",
    "name": "Claude Sonnet",
    "protocol": "anthropic-messages",
    "provider": "freemodel",
    "upstreamBaseURL": "https://api.freemodel.dev/v1",
    "upstreamModel": "provider-specific-claude-id",
    "upstreamApiKeyEnv": "FREEMODEL_API_KEY",
    "priority": 10,
    "billingMultiplier": 5,
    "anthropicVersion": "2023-06-01",
    "cost": { "input": 3, "output": 15, "cache_read": 0.3 },
    "context_window": 200000
  },
  {
    "id": "claude-sonnet",
    "protocol": "openai-chat",
    "provider": "unimodel",
    "upstreamBaseURL": "https://www.unimodel.ai/v1",
    "upstreamModel": "provider-specific-claude-id",
    "upstreamApiKeyEnv": "UNIMODEL_API_KEY",
    "priority": 20
  }
]
```

Supported protocol values: `openai-chat`, `anthropic-messages`, `gemini-generate`.
Optional route properties: `upstreamPath`, `authStyle` (`x-api-key` for providers that need it), `headers`, `timeoutMs`, `enabled`, and `maxBodyBytes` (per-route request-body ceiling in bytes; the tighter of this and the global body limit wins).

### Configuration validation

At startup the gateway validates every route source and the discovery config in one pass and logs a single `config_validation` line listing every problem it found. It does **not** throw: a malformed route must never stop the gateway from booting and serving the routes that are valid. It catches string-typed `priority` / `timeoutMs` / `billingMultiplier` / `maxBodyBytes`, `NaN` / `Infinity` values, non-object `cost` entries, malformed `context_over_Nk` tier objects, unknown `protocol` / `authStyle` values, non-http(s) upstream URLs, and provider-key env vars that are not set. Missing keys are reported by **variable name only** -- never by value.

### Operational probes

| Probe | Use | Reads the database? |
|---|---|---|
| `GET /health/live` | orchestrator liveness | no -- pure in-process check |
| `GET /health/ready` | orchestrator readiness; 503 until a route table exists | no |
| `GET /health` | full status: providers, circuit breakers, active requests, build identity | yes |

Liveness deliberately never touches Postgres. A slow or unavailable metrics database must not be able to restart a gateway that is otherwise serving traffic, so point container and orchestrator liveness probes at `/health/live`, not `/health`.

Both `/health/ready` and `/health` report build identity from `GATEWAY_VERSION`, `GIT_SHA` (or Vercel's `VERCEL_GIT_COMMIT_SHA`) and the process boot time, so you can tell which deploy is actually serving.


Optional route properties: `upstreamPath`, `authStyle` (`x-api-key` for providers that need it), `headers`, `timeoutMs`, `enabled`.


## Token Harbor / GLM 5.3 Flash + DeepSeek V4.1 Flash

Token Harbor models are configured through the same additive route-environment pattern used by the other provider integrations. The gateway does **not** hardcode Token Harbor routes or credentials.

Set these server-side in Vercel:

~~~text
TOKEN_HARBOR_BASE_URL=https://tokenharbor.ai/v1
TOKEN_HARBOR_API_KEY=<server-side-secret>
EXTRA_MODEL_ROUTES_JSON_6=[{"id":"glm-5.3-flash","name":"GLM 5.3 Flash","provider":"tokenharbor","upstreamBaseURL":"https://tokenharbor.ai/v1","upstreamModel":"glm-5.3-flash","upstreamApiKeyEnv":"TOKEN_HARBOR_API_KEY","context_window":1000000,"cost":{"input":0.15,"output":0.50}},{"id":"deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","provider":"tokenharbor","upstreamBaseURL":"https://tokenharbor.ai/v1","upstreamModel":"deepseek-v4.1-flash","upstreamApiKeyEnv":"TOKEN_HARBOR_API_KEY","context_window":1000000,"cost":{"input":0.30,"output":1.20,"cache_read":0.006}}]
~~~

GLM 5.3 Flash is available on Token Harbor as `glm-5.3-flash`. Its published price is $0.15 per million input tokens and $0.50 per million output tokens. citeturn0search0

DeepSeek V4.1 Flash is configured here under the non-`:free` model ID `deepseek-v4.1-flash`, with the gateway pricing metadata set to $0.30 input, $0.006 cache-read, and $1.20 output per million tokens.

These are paid Token Harbor routes; there is no `billingMultiplier: 0` or `:free` route in this configuration. Token Harbor's current catalog separately lists the `:free` DeepSeek variants, so the upstream must support the non-`:free` ID before that route can actually serve requests. citeturn1search0turn0search8

## StepFun / Step 5 Preview

StepFun's current platform lists Step 5 Preview. Current API pricing reported for the StepFun API is $1.00 per 1M input tokens and $2.70 per 1M output tokens, with a 95% cache discount (about $0.05 per 1M cached input tokens). The model is in the 1M-token context class and exposes an OpenAI-compatible interface. [1]

Set these server-side in Vercel:

~~~text
STEPFUN_BASE_URL=https://api.stepfun.ai/v1
STEPFUN_API_KEY=<server-side-secret>
EXTRA_MODEL_ROUTES_JSON_7=[{"id":"step-5-preview","name":"Step 5 Preview","provider":"stepfun","upstreamBaseURL":"https://api.stepfun.ai/v1","upstreamModel":"step-5-preview","upstreamApiKeyEnv":"STEPFUN_API_KEY","context_window":1000000,"cost":{"input":1.00,"output":2.70,"cache_read":0.05}}]
~~~

The gateway keeps the route environment-driven; credentials and the active route JSON are not committed to source control.

[1] StepFun's platform currently lists Step 5 Preview; the $1.00/$2.70 pricing and cache discount are reported from the StepFun API by current independent model tracking. [2]
## Model discovery

Set `MODEL_DISCOVERY_JSON` to discover models at startup and every six hours by default:

```json
[
  {
    "provider": "freemodel",
    "url": "https://api.freemodel.dev/v1/models",
    "baseURL": "https://api.freemodel.dev/v1",
    "apiKeyEnv": "FREEMODEL_API_KEY",
    "protocols": ["openai-chat", "anthropic-messages"],
    "priority": 10,
    "aliases": { "provider-model-id": "claude-sonnet" }
  }
]
```

Use `DISCOVERY_REFRESH_MS` to change the interval. Discovery normalizes only the catalog; inference request and response bodies remain native.

## Request IDs and forwarded response headers

Every response -- including 401, 404, 400, 413 and 429 -- carries an `x-gateway-request-id` header. Quote it when asking a provider to look up a failed call.

Upstream response headers are passed through an **allowlist**, not a denylist. Forwarded: `content-type`, `retry-after`, OpenAI and Anthropic rate-limit headers, `openai-version`, `openai-organization`, `openai-processing-ms`. Dropped: `authorization`, `x-api-key`, `proxy-authorization`, `set-cookie`, `www-authenticate`, and `x-gateway-request-id` (which an upstream must never be able to forge).

The upstream's own `x-request-id` is preserved under `x-upstream-request-id`, so provider-side support tickets still work without ever colliding with the gateway's correlation id.

Per-request log lines include a `cache` summary (`inputTokens`, `cachedTokens`, `cacheWriteTokens`, `cacheRatio`, `cacheStatus`). `cacheRatio` is cache-read over total prompt tokens and is always within 0..1.

## Logging and cost tracking

Successful requests log JSON with request ID, model, protocol, provider, latency, TTFT (for streams), token usage, and estimated cost. Costs are per-million-token values in each route's `cost` object. Set `billingMultiplier` when a provider dashboard applies a markup such as UniModel's default 5x; it defaults to 1. Unknown usage or pricing is logged without an estimate. Streaming usage is captured when the upstream emits usage in an SSE event.

## Run

```bash
npm ci
GATEWAY_API_KEYS=local-secret MODEL_ROUTES_JSON='[...]' node server.js
```

Docker/Vercel:

```bash
docker build -t entry-gateway .
docker run --env-file .env -p 8787:8787 entry-gateway
```

Only use upstream keys and models you are authorized to use and comply with their terms.
