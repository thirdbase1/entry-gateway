# Entry Gateway

Self-hosted, config-driven native-protocol AI gateway. Clients use one gateway API key; provider keys stay in server-side environment variables managed by Pxxl.

## Routes

- `GET /health`
- `GET /v1/models` — deduplicated public models with protocol metadata
- `POST /v1/chat/completions` — OpenAI-compatible passthrough
- `POST /v1/messages` — Anthropic Messages passthrough
- `POST /v1beta/models/:model:generateContent` — Gemini-style passthrough

No payload translation is performed. A request is routed only to upstreams configured for the same native protocol. Duplicate models use ascending `priority` and fall back to the next compatible upstream after retryable upstream failures.

## Required environment

```text
GATEWAY_API_KEYS=one-or-more-comma-separated-client-keys
MODEL_ROUTES_JSON=[...]
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

Successful requests log JSON with request ID, model, protocol, provider, latency, token usage, and estimated cost. Costs are per-million-token values in each route's `cost` object. Set `billingMultiplier` when a provider dashboard applies a markup such as UniModel's default 5x; it defaults to 1. Unknown usage or pricing is logged without an estimate. Streaming usage is captured when the upstream emits usage in an SSE event.

## Run

```bash
npm ci
GATEWAY_API_KEYS=local-secret MODEL_ROUTES_JSON='[...]' node server.js
```

Docker/Pxxl:

```bash
docker build -t entry-gateway .
docker run --env-file .env -p 8787:8787 entry-gateway
```

Only use upstream keys and models you are authorized to use and comply with their terms.
