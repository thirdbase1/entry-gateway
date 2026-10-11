// Tests for the metrics permission boundary's Vercel-OIDC path.
//
// metricsAuth verifies platform-issued JWTs against a JWKS endpoint. These
// tests spin up a LOCAL JWKS server (jose-generated ES256 keypair) and boot
// the gateway with METRICS_OIDC_* pointing at it, then assert the full
// acceptance/rejection matrix: valid token, wrong audience, wrong issuer,
// wrong subject, expired, foreign key signature, and the static fallback key
// coexisting with OIDC.
//
// Same discipline as the rest of the repo: node:test + node:http only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT, exportPKCS8 } from "jose";

const GW_KEY = "oidc-test-gateway-key-0123456789";
const METRICS_FALLBACK = "oidc-test-metrics-fallback-0123456789";
const ISSUER_BASE = "http://127.0.0.1:0"; // replaced after the JWKS server binds
let jwksServer;
let jwksPort;
let privateKey;
let foreignPrivateKey;
const bootResults = { booted: false };

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body != null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

test.before(async () => {
  privateKey = await generateKeyPair("ES256", { extractable: true });
  foreignPrivateKey = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(privateKey.publicKey);
  publicJwk.alg = "ES256";
  publicJwk.use = "sig";
  publicJwk.kid = "test-key-1";

  jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  jwksPort = await listen(jwksServer);

  process.env.VERCEL = "1";
  process.env.GATEWAY_API_KEYS = GW_KEY;
  process.env.METRICS_BEARER_KEY = METRICS_FALLBACK;
  process.env.METRICS_OIDC_ISSUER = `http://127.0.0.1:${jwksPort}`;
  process.env.METRICS_OIDC_AUDIENCE = "https://gateway.test/audience";
  process.env.METRICS_OIDC_SUBJECT = "owner:test-team:project:entry-gateway-dashboard:environment:production";
  process.env.METRICS_OIDC_JWKS_URL = `http://127.0.0.1:${jwksPort}/jwks`;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.OIDC_UP_KEY = "dummy";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "oidc-model", protocol: "openai-chat", provider: "prov-oidc", upstreamBaseURL: "http://127.0.0.1:1", upstreamApiKeyEnv: "OIDC_UP_KEY" },
  ]);
  const { default: app } = await import(`./server.js?oidc=${Date.now()}`);
  gateway = http.createServer(app);
  gatewayPort = await listen(gateway);
  bootResults.booted = true;
});

let gateway;
let gatewayPort;

test.after(async () => {
  gateway?.closeAllConnections?.();
  gateway?.close?.();
  jwksServer?.closeAllConnections?.();
  jwksServer?.close?.();
});

function sign({ audience = "https://gateway.test/audience", issuer = `http://127.0.0.1:${jwksPort}`, subject = "owner:test-team:project:entry-gateway-dashboard:environment:production", key = privateKey, expiry = "2h" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ })
    .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(now - 5)
    .setExpirationTime(expiry === null ? now - 60 : now + (expiry === "2h" ? 7200 : 0))
    .sign(key.privateKey ?? key);
}

test.before(async () => {
  bootResults.ok = bootResults.booted;
});

const metrics = (token) => request(gatewayPort, { path: "/metrics", headers: { Authorization: `Bearer ${token}` } });

test("1. a valid platform OIDC token grants /metrics and /v1/debug/routes", async () => {
  const token = await sign();
  const r = await metrics(token);
  assert.equal(r.status, 200, `valid OIDC token must be accepted (got ${r.status}: ${r.body.slice(0, 140)})`);
  const d = await request(gatewayPort, { path: "/v1/debug/routes", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(d.status, 200);
});

test("2. a token with the wrong audience is rejected", async () => {
  const token = await sign({ audience: "https://other-service/audience" });
  const r = await metrics(token);
  assert.equal(r.status, 401);
});

test("3. a token with the wrong issuer is rejected", async () => {
  const token = await sign({ issuer: "https://oidc.evil.example" });
  const r = await metrics(token);
  assert.equal(r.status, 401);
});

test("4. a token with a subject binding a different project is rejected", async () => {
  const token = await sign({ subject: "owner:test-team:project:some-other-app:environment:production" });
  const r = await metrics(token);
  assert.equal(r.status, 401);
});

test("5. an expired token is rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
    .setIssuer(`http://127.0.0.1:${jwksPort}`)
    .setAudience("https://gateway.test/audience")
    .setSubject("owner:test-team:project:entry-gateway-dashboard:environment:production")
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(privateKey.privateKey);
  const r = await metrics(token);
  assert.equal(r.status, 401);
});

test("6. a token signed by a foreign key (bad signature) is rejected", async () => {
  const token = await sign({ key: foreignPrivateKey });
  const r = await metrics(token);
  assert.equal(r.status, 401);
});

test("6b. a token with the platform GLOBAL issuer (federation mode toggle) is accepted", async () => {
  // The operator can flip Vercel OIDC federation between team and global mode;
  // the key sets are identical, and audience + subject still bind the token to
  // the dashboard project, so both issuers must be accepted.
  const token = await sign({ issuer: "https://oidc.vercel.com" });
  const r = await metrics(token);
  assert.equal(r.status, 200, "global-issuer token must be accepted");
});

test("7. the static fallback key still works alongside OIDC", async () => {
  const r = await metrics(METRICS_FALLBACK);
  assert.equal(r.status, 200);
});

test("8. the inference key and garbage credentials stay rejected", async () => {
  assert.equal((await metrics(GW_KEY)).status, 401);
  assert.equal((await metrics("not.a.jwt")).status, 401);
  assert.equal((await request(gatewayPort, { path: "/metrics" })).status, 401);
});

test("9. METRICS_OIDC_EXPECT_PROJECT blocks a token whose subject lacks the project", async () => {
  process.env.METRICS_OIDC_EXPECT_PROJECT = "entry-gateway-dashboard";
  try {
    // Valid signature/iss/aud, but the subject names a different project.
    const token = await sign({ subject: "owner:test-team:project:unrelated-app:environment:production" });
    const r = await metrics(token);
    assert.equal(r.status, 401, "expect-project must hard-block non-dashboard subjects");
    const good = await metrics(await sign());
    assert.equal(good.status, 200, "the dashboard's own token still passes");
  } finally {
    delete process.env.METRICS_OIDC_EXPECT_PROJECT;
  }
});

test("10. /v1/models accepts both the inference key and the metrics credential", async () => {
  assert.equal((await request(gatewayPort, { path: "/v1/models", headers: { Authorization: `Bearer ${GW_KEY}` } })).status, 200);
  assert.equal((await request(gatewayPort, { path: "/v1/models", headers: { Authorization: `Bearer ${METRICS_FALLBACK}` } })).status, 200);
});

test("11. paid proxy routes still require the inference key only", async () => {
  const oidc = await metrics(await sign());
  assert.equal(oidc.status, 200); // sanity: metrics credential works on /metrics
  const r = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${METRICS_FALLBACK}`, "Content-Type": "application/json" },
    body: { model: "oidc-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 401, "the metrics credential must never authorize inference");
});
