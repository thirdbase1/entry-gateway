// ─── Optional server-side daily spend ceiling ─────────────────────────────────
//
// Until now the gateway's only cost protections were the per-key request
// rate limit (a first-line brake, per warm instance) and the circuit
// breakers. There was NO spend-based guard: a runaway or compromised client
// could burn unbounded provider credit as long as it stayed under the RPS
// limit (the production gateway had already billed $84 of estimated spend
// with nothing to stop a bad weekend from multiplying it).
//
// MAX_DAILY_SPEND_USD (unset/0 = disabled, the default) adds a best-effort
// ceiling: before proxying, the gateway checks the estimated spend already
// recorded for the current WAT day and rejects with 429 + Retry-After when
// it is at/over the ceiling.
//
// ENFORCEMENT MODEL, honestly stated: this is a best-effort ceiling, not a
// hard guarantee. The check reads recorded spend through a short cache (to
// keep the hot path off the database), and the spend a request WILL incur is
// unknowable before its upstream response, so concurrent in-flight requests
// can overshoot the ceiling within the cache window. It bounds runaway
// spend; it cannot make it exact. Recorded spend is the gateway's own
// ESTIMATE from configured prices (estimatedSpend in the metrics store) --
// the same figure the dashboards show.

// Pure decision: should this request be allowed given the day's recorded
// spend? Split from I/O so it is unit-testable without a database.
export function evaluateSpendLimit(spentUsd, limitUsd) {
  if (!(limitUsd > 0)) return { allowed: true, spent: spentUsd || 0, limit: 0 };
  const spent = Number(spentUsd) || 0;
  return {
    allowed: spent < limitUsd,
    spent,
    limit: limitUsd,
  };
}

// Africa/Lagos (WAT) is fixed UTC+1 with no DST (same assumption as
// metrics-store.js's localDay()), so the daily ceiling resets at 23:00 UTC.
// Returns whole seconds until the next reset, minimum 1.
export function secondsUntilNextWatMidnight(now = Date.now()) {
  const WAT_OFFSET_MS = 3600_000;
  const DAY_MS = 86_400_000;
  const watNow = now + WAT_OFFSET_MS;
  const dayIndex = Math.floor(watNow / DAY_MS);
  const nextResetUtc = (dayIndex + 1) * DAY_MS - WAT_OFFSET_MS;
  return Math.max(1, Math.ceil((nextResetUtc - now) / 1000));
}
