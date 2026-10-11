// Static contract tests for the built-in admin dashboard (public/admin.html).
// The 2026-10-10 pass rebuilt the connection state machine and rendering;
// these tests pin the behaviors that must not silently regress:
//   - the DOM ids the script manipulates (connection bar, status, sections);
//   - NO hardcoded "GET" method label on the status breakdown (the gateway
//     only records proxied POST traffic -- every row used to read "GET");
//   - the connection lifecycle: reconnect backoff, out-of-order response
//     guard, last-good-update tracking, stale + partial-failure banners;
//   - accessibility primitives: aria-live status, labelled inputs,
//     scope=col table headers, focus-visible styles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("./public/admin.html", import.meta.url)), "utf-8");

test("1. the DOM contract the script depends on is intact", () => {
  for (const id of [
    "conn-bar", "gwUrl", "gwKey", "connectBtn", "refreshBtn", "statusBadge", "statusText",
    "refreshInfo", "refreshTime", "errorBanner", "staleBanner", "staleText", "emptyState",
    "dashboard", "statGrid", "latencySection", "statusSection", "providerCount", "providerTable",
    "dailyCard", "dailyBadge", "dailyTable", "cacheAvgBadge", "cacheHitSection", "circuitSection",
    "routeCount", "routesTable", "modelCount", "modelsSection",
  ]) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `missing #${id}`);
  }
});

test("2. the status breakdown no longer labels every row GET", () => {
  assert.ok(!/class="method"\s*>GET</.test(html), "the hardcoded GET method cell must not come back -- proxied traffic is POST");
  assert.match(html, /Counts upstream attempts/, "the counting-rule footnote should explain what the rows mean");
});

test("3. connection lifecycle handling exists", () => {
  assert.match(html, /fetchGeneration/, "out-of-order response guard");
  assert.match(html, /fetchInFlight/, "no overlapping polls");
  assert.match(html, /Math\.min\(MAX_POLL_MS/, "exponential backoff, capped");
  assert.match(html, /lastGoodUpdate/, "last successful update is tracked and shown");
  assert.match(html, /staleBanner/, "stale-data banner");
  assert.match(html, /lastGood\./, "per-source last-known-good payloads survive partial failures");
  assert.match(html, /\/metrics\?daily=global/, "the dashboard consumes the trimmed daily payload");
  assert.match(html, /document\.hidden/, "a hidden tab is not hammered with polls");
});

test("4. accessibility primitives are present", () => {
  assert.match(html, /aria-live="polite"/, "connection status announces politely");
  assert.match(html, /role="alert"/, "the error banner is an alert region");
  assert.match(html, /for="gwUrl"/, "gateway URL input is labelled");
  assert.match(html, /for="gwKey"/, "gateway key input is labelled");
  assert.match(html, /scope="col"/, "table headers are announced as column headers");
  assert.match(html, /:focus-visible/, "keyboard focus is visible");
  assert.match(html, /aria-hidden="true"/, "decorative icons are hidden from assistive tech");
});

test("5. provider health uses the worst breaker across models with prefix-safe parsing", () => {
  assert.match(html, /worstBreakerState/, "worst-across-models health (the first-match bug must not return)");
  assert.match(html, /slice\('model:'\.length\)/, "breaker keys are parsed by prefix stripping -- model ids with ':' broke split(':')[1]");
  assert.match(html, /cooldown elapsed/, "stale open breakers are annotated, not shown as live outages");
});

test("6. latency presentation distinguishes the mean from percentiles and flags the timeout ceiling", () => {
  assert.match(html, /'avg'[\s\S]*?'p50'[\s\S]*?'p95'[\s\S]*?'p99'/s, "avg renders as its own series (p50 was mislabeled 'Avg Latency' before)");
  assert.match(html, /timeout population/, "a p95/p99 cluster at the timeout ceiling is explained");
  assert.match(html, /ttft p50/, "time-to-first-token is surfaced");
});
