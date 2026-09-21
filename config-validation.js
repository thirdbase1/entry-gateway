// ─── Startup configuration validation ────────────────────────────────────────
//
// WHY THIS EXISTS: every route lives in operator-supplied JSON env vars, and a
// malformed route used to surface only at request time as an opaque 502
// ("All compatible upstream routes failed") or a bare "Missing secret X" --
// i.e. the operator learned about a typo from a user's failed request, not
// from their own deploy. Worse, several field types were silently coerced
// (`priority: "10"` stringified into a numeric sort, `cost: 0` treated as
// truthy), producing routes that "work" but sort or bill wrong.
//
// This runs once at startup and reports EVERY problem it finds in one pass
// (fail-loud, but not fail-on-the-first-error -- an operator fixing five typos
// should not need five deploys). It deliberately does NOT throw: a bad route
// must never prevent the gateway from booting and serving the routes that ARE
// valid, which is exactly the behavior an operator wants during a partial
// config fix. On Vercel this logs into the deployment's runtime logs; for
// self-hosted/Docker it goes to stdout before the listening line.
//
// Zero dependencies, matching the rest of this repo (no zod, no ajv).

export const KNOWN_PROTOCOLS = new Set(["openai-chat", "anthropic-messages", "gemini-generate"]);
export const KNOWN_AUTH_STYLES = new Set(["bearer", "x-api-key", "x-goog-api-key"]);

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * Validate one route entry. Returns a list of human-readable problems; an
 * empty array means the route is usable as-is.
 */
export function validateRoute(route, index) {
  const where = `route[${index}]${isNonEmptyString(route?.id) ? ` (${route.id})` : ""}`;
  const problems = [];

  if (!isPlainObject(route)) {
    return [`${where}: must be a JSON object`];
  }
  if (!isNonEmptyString(route.id)) problems.push(`${where}: "id" is required and must be a non-empty string`);
  if (!isNonEmptyString(route.upstreamBaseURL)) {
    problems.push(`${where}: "upstreamBaseURL" is required and must be a non-empty string`);
  } else {
    // Reuse the runtime SSRF guard so a route rejected here is one that would
    // have been rejected on its first request anyway.
    try {
      const parsed = new URL(route.upstreamBaseURL);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        problems.push(`${where}: "upstreamBaseURL" must be http(s), got ${parsed.protocol}`);
      }
    } catch {
      problems.push(`${where}: "upstreamBaseURL" is not a parseable URL: ${JSON.stringify(route.upstreamBaseURL)}`);
    }
  }
  if (route.protocol !== undefined && !KNOWN_PROTOCOLS.has(route.protocol)) {
    problems.push(`${where}: unknown protocol ${JSON.stringify(route.protocol)} (expected one of ${[...KNOWN_PROTOCOLS].join(", ")})`);
  }
  if (route.authStyle !== undefined && !KNOWN_AUTH_STYLES.has(route.authStyle)) {
    problems.push(`${where}: unknown authStyle ${JSON.stringify(route.authStyle)} (expected one of ${[...KNOWN_AUTH_STYLES].join(", ")})`);
  }
  // The credential is looked up as process.env[upstreamApiKeyEnv] on every
  // proxied request; a missing name is a guaranteed 502 for that route.
  if (!isNonEmptyString(route.upstreamApiKeyEnv)) {
    problems.push(`${where}: "upstreamApiKeyEnv" is required (the NAME of the env var holding the provider key, never the key itself)`);
  } else if (!isNonEmptyString(process.env[route.upstreamApiKeyEnv])) {
    problems.push(`${where}: env var ${route.upstreamApiKeyEnv} is not set -- this route will fail every request`);
  }

  // Numeric fields that drive routing order, timeouts and billing. A string
  // here is the silent-coercion case: "10" sorts correctly by accident in
  // some engines and not others, and "abc" sorts as NaN.
  for (const field of ["priority", "timeoutMs"]) {
    if (route[field] !== undefined && !isFiniteNumber(route[field])) {
      problems.push(`${where}: "${field}" must be a finite number, got ${JSON.stringify(route[field])}`);
    }
  }
  // Per-route request-body ceiling, enforced by bodySizeGuard after auth.
  if (route.maxBodyBytes !== undefined) {
    if (!isFiniteNumber(route.maxBodyBytes) || route.maxBodyBytes <= 0) {
      problems.push(`${where}: "maxBodyBytes" must be a positive finite number, got ${JSON.stringify(route.maxBodyBytes)}`);
    }
  }
  if (route.billingMultiplier !== undefined && !isFiniteNumber(route.billingMultiplier)) {
    problems.push(`${where}: "billingMultiplier" must be a finite number, got ${JSON.stringify(route.billingMultiplier)}`);
  }
  if (route.context_window !== undefined && !isFiniteNumber(route.context_window)) {
    problems.push(`${where}: "context_window" must be a finite number, got ${JSON.stringify(route.context_window)}`);
  }
  if (route.cost !== undefined) {
    if (!isPlainObject(route.cost)) {
      problems.push(`${where}: "cost" must be an object of per-million-token rates`);
    } else {
      for (const [key, value] of Object.entries(route.cost)) {
        // Nested context_over_Nk tiers are objects; flat rates are numbers.
        if (/^context_over_\d+k$/i.test(key)) {
          if (!isPlainObject(value)) problems.push(`${where}: cost.${key} must be an object of rate overrides`);
        } else if (!isFiniteNumber(value)) {
          problems.push(`${where}: cost.${key} must be a finite number, got ${JSON.stringify(value)}`);
        }
      }
    }
  }
  if (route.headers !== undefined && !isPlainObject(route.headers)) {
    problems.push(`${where}: "headers" must be an object of header name/value pairs`);
  }
  if (route.enabled !== undefined && typeof route.enabled !== "boolean") {
    problems.push(`${where}: "enabled" must be a boolean, got ${JSON.stringify(route.enabled)}`);
  }
  return problems;
}

