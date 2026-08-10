# Entry Gateway

Self-hosted, OpenAI-compatible AI gateway for Entry. A single API key +
base URL gives Entry access to every routed model. Adding, removing, or
re-pointing a model is a config change here (env vars, managed from the
Pxxl dashboard) -- Entry's codebase never needs to change or redeploy.

## Endpoints

- `GET /health` -- liveness check, lists currently routed model IDs
- `GET /v1/models` -- OpenAI-style model list, with pricing + context window metadata
- `POST /v1/chat/completions` -- OpenAI-compatible completions (streaming and non-streaming), proxied to whichever upstream the model is routed to

## Env vars (set these in the Pxxl dashboard)

- `GATEWAY_API_KEYS` -- comma-separated list of keys Entry (or any other caller) must present as `Authorization: Bearer <key>`
- `OPENCODEZEN_BASE_URL` -- e.g. `https://opencode.ai/zen/v1`
- `OPENCODEZEN_API_KEY` -- your Opencode Zen key (kept server-side only, never exposed to callers)
- `PORT` -- optional, defaults to 8787
- `MODEL_ROUTES_JSON` -- optional. A JSON array to add/override routed models without a redeploy, e.g. to bring in a brand-new upstream provider:

```json
[
  {
    "id": "some-new-model",
    "name": "Some New Model",
    "upstreamBaseURL": "https://example-provider.com/v1",
    "upstreamApiKeyEnv": "SOME_PROVIDER_API_KEY",
    "cost": { "input": 1.0, "output": 2.0, "cache_read": 0.1 },
    "context_window": 128000
  }
]
```

(the referenced `upstreamApiKeyEnv`, e.g. `SOME_PROVIDER_API_KEY`, must
also be set as its own env var with that provider's real secret key.)

## Currently routed models (default, no MODEL_ROUTES_JSON needed)

All via Opencode Zen: `kimi-k3`, `grok-4.5`, `ling-3.0-flash-free`, `mimo-v2.5-free`.

Note: `kimi-k3` and `grok-4.5` require a payment method on the Opencode
Zen account (workspace billing) -- without one they return a `CreditsError`.
The two `-free` models work without billing.
