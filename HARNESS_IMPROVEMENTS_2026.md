# Entry Gateway — Harness Improvements (2026)

Research-backed changes against current agent-harness practice (identity, durable state, tool policy, verification, audit/rollback; ETCLOVG taxonomy; Datadog AI-gateway guidance; Vercel Workflow durable-agent patterns).

## Shipped in this PR

### Client disconnect aborts upstream fetch

**Problem.** Upstream `fetch` used only `AbortSignal.timeout(...)`. A client that navigated away mid-SSE left the provider call running until the hard timeout (default 120s). That wastes tokens, burns rate-limit budget, and keeps `activeStreams` inflated under load.

**Fix.**

1. New module `upstream-abort.js` exports `createUpstreamAbort()` — single `AbortController` for timeout **and** client disconnect (`req`/`res` `"close"`), with structured `client_disconnect` logging and `cleanup()`.
2. `server.js` imports the helper, wires `upstreamAbort.signal` into upstream `fetch`, bails the SSE reader when aborted, and always calls `cleanup()` in `finally`.
3. `upstream-abort.test.js` covers disconnect → aborted signal.
4. Apply with: `bash scripts/apply-client-disconnect-abort.sh`

**Compatibility.** The existing mid-stream fallback guard (`if (res.headersSent)`) is unchanged.

## Prior (already on main)

- Fail closed after `headersSent` so priority fallback never retries once the client has received stream bytes.

## Recommended follow-ups

1. Idempotency keys on mutating tools + in-run result cache
2. Verification as a first-class harness step
3. Cost-aware routing hints in agent `prepareCall`
4. Structured JSONL persistence of gateway `log()` lines
5. Canonical model registry for pricing

## References

- Datadog: AI gateway best practices
- Vercel Workflow / WorkflowAgent: durable steps, client disconnect
- Agent harness surveys 2026 (ETCLOVG)