/** Validate a whole routes array (or whatever a route env var parsed to). */
export function validateRoutes(routes, sourceName) {
  if (routes === undefined || routes === null) return [];
  if (!Array.isArray(routes)) {
    return [`${sourceName}: expected a JSON array of routes, got ${Array.isArray(routes) ? "array" : typeof routes}`];
  }
  return routes.flatMap((route, index) => validateRoute(route, index));
}

/**
 * Run every startup check and log one consolidated report. Returns the total
 * problem count so callers (and tests) can assert on it.
 */
export function validateStartupConfig({ routeSources, discoverySources }) {
  const problems = [];
  for (const [name, value] of routeSources) problems.push(...validateRoutes(value, name));

  if (discoverySources !== undefined && discoverySources !== null && !Array.isArray(discoverySources)) {
    problems.push(`MODEL_DISCOVERY_JSON: expected a JSON array of discovery sources, got ${typeof discoverySources}`);
  } else if (Array.isArray(discoverySources)) {
    discoverySources.forEach((source, index) => {
      const where = `MODEL_DISCOVERY_JSON[${index}]`;
      if (!isPlainObject(source)) { problems.push(`${where}: must be a JSON object`); return; }
      if (!isNonEmptyString(source.url)) problems.push(`${where}: "url" is required`);
      else {
        try {
          const parsed = new URL(source.url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            problems.push(`${where}: "url" must be http(s), got ${parsed.protocol}`);
          }
        } catch {
          problems.push(`${where}: "url" is not a parseable URL: ${JSON.stringify(source.url)}`);
        }
      }
      if (!isNonEmptyString(source.apiKeyEnv)) problems.push(`${where}: "apiKeyEnv" is required`);
      else if (!isNonEmptyString(process.env[source.apiKeyEnv])) {
        problems.push(`${where}: env var ${source.apiKeyEnv} is not set -- this discovery source will be skipped`);
      }
      if (source.protocols !== undefined && !Array.isArray(source.protocols)) {
        problems.push(`${where}: "protocols" must be an array`);
      } else if (Array.isArray(source.protocols)) {
        for (const p of source.protocols) {
          if (!KNOWN_PROTOCOLS.has(p)) problems.push(`${where}: unknown protocol ${JSON.stringify(p)}`);
        }
      }
    });
  }

  if (problems.length) {
    console.error(JSON.stringify({
      type: "config_validation",
      problemCount: problems.length,
      // Truncate defensively: a badly-written env var could in principle
      // produce thousands of near-identical lines.
      problems: problems.slice(0, 100),
    }));
  }
  return problems.length;
}
