import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  recordRequest,
  recordUpstreamError,
  recordBreakerFailure,
  recordBreakerSuccess,
  isCircuitOpen,
  incrGauge,
  getGauge,
  getMetricsSnapshot,
  getAllCircuitBreakers,
  usingRedis,
} from "./metrics-store.js";

const app = express();
// Vercel (and most PaaS) terminate TLS upstream and forward to this
// process over plain HTTP, setting X-Forwarded-Proto: https. Without
// trusting the proxy, Express's req.protocol always reports "http" even
// on a real https:// request -- which made the /admin auto-inject below
// emit an http:// gateway-url, and a browser on the https admin page
// mixed-content-blocks any fetch() to a plain http:// URL (shows up as
// yet another opaque "Failed to fetch").
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));

// CORS: the settings/gateway dashboard on entry-agents.vercel.app calls
// /health, /metrics, /v1/models, /v1/debug/routes directly from the
// browser (client component, no Next.js proxy route in between). Express
// sends no CORS headers by default, so every one of those cross-origin
// fetch() calls was silently blocked by the browser and surfaced to the
// user as a generic "Failed to fetch" -- even with a correct gateway URL
// and API key, since the request never actually reached this server for
// GET requests, and for the CORS preflight OPTIONS it got a 404 with no
// Access-Control-Allow-* headers. Reflecting a small allowlist of known
// dashboard origins (plus localhost for local dev) fixes this without
// opening the API itself to arbitrary origins.
const ALLOWED_ORIGINS = new Set([
  "https://entry-agents.vercel.app",
  "https://entry-agents-thirdbase1s-projects.vercel.app",
  "https://entry-agents-oneshotsx-thirdbase1s-projects.vercel.app",
  "http://localhost:3000",
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || /\.vercel\.app$/.test(new URL(origin).hostname))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
const PORT = Number(process.env.PORT || 8787);
let discovered = [];

const parseJson = (name, fallback) => {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch (e) { console.error(`${name}: invalid JSON: ${e.message}`); return fallback; }
};
const keys = () => new Set((process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean));
const adminKeys = () => new Set((process.env.ADMIN_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean));
const configured = () => (Array.isArray(parseJson("MODEL_ROUTES_JSON", [])) ? parseJson("MODEL_ROUTES_JSON", []) : [])
  .filter(r => r?.id && r?.upstreamBaseURL).map(r => ({ protocol: "openai-chat", priority: 100, enabled: true, ...r }));
const routes = () => {
  const m = new Map();
  for (const r of [...configured(), ...discovered]) m.set(`${r.id}|${r.protocol}|${r.upstreamBaseURL}|${r.upstreamModel || r.id}`, r);
  return [...m.values()];
};
const auth = (req, res, next) => {
  const supplied = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  const valid = keys();
  if (!valid.size) return res.status(500).json({ error: { type: "ConfigError", message: "GATEWAY_API_KEYS is not configured." } });
  if (!valid.has(supplied)) return res.status(401).json({ error: { type: "AuthError", message: "Invalid or missing API key." } });
  next();
};
const adminAuth = (req, res, next) => {
  const supplied = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  const valid = keys();
  const admins = adminKeys();
  if (!valid.size && !admins.size) return res.status(500).json({ error: { type: "ConfigError", message: "No keys configured." } });
  if (admins.size && admins.has(supplied)) return next();
  if (valid.has(supplied)) return next();
  return res.status(401).json({ error: { type: "AuthError", message: "Invalid or missing API key." } });
};
const protocol = path => path === "/v1/messages" ? "anthropic-messages" : path.includes("generateContent") ? "gemini-generate" : "openai-chat";
const modelFor = (req, p) => {
  if (p !== "gemini-generate") return req.body?.model;
  const raw = req.params.modelAction || "";
  const idx = raw.lastIndexOf(":");
  return idx === -1 ? raw || req.body?.model : raw.slice(0, idx);
};
const candidates = (model, p) => routes().filter(r => r.id === model && r.protocol === p && r.enabled !== false).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
const upstreamUrl = (r, p, model) => {
  const base = r.upstreamBaseURL.replace(/\/$/, "");
  const path = r.upstreamPath || (p === "openai-chat" ? "/chat/completions" : p === "anthropic-messages" ? "/messages" : `/models/${encodeURIComponent(r.upstreamModel || model)}:generateContent`);
  return `${base}${path.replace("{model}", encodeURIComponent(r.upstreamModel || model))}`;
};
const headers = (r, p) => {
  const key = process.env[r.upstreamApiKeyEnv];
  const h = { "Content-Type": "application/json", ...(r.headers || {}) };
  if (r.authStyle === "x-api-key" || p === "anthropic-messages") h["x-api-key"] = key;
  else h.Authorization = `Bearer ${key}`;
  if (p === "anthropic-messages" && r.anthropicVersion) h["anthropic-version"] = r.anthropicVersion;
  return h;
};
const usageOf = x => {
  const u = x?.usage || x?.response?.usage || x?.usageMetadata;
  if (!u) return null;
  const promptDetails = u.prompt_tokens_details || u.input_tokens_details || {};
  const completionDetails = u.completion_tokens_details || u.output_tokens_details || {};
  const cacheRead = u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_tokens ?? promptDetails.cached_tokens ?? u.cachedContentTokenCount ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? u.cache_write_tokens ?? promptDetails.cache_write_tokens ?? 0;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    reasoning: u.reasoning_tokens ?? completionDetails.reasoning_tokens ?? u.thoughtsTokenCount ?? 0
  };
};
const costOf = (r, u) => {
  if (!u || !r.cost) return null;
  const cacheRead = Math.min(u.cache_read || 0, u.input || 0);
  const cacheWrite = Math.min(u.cache_write || 0, Math.max(0, (u.input || 0) - cacheRead));
  const uncachedInput = Math.max(0, (u.input || 0) - cacheRead - cacheWrite);
  const cacheReadRate = r.cost.cache_read ?? r.cost.input ?? 0;
  const cacheWriteRate = r.cost.cache_write ?? r.cost.input ?? 0;
  return ((uncachedInput / 1e6) * (r.cost.input || 0) + (cacheRead / 1e6) * cacheReadRate + (cacheWrite / 1e6) * cacheWriteRate + ((u.output || 0) / 1e6) * (r.cost.output || 0)) * (r.billingMultiplier ?? 1);
};

