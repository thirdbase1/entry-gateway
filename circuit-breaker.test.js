import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.GATEWAY_METRICS_DATABASE_URL;

const {
  getCircuitBreaker,
  isCircuitOpen,
  recordBreakerFailure,
  recordBreakerSuccess,
} = await import(`./metrics-store.js?circuit-test=${Date.now()}`);

test("concurrent failures are serialized and open the circuit", async () => {
  await Promise.all(
    Array.from({ length: 10 }, () => recordBreakerFailure("concurrent-provider", "concurrent-model")),
  );

  const cb = await getCircuitBreaker("concurrent-provider", "concurrent-model");
  assert.equal(cb.state, "open");
  assert.equal(cb.failures, 10);
});

test("a success resets the consecutive-failure count", async () => {
  const provider = "recovery-provider";
  const model = "recovery-model";
  await Promise.all(Array.from({ length: 4 }, () => recordBreakerFailure(provider, model)));
  await recordBreakerSuccess(provider, model);

  const cb = await getCircuitBreaker(provider, model);
  assert.equal(cb.state, "closed");
  assert.equal(cb.failures, 0);
});

test("a failed half-open probe reopens the circuit", async () => {
  const provider = "probe-provider";
  const model = "probe-model";
  await Promise.all(Array.from({ length: 5 }, () => recordBreakerFailure(provider, model)));
  const opened = await getCircuitBreaker(provider, model);

  const realNow = Date.now;
  Date.now = () => opened.openedAt + opened.cooldownMs + 1;
  try {
    assert.equal(await isCircuitOpen(provider, model), false);
  } finally {
    Date.now = realNow;
  }

  await recordBreakerFailure(provider, model);
  const reopened = await getCircuitBreaker(provider, model);
  assert.equal(reopened.state, "open");
  assert.equal(reopened.failures, 6);
  assert.ok(reopened.openedAt >= opened.openedAt);
});
