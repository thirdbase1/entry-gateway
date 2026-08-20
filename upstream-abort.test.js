import { createUpstreamAbort } from "./upstream-abort.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const req = new EventEmitter();
const res = new EventEmitter();
const handle = createUpstreamAbort({
  req,
  res,
  requestId: "test_1",
  model: "m",
  protocol: "openai-chat",
  provider: "test",
  timeoutMs: 5000,
});

assert.equal(handle.isAborted(), false);
assert.ok(handle.signal);
req.emit("close");
assert.equal(handle.isAborted(), true);
handle.cleanup();
console.log("upstream-abort.test.js OK");
