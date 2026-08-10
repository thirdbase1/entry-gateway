# Entry Gateway

Self-hosted, OpenAI-compatible AI gateway for Entry. A single API key +
base URL gives Entry access to every routed model. Adding, removing, or
re-pointing a model is a config change here (env vars, managed from the
Pxxl dashboard) -- Entry's codebase never needs to change or redeploy.

## Endpoints

- `GET /health` -- liveness check, lists currently routed model IDs
- `GET /v1/models` -- OpenAI-style model list, with pricing + context window metadata
- `POST /v1/chat/completions` -- OpenAI-compatible completions (streaming and non-streaming), proxied to whichever upstream the model is routed to

## Deploy

From this directory (`entry_gateway/`), deploy with the Pxxl CLI:

```bash
pxxl login --api-key <your Pxxl API key>
pxxl deploy -m "deploy entry-gateway"
```

First deploy creates the project on Pxxl. To redeploy after a code change:

```bash
pxxl redeploy <project-id>
```

(`pxxl projects list` shows the project id once it exists.)

After the first deploy, set the required env vars from the Pxxl dashboard
(Project -> Settings -> Environment Variables) -- see below -- then trigger
one more redeploy so the running process picks them up.

## Env vars (set these in the Pxxl dashboard)

- `GATEWAY_API_KEYS` -- comma-separated list of keys Entry (or any other caller) must present as `Authorization: Bearer <key>`
- `OPENCODEZEN_BASE_URL` -- e.g. `https://opencode.ai/zen/v1`
- `OPENCODEZEN_API_KEY` -- your Opencode Zen key (kept server-side only, never exposed to callers)
- `PORT` -- optional, defaults to 8787
- `MODEL_ROUTES_JSON` -- optional. A JSON array to add/override routed models without a redeploy

## Adding Opencode Zen (the default provider)

Opencode Zen is already wired in as the built-in default -- you don't need
`MODEL_ROUTES_JSON` for it, just set two env vars in the Pxxl dashboard:

1. `OPENCODEZEN_BASE_URL` = `https://opencode.ai/zen/v1`
2. `OPENCODEZEN_API_KEY` = your Opencode Zen secret key (from the Opencode Zen dashboard)

That alone lights up all 4 default routes: `kimi-k3`, `grok-4.5`,
`ling-3.0-flash-free`, `mimo-v2.5-free` (see `defaultModelRoutes()` in
`server.js`). No redeploy needed if the vars are added after the first
deploy -- Pxxl restarts the process when dashboard env vars change; if it
doesn't, run `pxxl redeploy <project-id>` once.

## Adding any other provider

Every other provider (OpenAI, Anthropic, Groq, a second Opencode-style
gateway, anything with an OpenAI-compatible `/chat/completions` endpoint)
is added the same way, with zero code changes and zero redeploys:

1. In the Pxxl dashboard, set that provider's real secret key as its own
   env var, e.g. `GROQ_API_KEY=...` or `ANTHROPIC_API_KEY=...`. Pick any
   name -- you'll reference it by name in step 2.
2. Set `MODEL_ROUTES_JSON` (also in the Pxxl dashboard) to a JSON array
   describing the model(s) to add. Example -- adding a Groq model
   alongside the existing Opencode Zen ones:

```json
[
  {
    "id": "llama-3.3-70b",
    "name": "Llama 3.3 70B (Groq)",
    "upstreamBaseURL": "https://api.groq.com/openai/v1",
    "upstreamApiKeyEnv": "GROQ_API_KEY",
    "cost": { "input": 0.59, "output": 0.79, "cache_read": 0 },
    "context_window": 128000
  }
]
```

Notes on the fields:

- `id` -- the model id Entry will request (`model` field in the chat completions body). Must be unique across all routes.
- `upstreamBaseURL` -- the provider's OpenAI-compatible base URL (no trailing `/chat/completions`, the gateway appends that).
- `upstreamApiKeyEnv` -- the *name* of the env var holding that provider's real key (set it separately, per step 1 -- never put the raw key inside `MODEL_ROUTES_JSON` itself).
- `cost` -- `input`/`output`/`cache_read`, USD per 1M tokens, used for Entry's pricing/billing display only.
- `context_window` -- used for Entry's pricing/billing display only.

`MODEL_ROUTES_JSON` entries with an `id` that matches a default Opencode
Zen route (e.g. `kimi-k3`) override that route instead of adding a
duplicate -- handy for re-pointing an existing model id at a different
upstream without changing Entry's model picker at all.

After saving env vars in the dashboard, trigger `pxxl redeploy <project-id>`
if the process doesn't pick up the change automatically.

## Currently routed models (default, no MODEL_ROUTES_JSON needed)

All via Opencode Zen: `kimi-k3`, `grok-4.5`, `ling-3.0-flash-free`, `mimo-v2.5-free`.

Note: `kimi-k3` and `grok-4.5` require a payment method on the Opencode
Zen account (workspace billing) -- without one they return a `CreditsError`.
The two `-free` models work without billing.
