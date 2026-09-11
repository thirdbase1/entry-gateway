// Regression test for the 2026-09-10 owner request: daily history rows
// must roll at 12am Nigeria time (Africa/Lagos, WAT = fixed UTC+1, no
// DST), not UTC midnight. A request at 22:59 UTC belongs to the
// current Lagos day; one at 23:00 UTC (midnight Lagos) starts the next
// day's bucket. Guards against anyone "simplifying" localDay() back to
// a plain UTC slice.
import { test } from "node:test";
import assert from "node:assert/strict";

// No GATEWAY_METRICS_DATABASE_URL -> in-memory path; we only call
// localDay(), which touches no backend either way.
const { localDay } = await import("./metrics-store.js");

const realNow = Date.now;
const withFixedNow = (utcMs, fn) => {
  Date.now = () => utcMs;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
};

test("before 23:00 UTC the day key is the current Lagos calendar day", () => {
  // 2026-09-10 22:59:59Z == 2026-09-10 23:59:59 in Lagos
  const d = withFixedNow(Date.UTC(2026, 8, 10, 22, 59, 59), localDay);
  assert.equal(d, "2026-09-10");
});

test("at 23:00 UTC (midnight Lagos) the day key rolls to the next day", () => {
  // 2026-09-10 23:00:00Z == 2026-09-11 00:00:00 in Lagos
  const d = withFixedNow(Date.UTC(2026, 8, 10, 23, 0, 0), localDay);
  assert.equal(d, "2026-09-11");
});

test("Lagos day matches UTC day for the first 23 hours of the UTC day", () => {
  // 2026-09-10 00:30:00Z == 2026-09-10 01:30 in Lagos
  const d = withFixedNow(Date.UTC(2026, 8, 10, 0, 30, 0), localDay);
  assert.equal(d, "2026-09-10");
});

test("leap into a new month rolls correctly (30/31-boundary)", () => {
  // 2026-09-30 23:00:00Z == 2026-10-01 00:00 Lagos
  const d = withFixedNow(Date.UTC(2026, 8, 30, 23, 0, 0), localDay);
  assert.equal(d, "2026-10-01");
});
