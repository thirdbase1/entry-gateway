// Integration test for the res.headersSent fallback-retry guard in
// handle() (server.js). Regression test for the bug found 2026-08-20:
// a mid-stream upstream failure on candidate #1 used to cause the loop
// to retry candidate #2, which crashed on res.setHeader() (headers
// already sent) and left the real client connection half-written,
// never cleanly closed.
//
// Uses only Node built-ins (node:test, node:http) -- this repo has no
// existing test framework/dependencies, so this intentionally adds
// zero new deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const GATEWAY_KEY = "test-gateway-key";

// Spins up a bare-bones upstream mock that: sends SSE headers + one
// data chunk, then abruptly destroys the socket -- simulating a real
// mid-stream provider disconnect (not a clean stream end).
function startFailingUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // Abrupt mid-stream drop: destroy the socket instead of res.end().
    setImmediate(() => req.socket.destroy());
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// A second, healthy upstream. If the fallback bug regresses, the
// gateway would incorrectly retry this candidate after candidate #1's
// mid-stream failure -- this test asserts it is NEVER hit.
function startHealthyUpstream(hitCounter) {
  const server = http.createServer((req, res) => {
    hitCounter.count += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"should not be reached"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test("handle() fails closed instead of retrying after a mid-stream upstream failure", async () => {
  const healthyHits = { count: 0 };
  const failingUpstream = await startFailingUpstream();
  const healthyUpstream = await startHealthyUpstream(healthyHits);

  const failingPort = failingUpstream.address().port;
  const healthyPort = healthyUpstream.address().port;

  process.env.VERCEL = "1"; // prevent server.js from calling app.listen()
  process.env.GATEWAY_API_KEYS = GATEWAY_KEY;
  process.env.MODEL_DISCOVERY_JSON = "[]";
  process.env.TEST_UPSTREAM_A_KEY = "dummy-a";
  process.env.TEST_UPSTREAM_B_KEY = "dummy-b";
  process.env.MODEL_ROUTES_JSON = JSON.stringify([
    {
      id: "test-model",
      protocol: "openai-chat",
      provider: "providerA",
      priority: 1,
      upstreamBaseURL: `http://127.0.0.1:${failingPort}`,
      upstreamApiKeyEnv: "TEST_UPSTREAM_A_KEY",
      enabled: true,
      cost: { input: 0, output: 0 },
    },
    {
      id: "test-model",
      protocol: "openai-chat",
      provider: "providerB",
      priority: 2,
      upstreamBaseURL: `http://127.0.0.1:${healthyPort}`,
      upstreamApiKeyEnv: "TEST_UPSTREAM_B_KEY",
      enabled: true,
      cost: { input: 0, output: 0 },
    },
  ]);

  // Import after env vars are set -- configured()/routes() read them
  // lazily per-call, but discover() runs once at module top-level await,
  // so MODEL_DISCOVERY_JSON must already be "[]" by then.
  const { default: app } = await import(`./server.js?t=${Date.now()}`);
  const gateway = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, () => resolve(s));
  });
  const gatewayPort = gateway.address().port;

  try {
    const { statusCode, headers, chunks, ended } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            Authorization: `Bearer ${GATEWAY_KEY}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const collected = [];
          res.on("data", (chunk) => collected.push(chunk.toString()));
          res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, chunks: collected, ended: true }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "hi" }] }));
      req.end();
      // Safety timeout: if the bug regresses and the connection hangs
      // open forever instead of closing, fail the test instead of
      // hanging the whole suite.
      setTimeout(() => reject(new Error("Response never ended -- connection left hanging open")), 5000);
    });

    // The client should see candidate #1's partial data, then a clean
    // close -- not a second candidate's response and not a hang.
    assert.equal(statusCode, 200, "should have gotten candidate #1's headers, already sent before it failed");
    assert.match(chunks.join(""), /partial/, "should have received candidate #1's partial chunk before the drop");
    assert.doesNotMatch(chunks.join(""), /should not be reached/, "must NOT have fallen through to candidate #2 after headers were already sent");
    assert.equal(ended, true, "response must be cleanly closed, not left hanging");
    assert.equal(healthyHits.count, 0, "candidate #2 (healthy fallback) must never receive a request once headers were already sent by candidate #1");
  } finally {
    gateway.close();
    failingUpstream.close();
    healthyUpstream.close();
  }
});
