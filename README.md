# Entry Gateway

Self-hosted, config-driven native-protocol AI gateway. Clients use one gateway API key; provider keys stay in server-side environment variables managed by Vercel.

## Routes

- `GET /health` — gateway status, uptime, providers, circuit breakers, active requests
- `GET /metrics` — per-provider and aggregate metrics (public through the read-only dashboard session by default)
- `GET /` — public landing page (static, no auth)
- `GET /admin` — built-in public, read-only admin dashboard UI
- `GET /v1/models` — deduplicated public models with protocol metadata
- `POST /v1/chat/completions` — OpenAI-compatible passthrough
- `POST /v1/messages` — Anthropic Messages passthrough
- `POST /v1beta/models/:model:generateContent` — Gemini-style passthrough
- `GET /v1/debug/routes` — route configuration debug view (public through the read-only dashboard session by default)

No payload translation is performed. A request is routed only to upstreams configured for the same native protocol. Duplicate models use ascending `priority` and fall back to the next compatible upstream after retryable upstream failures.

## Admin Dashboard

The dashboard is a static page served at `/admin` (the domain root `/` is the public landing page). By design, opening it creates a signed, read-only session with access to `/metrics`, `/v1/models`, and `/v1/debug/routes`, so those operational views are public when `ADMIN_AUTOAUTH` is enabled (the default). The session cannot call paid proxy routes, which always require a real gateway key.

### Auto-detection

When the server serves `/admin`, it injects meta tags into the HTML:

| Meta tag | Source | Injected when |
|---|---|---|
| `gateway-url` | request origin | always (the URL is not a secret) |
| `gateway-key` | First key from `ADMIN_API_KEYS` (falls back to `GATEWAY_API_KEYS`) | **only when the request already presents a valid Bearer token** |

The `gateway-key` is deliberately **not** embedded for anonymous visitors. An earlier version injected the live admin/gateway key into the page for *anyone* who could reach the URL. Now the key is only auto-injected when the request itself is already authenticated. A normal browser visit uses the read-only session automatically; a real key is only needed for paid proxy calls or when `ADMIN_AUTOAUTH=0`.

### Accessing the dashboard

```bash
# Open in a browser — read-only dashboard data loads automatically
open https://your-gateway.vercel.app/admin

# Or pass the key as a URL hash so the page auto-connects on load
open https://your-gateway.vercel.app/admin#your-admin-key
```

The `#your-admin-key` hash is read client-side and never sent to the server in the request line, so it isn't logged by the gateway or intermediaries.

Set `ADMIN_AUTOAUTH=0` to require an admin or gateway Bearer key for the read-only endpoints.

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

Each `provider:model` pair has a circuit breaker that:
- Opens after 5 consecutive upstream failures (5xx, 429, timeout)
- Transitions to half-open after 30s cooldown, allowing a probe request
- Closes on success, resets failure count
- Skips open circuits during fallback when alternatives exist
- Logs state transitions as `circuit_opened` / `circuit_recovered`

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

Optional route properties: `upstreamPath`, `authStyle` (`x-api-key` for providers that need it), `headers`, `timeoutMs`, `enabled`.

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
