import express from "express";

const app = express();
app.use(express.json({ limit: "25mb" }));
const PORT = Number(process.env.PORT || 8787);
let discovered = [];

const parseJson = (name, fallback) => {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch (e) { console.error(`${name}: invalid JSON: ${e.message}`); return fallback; }
};
const keys = () => new Set((process.env.GATEWAY_API_KEYS || "").split(",").map(x => x.trim()).filter(Boolean));
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
const protocol = path => path === "/v1/messages" ? "anthropic-messages" : path.includes("generateContent") ? "gemini-generate" : "openai-chat";
const modelFor = (req, p) => {
  if (p !== "gemini-generate") return req.body?.model;
  // Gemini's real path segment is "<model>:<action>" (e.g. "gemini-pro:generateContent"),
  // joined by a colon with no "/" separator, so it can't be split into two
  // Express route params -- captured whole as :modelAction and parsed here instead.
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
const log = x => process.env.REQUEST_LOG !== "false" && console.log(JSON.stringify({ type: "request", at: new Date().toISOString(), ...x }));

async function proxy(req, res, r, p, model, id) {
  const key = process.env[r.upstreamApiKeyEnv];
  if (!key) throw new Error(`Missing secret ${r.upstreamApiKeyEnv}`);
  const started = Date.now();
  const response = await fetch(upstreamUrl(r, p, model), { method: "POST", headers: headers(r, p), body: JSON.stringify(req.body), signal: AbortSignal.timeout(Number(r.timeoutMs || 120000)) });
  if (response.status >= 500 || response.status === 429) { const text = await response.text(); const e = new Error(`Upstream ${response.status}: ${text.slice(0, 500)}`); e.retryable = true; throw e; }
  res.status(response.status).set("x-gateway-request-id", id);
  for (const [k, v] of response.headers) if (!["content-encoding", "content-length", "connection", "transfer-encoding"].includes(k.toLowerCase())) res.setHeader(k, v);
  let usage = null;
  const contentType = response.headers.get("content-type") || "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    const text = await response.text();
    try { usage = usageOf(JSON.parse(text)); } catch {}
    res.send(text);
  } else {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      for (const line of text.split("\n")) if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") try { usage = usageOf(JSON.parse(line.slice(5).trim())) || usage; } catch {}
      res.write(value);
    }
    res.end();
  }
  log({ requestId: id, model, protocol: p, provider: r.provider || r.upstreamApiKeyEnv, status: response.status, latencyMs: Date.now() - started, usage, estimatedCost: costOf(r, usage) });
}
async function handle(req, res) {
  const p = protocol(req.path), model = modelFor(req, p), id = `gw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!model) return res.status(400).json({ error: { type: "ModelError", message: "A model is required." } });
  const available = candidates(model, p);
  if (!available.length) return res.status(404).json({ error: { type: "ModelError", message: `No ${p} route is configured for ${model}.` } });
  const failures = [];
  for (const r of available) try { await proxy(req, res, r, p, model, id); return; } catch (e) { failures.push(`${r.provider || r.upstreamBaseURL}: ${e.message}`); console.error(JSON.stringify({ type: "upstream_failure", requestId: id, model, protocol: p, error: e.message })); }
  if (!res.headersSent) res.status(502).json({ error: { type: "UpstreamError", message: "All compatible upstream routes failed.", requestId: id, failures } });
}

app.get("/health", (_req, res) => res.json({ ok: true, routes: routes().length, routedModels: [...new Set(routes().map(r => r.id))] }));
app.get("/v1/models", auth, (_req, res) => {
  const m = new Map();
  for (const r of routes()) { const x = m.get(r.id) || { id: r.id, object: "model", name: r.name || r.id, owned_by: "gateway", protocols: [], context_window: r.context_window, cost: r.cost }; if (!x.protocols.includes(r.protocol)) x.protocols.push(r.protocol); m.set(r.id, x); }
  res.json({ object: "list", data: [...m.values()] });
});
app.post("/v1/chat/completions", auth, handle);
app.post("/v1/messages", auth, handle);
app.post("/v1beta/models/:modelAction", auth, handle);

async function discover() {
  const sources = parseJson("MODEL_DISCOVERY_JSON", []);
  if (!Array.isArray(sources)) return;
  const fresh = [];
  for (const s of sources) try {
    const key = process.env[s.apiKeyEnv]; if (!key) continue;
    const response = await fetch(s.url, { headers: { Authorization: `Bearer ${key}`, "x-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json(), list = Array.isArray(body) ? body : body.data || body.models || [];
    for (const item of list) { const upstreamModel = typeof item === "string" ? item : item.id || item.name; if (!upstreamModel) continue; for (const p of s.protocols || ["openai-chat"]) fresh.push({ id: s.aliases?.[upstreamModel] || upstreamModel, upstreamModel, protocol: p, provider: s.provider, upstreamBaseURL: s.baseURL, upstreamApiKeyEnv: s.apiKeyEnv, priority: s.priority ?? 100, cost: s.cost, context_window: item.context_window || s.context_window }); }
  } catch (e) { console.error(`Discovery failed for ${s.provider || s.url}: ${e.message}`); }
  discovered = fresh; console.log(`Discovered ${fresh.length} model/protocol routes`);
}
await discover();
setInterval(discover, Number(process.env.DISCOVERY_REFRESH_MS || 21600000)).unref();
app.listen(PORT, () => console.log(`Entry Gateway listening on :${PORT}; models=${[...new Set(routes().map(r => r.id))].join(",") || "none"}`));
