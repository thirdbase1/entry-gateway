// Entry Gateway -- self-hosted, OpenAI-compatible AI gateway.
//
// Purpose (owner ask, 2026-08-10): give Entry a single API key + base URL
// that exposes "all models", so adding/removing/re-pointing models is a
// config change here (env vars, managed from the Pxxl dashboard) and NEVER
// requires touching or redeploying the Entry codebase.
//
// Endpoints:
//   GET  /health                 - liveness check
//   GET  /v1/models              - list of routed models with pricing/context metadata
//   POST /v1/chat/completions    - OpenAI-compatible completions, proxied to
//                                  whichever upstream the requested model is routed to
//
// Auth: Authorization: Bearer <key> must match one of GATEWAY_API_KEYS
// (comma-separated env var, managed via the Pxxl dashboard -- never via
// CLI/API, per owner's standing secret-management preference).
//
// Model routing: a default map of Entry's current 4 Opencode Zen models is
// built in from OPENCODEZEN_BASE_URL / OPENCODEZEN_API_KEY. To add a model
// (even from a brand-new upstream provider) WITHOUT redeploying this
// service, set MODEL_ROUTES_JSON in the Pxxl dashboard, e.g.:
//
//   [
//     {
//       "id": "some-new-model",
//       "name": "Some New Model",
//       "upstreamBaseURL": "https://example-provider.com/v1",
//       "upstreamApiKeyEnv": "SOME_PROVIDER_API_KEY",
//       "cost": { "input": 1.0, "output": 2.0, "cache_read": 0.1 },
//       "context_window": 128000
//     }
//   ]
//
// (the referenced upstreamApiKeyEnv, e.g. SOME_PROVIDER_API_KEY, must also
// be set as its own env var -- that's the provider's real secret key).
import express from "express";

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 8787;

function getGatewayApiKeys() {
  const raw = process.env.GATEWAY_API_KEYS || "";
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

function defaultModelRoutes() {
  const baseURL = process.env.OPENCODEZEN_BASE_URL;
  const apiKeyEnv = "OPENCODEZEN_API_KEY";

  const opencodeZenModels = [
    {
      id: "kimi-k3",
      name: "Kimi K3",
      description: "Moonshot Kimi K3 -- premium reasoning and coding model.",
      cost: { input: 3.0, output: 15.0, cache_read: 0.3 },
      context_window: 256000,
    },
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      description: "xAI Grok 4.5 -- strong general-purpose reasoning model.",
      cost: { input: 2.0, output: 6.0, cache_read: 0.3 },
      context_window: 256000,
    },
    {
      id: "ling-3.0-flash-free",
      name: "Ling 3.0 Flash (Free)",
      description:
        "Free-tier fast model -- default for chat, and the soft-cutoff downgrade target once monthly credit is exhausted.",
      cost: { input: 0, output: 0, cache_read: 0 },
      context_window: 128000,
    },
    {
      id: "mimo-v2.5-free",
      name: "MiMo v2.5 (Free)",
      description: "Xiaomi MiMo v2.5 -- free-tier model.",
      cost: { input: 0, output: 0, cache_read: 0 },
      context_window: 128000,
    },
  ];

  if (!baseURL) return [];

  return opencodeZenModels.map((m) => ({
    ...m,
    upstreamBaseURL: baseURL,
    upstreamApiKeyEnv: apiKeyEnv,
  }));
}

function getModelRoutes() {
  const routes = new Map();
  for (const route of defaultModelRoutes()) {
    routes.set(route.id, route);
  }

  const overridesRaw = process.env.MODEL_ROUTES_JSON;
  if (overridesRaw) {
    try {
      const overrides = JSON.parse(overridesRaw);
      if (Array.isArray(overrides)) {
        for (const route of overrides) {
          if (route && typeof route.id === "string") {
            routes.set(route.id, route);
          }
        }
      }
    } catch (err) {
      console.error(
        "MODEL_ROUTES_JSON is set but failed to parse as JSON -- ignoring overrides:",
        err.message,
      );
    }
  }

  return routes;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const validKeys = getGatewayApiKeys();

  if (validKeys.size === 0) {
    console.error(
      "GATEWAY_API_KEYS is not set -- refusing all requests until configured in the Pxxl dashboard.",
    );
    return res.status(500).json({
      error: { message: "Gateway is not configured (no API keys set)." },
    });
  }

  if (!token || !validKeys.has(token)) {
    return res.status(401).json({
      error: { type: "AuthError", message: "Invalid or missing API key." },
    });
  }

  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, routedModels: [...getModelRoutes().keys()] });
});

app.get("/v1/models", requireAuth, (_req, res) => {
  const routes = getModelRoutes();
  const data = [...routes.values()].map((route) => ({
    id: route.id,
    name: route.name ?? route.id,
    description: route.description ?? undefined,
    modelType: "language",
    context_window: route.context_window,
    cost: route.cost,
  }));
  res.json({ data, object: "list" });
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  const requestedModel = req.body?.model;
  const routes = getModelRoutes();
  const route = typeof requestedModel === "string" ? routes.get(requestedModel) : undefined;

  if (!route) {
    return res.status(404).json({
      error: {
        type: "ModelError",
        message: `Model ${requestedModel} is not routed by this gateway.`,
      },
    });
  }

  const upstreamApiKey = process.env[route.upstreamApiKeyEnv];
  if (!upstreamApiKey) {
    console.error(
      `Model ${route.id} is routed but its upstream key env var ${route.upstreamApiKeyEnv} is not set.`,
    );
    return res.status(500).json({
      error: {
        type: "ConfigError",
        message: `Upstream API key for model ${route.id} is not configured.`,
      },
    });
  }

  try {
    const upstreamResponse = await fetch(
      `${route.upstreamBaseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${upstreamApiKey}`,
        },
        body: JSON.stringify(req.body),
      },
    );

    res.status(upstreamResponse.status);
    for (const [key, value] of upstreamResponse.headers.entries()) {
      if (
        key.toLowerCase() === "content-encoding" ||
        key.toLowerCase() === "content-length" ||
        key.toLowerCase() === "connection"
      ) {
        continue;
      }
      res.setHeader(key, value);
    }

    if (!upstreamResponse.body) {
      const text = await upstreamResponse.text();
      return res.send(text);
    }

    for await (const chunk of upstreamResponse.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error("Upstream request failed:", err);
    if (!res.headersSent) {
      res.status(502).json({
        error: { type: "UpstreamError", message: "Failed to reach upstream provider." },
      });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Entry Gateway listening on :${PORT}`);
  console.log(`Routed models: ${[...getModelRoutes().keys()].join(", ") || "(none -- check OPENCODEZEN_BASE_URL)"}`);
});