// ─── Metrics + circuit breakers ──────────────────────────────────────────────
//
// Durable, cross-instance state now lives in metrics-store.js (Redis via
// Upstash REST when KV_REST_API_URL/KV_REST_API_TOKEN are set, otherwise
// an in-memory fallback for local dev). See that file for why: this
// process runs as stateless Vercel serverless functions, so a plain
// module-level object here would only ever reflect one instance's slice
// of traffic instead of the gateway's real, aggregate usage.

const startTime = Date.now();

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = x => process.env.REQUEST_LOG !== "false" && console.log(JSON.stringify({ type: "request", at: new Date().toISOString(), ...x }));

// ─── Proxy ────────────────────────────────────────────────────────────────────

async function proxy(req, res, r, p, model, id, isFallback) {
  const key = process.env[r.upstreamApiKeyEnv];
  if (!key) throw new Error(`Missing secret ${r.upstreamApiKeyEnv}`);
  const provider = r.provider || r.upstreamApiKeyEnv || "unknown";

  // Circuit breaker check
  if (await isCircuitOpen(provider, model)) {
    await recordUpstreamError(provider);
    throw new Error(`Circuit breaker open for ${provider}:${model}`);
  }

  const started = Date.now();
  let ttft = null;
  let streaming = false;
  await incrGauge("activeRequests", 1);

  try {
    const response = await fetch(upstreamUrl(r, p, model), {
      method: "POST",
      headers: headers(r, p),
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(Number(r.timeoutMs || 120000)),
    });

    if (response.status >= 500 || response.status === 429) {
      const text = await response.text();
      await recordBreakerFailure(provider, model);
      await recordUpstreamError(provider);
      const e = new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`);
      e.retryable = true;
      throw e;
    }

    res.status(response.status).set("x-gateway-request-id", id);
    for (const [k, v] of response.headers)
      if (!["content-encoding", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase()))
        res.setHeader(k, v);

    let usage = null;
    const contentType = response.headers.get("content-type") || "";

    if (!response.body || !contentType.includes("text/event-stream")) {
      const text = await response.text();
      try { usage = usageOf(JSON.parse(text)); } catch {}
      res.send(text);
    } else {
      streaming = true;
      await incrGauge("activeStreams", 1);
      const reader = response.body.getReader();
      const firstChunk = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunk && ttft === null) ttft = Date.now() - started;
        const text = new TextDecoder().decode(value);
        for (const line of text.split("\n"))
          if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
            try { usage = usageOf(JSON.parse(line.slice(5).trim())) || usage; } catch {}
        res.write(value);
      }
      res.end();
    }

    const latencyMs = Date.now() - started;
    const estimatedCost = costOf(r, usage);

    await recordBreakerSuccess(provider, model);
    await recordRequest(provider, model, response.status, latencyMs, ttft, usage, estimatedCost, isFallback);
    log({ requestId: id, model, protocol: p, provider, status: response.status, latencyMs, ttftMs: ttft, usage, estimatedCost, isFallback });
  } catch (e) {
    await recordBreakerFailure(provider, model);
    await recordUpstreamError(provider);
    throw e;
  } finally {
    await incrGauge("activeRequests", -1);
    if (streaming) await incrGauge("activeStreams", -1);
  }
}

async function handle(req, res) {
  const p = protocol(req.path), model = modelFor(req, p), id = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!model) return res.status(400).json({ error: { type: "ModelError", message: "A model is required." } });
  const available = candidates(model, p);
  if (!available.length) return res.status(404).json({ error: { type: "ModelError", message: `No ${p} route is configured for ${model}.` } });
  const failures = [];
  for (let i = 0; i < available.length; i++) {
    const r = available[i];
    const provider = r.provider || r.upstreamApiKeyEnv || "unknown";
    if (available.length > 1 && (await isCircuitOpen(provider, model))) continue; // skip open circuits if alternatives exist
    try {
      await proxy(req, res, r, p, model, id, i > 0);
      return;
    } catch (e) {
      failures.push(`${provider}: ${e.message}`);
      console.error(JSON.stringify({ type: "upstream_failure", requestId: id, model, protocol: p, provider, error: e.message }));
    }
  }
  if (!res.headersSent) res.status(502).json({ error: { type: "UpstreamError", message: "All compatible upstream routes failed.", requestId: id, failures } });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const [activeRequests, activeStreams, cbDetails] = await Promise.all([
    getGauge("activeRequests"),
    getGauge("activeStreams"),
    getAllCircuitBreakers(),
  ]);
  const circuitBreakers = {};
  for (const [key, cb] of Object.entries(cbDetails)) circuitBreakers[key] = cb.state;
  res.json({
    ok: true,
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    routes: allRoutes.length,
    routedModels: [...new Set(allRoutes.map(r => r.id))],
    providers: configuredProviders,
    circuitBreakers,
    activeRequests,
    activeStreams,
    metricsBackend: usingRedis() ? "redis" : "in-memory (single instance only)",
  });
});

app.get("/metrics", adminAuth, async (_req, res) => {
  const allRoutes = routes();
  const configuredProviders = [...new Set(allRoutes.map(r => r.provider || r.upstreamApiKeyEnv || "unknown"))];
  const configuredModels = [...new Set(allRoutes.map(r => r.id))];

  const snapshot = await getMetricsSnapshot(configuredProviders, configuredModels);

  res.json({
    uptime: Math.floor((Date.now() - startTime) / 1000),
    ...snapshot,
    metricsBackend: usingRedis() ? "redis" : "in-memory (single instance only)",
  });
});

app.get("/v1/models", auth, (_req, res) => {
  const m = new Map();
  for (const r of routes()) {
    const x = m.get(r.id) || { id: r.id, object: "model", name: r.name || r.id, owned_by: r.provider || "gateway", protocols: [], context_window: r.context_window, cost: r.cost };
    if (!x.protocols.includes(r.protocol)) x.protocols.push(r.protocol);
    m.set(r.id, x);
  }
  res.json({ object: "list", data: [...m.values()] });
});

app.post("/v1/chat/completions", auth, handle);
app.post("/v1/messages", auth, handle);
app.post("/v1beta/models/:modelAction", auth, handle);

app.get("/v1/debug/routes", adminAuth, (_req, res) => {
  res.json({
    routes: routes().map(r => ({
      id: r.id,
      protocol: r.protocol,
      provider: r.provider,
      upstreamBaseURL: r.upstreamBaseURL,
      upstreamModel: r.upstreamModel || r.id,
      upstreamApiKeyEnv: r.upstreamApiKeyEnv,
      priority: r.priority ?? 100,
      enabled: r.enabled !== false,
      cost: r.cost,
      context_window: r.context_window,
      source: discovered.includes(r) ? "discovered" : "configured",
    })),
  });
});

// ─── Admin Dashboard ──────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// When serving /admin, inject the gateway URL and admin key from env so the
// dashboard auto-connects with zero manual config on Vercel or self-hosted.
// No adminAuth guard here (unlike /metrics, /v1/debug/routes): this route's
// whole job is to auto-inject the admin key into the page for a zero-config
// visit (see comment above). Gating it behind adminAuth was circular -- a
// plain browser GET has no Authorization header, so it always 401'd before
// the auto-inject logic below ever ran, and the dashboard could never load
// on a first visit. The embedded key is only as exposed as the URL itself.
const serveAdminDashboard = (req, res) => {
  try {
    let html = readFileSync(join(__dirname, "public", "admin.html"), "utf-8");
    // Auto-detect gateway URL: always prefer the actual request host, not
    // process.env.VERCEL_URL. VERCEL_URL resolves to this specific
    // deployment's unique hash subdomain (e.g. entry-gateway-abc123...),
    // which differs from the friendly alias (entry-gateway-six.vercel.app)
    // the browser is actually on -- injecting the hash URL made every
    // fetch() below a cross-origin request depending on CORS, when it
    // could just be same-origin and need no CORS at all.
    const gatewayUrl = `${req.protocol}://${req.get("host")}`;
    // Auto-detect admin key from env (ADMIN_API_KEYS takes priority, then GATEWAY_API_KEYS)
    const adminKey = (process.env.ADMIN_API_KEYS || process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean)[0] || "";
    // Inject into HTML as meta tags the frontend reads
    html = html.replace("</head>", `  <meta name="gateway-url" content="${gatewayUrl}" />
  <meta name="gateway-key" content="${adminKey}" />
</head>`);
    res.set("Content-Type", "text/html").send(html);
  } catch {
    res.status(404).send("Admin dashboard not found.");
  }
};

// Serve the dashboard at the bare domain root, not just /admin -- so you
// can just visit the gateway's normal URL and land straight on the
// credentials/dashboard screen instead of having to remember and type
// "/admin" every time. /admin is kept as an alias for old bookmarks/links.
app.get("/", serveAdminDashboard);
app.get("/admin", serveAdminDashboard);

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discover() {
  const sources = parseJson("MODEL_DISCOVERY_JSON", []);
  if (!Array.isArray(sources)) return;
  const fresh = [];
  for (const s of sources) try {
    const key = process.env[s.apiKeyEnv]; if (!key) continue;
    const response = await fetch(s.url, { headers: { Authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json(), list = Array.isArray(body) ? body : body.data || body.models || [];
    for (const item of list) {
      const upstreamModel = typeof item === "string" ? item : item.id || item.name;
      if (!upstreamModel) continue;
      for (const p of s.protocols || ["openai-chat"])
        fresh.push({ id: s.aliases?.[upstreamModel] || upstreamModel, upstreamModel, protocol: p, provider: s.provider, upstreamBaseURL: s.baseURL, upstreamApiKeyEnv: s.apiKeyEnv, priority: s.priority ?? 100, cost: s.cost, context_window: item.context_window || s.context_window });
    }
  } catch (e) { console.error(`Discovery failed for ${s.provider || s.url}: ${e.message}`); }
  discovered = fresh;
  console.log(`Discovered ${fresh.length} model/protocol routes`);
}

await discover();
setInterval(discover, Number(process.env.DISCOVERY_REFRESH_MS || 21600000)).unref();

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Entry Gateway listening on :${PORT}; models=${[...new Set(routes().map(r => r.id))].join(",") || "none"}`));
}
export default app;
