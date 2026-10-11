// One-off rewrite of security.test.js sections 1, 6, 7 for the Stage 1
// permission boundary: the HTML dashboard and landing page are gone (redirect
// / 410), the gw_dash session no longer exists, the inference key no longer
// grants metrics access, and a METRICS_BEARER_KEY does.
import { readFileSync, writeFileSync } from "node:fs";

let s = readFileSync("security.test.js", "utf8");
const start = s.indexOf('test("1a. /admin does NOT leak the admin key to an unauthenticated visitor"');
const section6Start = s.indexOf("// ─── 6. Dashboard auto-auth (signed HttpOnly session, no key entry) ──────────");
const section5bStart = s.indexOf('test("5b. each retryable upstream response counts as one breaker failure"');

// Replace section 1 (lines from 1a through just before section 2).
const s1Start = start;
const s2Start = s.indexOf('test("2. Host header is HTML-attribute-escaped');
const section1New = `test("1a. /admin no longer serves a dashboard -- it redirects or answers 410", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/admin" });
  assert.ok(!body.includes("<html") && !body.includes("<!DOCTYPE"), "the gateway must not serve HTML anymore");
  assert.ok(status === 302 || status === 410, \`expected 302 redirect or 410 gone, got \${status}\`);
  if (status === 302) {
    assert.match(headers.location || "", /admin\\.entry-agents\\.dev|^\\//, "redirect target must be the configured dashboard URL");
  }
  assert.ok(!headers["set-cookie"], "the gateway must never issue a session cookie anymore");
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY), "no key may appear in any response body");
});

test("1b. even a valid Bearer token gets no HTML dashboard and no cookie", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/admin", headers: { Authorization: \`Bearer \${ADMIN_KEY}\` } });
  assert.ok(status === 302 || status === 410);
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY));
  assert.ok(!headers["set-cookie"], "the legacy gw_dash session must not come back");
});

test("1c. the HTML dashboard files are gone from the repo and the response", async () => {
  const { body } = await request(gatewayPort, { path: "/admin" });
  assert.ok(!body.includes("Gateway Admin"), "old dashboard markup must not be served");
  assert.ok(!body.includes("gw_dash"), "legacy session cookie name must not appear");
});

`;

// Replace section 6 (from section-6 marker through just before 5b) with the
// metrics-boundary tests, keeping 5b where it sits.
const section6New = `// ─── 6. Metrics permission boundary (inference key restricted) ───────────────

test("6a. the inference API key can no longer read /metrics or /v1/debug/routes", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status, body } = await request(gatewayPort, { path, headers: { Authorization: \`Bearer \${GW_KEY}\` } });
    assert.equal(status, 401, \`\${path} must reject the inference key (got \${status})\`);
    assert.match(body, /AuthError/);
    assert.ok(!body.includes("upstreamBaseURL"), "route configuration must not leak on rejection");
  }
});

test("6b. a forged or stale gw_dash session cookie is rejected everywhere", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status } = await request(gatewayPort, { path, headers: { Cookie: "gw_dash=1750000000000.abcdef0123456789" } });
    assert.equal(status, 401, \`\${path} must reject the removed session cookie\`);
  }
});

test("6b-2. the metrics fallback key reads /metrics and /v1/debug/routes", async () => {
  for (const path of ["/metrics", "/v1/debug/routes"]) {
    const { status, body } = await request(gatewayPort, { path, headers: { Authorization: \`Bearer \${METRICS_KEY}\` } });
    assert.equal(status, 200, \`\${path} must accept METRICS_BEARER_KEY (got \${status}: \${body.slice(0, 120)})\`);
  }
});

test("6c. the metrics fallback key must NOT unlock paid proxy routes", async () => {
  const { status } = await request(gatewayPort, {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: \`Bearer \${METRICS_KEY}\`, "Content-Type": "application/json" },
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(status, 401, "the metrics credential must never authorize inference");
});

test("6d. legacy ADMIN_API_KEYS are ignored entirely (deprecated privilege)", async () => {
  const { status } = await request(gatewayPort, { path: "/metrics", headers: { Authorization: \`Bearer \${ADMIN_KEY}\` } });
  assert.equal(status, 401, "ADMIN_API_KEYS must no longer grant metrics access");
  const models = await request(gatewayPort, { path: "/v1/models", headers: { Authorization: \`Bearer \${ADMIN_KEY}\` } });
  assert.equal(models.status, 401, "ADMIN_API_KEYS must not work on /v1/models either");
});

test("6e. a stale/legacy gw_dash-style admin session cannot reach /v1/models", async () => {
  const { status } = await request(gatewayPort, { path: "/v1/models", headers: { Cookie: "gw_dash=1750000000000.deadbeefcafebabe" } });
  assert.equal(status, 401);
});

`;

// Replace section 7 (from the section-7 marker to the end of 7d) with the
// redirect tests.
const s7Start = section7Start(s);
function section7Start(src) {
  return src.indexOf("// ─── 7. Landing page at \"/\"");
}
const tail = s.slice(section6Start);
const after5b = tail.indexOf('test("5b.');
// Build the final file: head (through end of section 5) + new section 6 + 5b..end-of-5-section + new section 7.
const before5b = s.slice(0, section6Start);
const from5b = s.slice(section5bStart);
// Find where section 7 content ends (end of 7d) to truncate old 7.
const s7EndMarker = 'test("7d. /admin still serves the dashboard after the landing page landed"';
const s7dIdx = from5b.indexOf(s7EndMarker);
let from5bTrimmed = from5b;
if (s7dIdx !== -1) {
  const end7 = from5b.indexOf("});", from5b.indexOf("assert", s7dIdx));
  from5bTrimmed = from5b.slice(0, s7dIdx) + from5b.slice(end7 + 4);
}
const section7New = `// ─── 7. Root path: redirect, never HTML ──────────────────────────────────────

test("7a. / redirects to the dashboard or answers 410 -- no HTML is served", async () => {
  const { status, body, headers } = await request(gatewayPort, { path: "/" });
  assert.ok(status === 302 || status === 410, \`expected 302 or 410, got \${status}\`);
  assert.ok(!body.includes("<!DOCTYPE") && !body.includes("OpenAIThirdParty"), "the old landing page must be gone");
  if (status === 302) assert.match(headers.location || "", /admin\\.entry-agents\\.dev|^\\//);
});

test("7b. / never reflects the Host header (no HTML surface remains)", async () => {
  const { body, headers } = await request(gatewayPort, { path: "/", headers: { Host: 'x"><script>alert(1)</script>' } });
  assert.ok(!body.includes("<script>alert(1)</script>"));
  if (headers.location) assert.ok(!headers.location.includes("script"), "redirect target must not reflect the Host header");
});

test("7c. / never leaks any API key", async () => {
  const { body } = await request(gatewayPort, { path: "/" });
  assert.ok(!body.includes(ADMIN_KEY) && !body.includes(GW_KEY) && !body.includes(METRICS_KEY));
});

`;

s = before5b + section6New + from5bTrimmed;

// Splice in the new section 1 (before section 2) and section 7 (before the
// error-handling comment at the very end).
const s2Idx = s.indexOf('test("2. Host header is HTML-attribute-escaped');
s = s.slice(0, s1Start) + section1New + s.slice(s2Idx);
const errHandlerIdx = s.indexOf("// ─── Error handling ───");
s = s.slice(0, errHandlerIdx) + section7New + s.slice(errHandlerIdx);

writeFileSync("security.test.js", s);
console.log("security.test.js rewritten; admin.html refs:", s.includes("admin.html"), "| landing refs:", s.includes("serveLandingPage"));
