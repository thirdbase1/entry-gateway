# Entry Gateway — Harness Improvements (2026)

Research-backed changes against current agent-harness practice (identity, durable state, tool policy, verification, audit/rollback; ETCLOVG taxonomy; Datadog AI-gateway guidance; Vercel Workflow durable-agent patterns).

## Shipped in this PR

### Client disconnect aborts upstream fetch

**Problem.** Upstream `fetch` used only `AbortSignal.timeout(...)`. A client that navigated away mid-SSE left the provider call running until the hard timeout (default 120s). That wastes tokens, burns rate-limit budget, and keeps `activeStreams` inflated under load.

**Fix.** In `proxy()`:

1. Build a single `AbortController` for both timeout and client disconnect.
2. Attach `req`/`res` `"close"` listeners that abort with a structured `client_disconnect` log line.
3. Pass `ac.signal` to upstream `fetch` instead of a bare timeout signal.
4. In the SSE read loop, cancel the upstream reader when already aborted (no point draining).
5. Clear the timeout and remove listeners in `finally`.

**Compatibility.** The existing mid-stream fallback guard (`if (res.headersSent)`) is unchanged and remains the correct fail-closed behavior when a candidate already wrote bytes.

## Prior (already on main)

- Fail closed after `headersSent` so priority fallback never retries once the client has received stream bytes (`ERR_HTTP_HEADERS_SENT` fixed).

## Recommended follow-ups (not in this PR)

1. **Idempotency keys** on mutating tools + in-run result cache (Workflow step retries must not double-apply side effects).
2. **Verification as a first-class step** after model “done” (test/typecheck/health gates; model self-report ≠ task complete).
3. **Cost-aware routing hints** in agent `prepareCall` (exploration/subagents → cheaper tier; recovery → frontier).
4. **Structured JSONL persistence** of the existing `log()` lines (request id, usage, cost, disconnect vs timeout).
5. **Canonical model registry** so `/v1/models`, costing, and analytics share one pricing source.

## References

- Datadog: AI gateway best practices (failover, circuit breakers, cancel abandoned work)
- Vercel Workflow / WorkflowAgent: durable steps, client disconnect / resumable streams
- Agent harness surveys 2026 (ETCLOVG; identity, durable state, tool policy, verification, audit)
