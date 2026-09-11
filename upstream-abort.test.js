// Regression tests for client-disconnect abort (PR #6 reworked): an
// abandoned SSE stream must stop consuming upstream tokens. The gateway
// aborts the upstream fetch the moment the client connection closes
// (or the hard timeout fires), cancels the response reader, and cleans
// up its listeners. Same discipline as hardening.test.js: node:test +
// node:http only, zero new dependencies, mock upstreams on ephemeral ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { createUpstreamAbort } from "./upstream-abort.js";

const GW_KEY = "abort-test-gateway-key-0123456789";

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
    return req;
  });
}

test("1a. isAborted() starts false; aborting on client close flips it and logs a structured line", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const h = createUpstreamAbort({ req, res, requestId: "t1", model: "m", protocol: "openai-chat", provider: "p", timeoutMs: 5000 });
  assert.equal(h.isAborted(), false);
  assert.ok(h.signal, "signal must be exposed for fetch()");
  const logged = [];
  const orig = console.error;
  console.error = (x) => logged.push(x);
  try {
    res.emit("close");
    assert.equal(h.isAborted(), true);
  } finally {
    console.error = orig;
  }
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.type, "client_disconnect");
  assert.equal(entry.requestId, "t1");
  h.cleanup();
});

test("1b. cleanup() removes listeners so a later close cannot leak or re-abort", () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const h = createUpstreamAbort({ req, res, requestId: "t2", model: "m", protocol: "openai-chat", provider: "p", timeoutMs: 5000 });
  h.cleanup();
  res.emit("close"); // would throw if cleanup left a stale throwing handler; must not abort
  assert.equal(h.isAborted(), false);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(req.listenerCount("close"), 0);
});

test("1c. the hard timeout aborts too", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const h = createUpstreamAbort({ req, res, requestId: "t3", model: "m", protocol: "openai-chat", provider: "p", timeoutMs: 25 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.isAborted(), true);
  h.cleanup();
});

test("2a. END-TO-END: a client disconnect mid-SSE aborts the upstream fetch", async (t) => {
  let upstreamClosedAfterData = false;
  let upstreamGotAborted = false;
  // Slow SSE upstream: writes one chunk per 50ms forever, records whether
  // its connection is destroyed after having sent data (the observable
  // effect of the gateway cancelling the fetch body).
  const upstream = http.createServer((ureq, ures) => {
    ureq.on("close", () => { if (upstreamSawData) upstreamClosedAfterData = true; });
    ureq.on("aborted", () => { upstreamGotAborted = true; });
    ures.writeHead(200, { "Content-Type": "text/event-stream" });
    ures.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    upstreamSawData = true;
    const iv = setInterval(() => {
      try { ures.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'); } catch { clearInterval(iv); }
    }, 50);
    ureq.on("close", () => clearInterval(iv));
    ures.on("close", () => clearInterval(iv));
  });
  let upstreamSawData = false;
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  process.env.VERCEL = "1"; // don't app.listen()
  process.env.GATEWAY_API_KEYS = GW_KEY;
  delete process.env.ADMIN_API_KEYS;
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    { id: "slow-model", protocol: "openai-chat", provider: "test-upstream", upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`, upstreamApiKeyEnv: "TEST_ABORT_KEY", timeoutMs: 10000 },
  ]);
  process.env.TEST_ABORT_KEY = "dummy";
  process.env.CONFIG_CACHE_MS = "0";
  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  const gateway = http.createServer(app);
  const gatewayPort = await listen(gateway);
  t.after(() => {
    gateway.closeAllConnections?.();
    gateway.close?.();
  });

  // Open a streaming request then kill the client socket after first chunk.
  const chunks = [];
  const clientReq = http.request({
    host: "127.0.0.1", port: gatewayPort, method: "POST", path: "/v1/chat/completions", agent: false,
    headers: { "Authorization": `Bearer ${GW_KEY}`, "Content-Type": "application/json" },
  }, (res) => {
    res.on("data", (c) => { chunks.push(String(c)); clientReq.destroy(); });
  });
  clientReq.end(JSON.stringify({ model: "slow-model", stream: true, messages: [{ role: "user", content: "hi" }] }));

  // Give the gateway time to notice the disconnect and cancel the upstream.
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(chunks.length >= 1, "client must have received at least one SSE chunk before disconnecting");
  assert.ok(upstreamClosedAfterData || upstreamGotAborted, "upstream connection must be torn down after client disconnect (was left streaming until timeout)");
});
