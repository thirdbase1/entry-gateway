# Entry Gateway — Security Audit (2026-10-11)

Methodology adapted from [Cloudflare's security-audit-skill](https://github.com/cloudflare/security-audit-skill):
source-first, evidence-based. Every finding below carries a source trace and a verdict
(`confirmed` requires a complete source trace; `needs_validation` marks an unresolved
lead with no severity; `rejected` records disproved candidates). Defense-in-depth gaps
are recorded as hardening notes, not vulnerabilities.

Scope: `entry-gateway` (Express, Vercel) and its integration surface with the
`entry-agents` application (Next.js monorepo, `entryagents/entry-agents`).

## Architecture and trust boundaries

```
Browser (Entry Agents admin UI)
   │  Bearer GATEWAY_API_KEY  ← LEAKED to browser via gateway-defaults route
   ▼
entry-agents Next.js server ──(server-side, same key)──► Gateway /v1/* inference
   ▼
Browser (gateway-dashboard.tsx) ──(direct cross-origin fetch w/ key)──► Gateway /metrics
   ▼
Gateway (Express on Vercel) ──► Provider upstreams (per-route server-side keys)
   ▼
Neon Postgres (metrics, breakers, KV)
```

Trust boundaries:
1. Browser → Entry Agents server (better-auth DB-backed session; `users.is_admin`).
2. Browser → Gateway (direct; currently authenticated with the shared inference key).
3. Entry Agents server → Gateway (inference key).
4. Gateway → upstream providers (per-route secrets, server-side only).
5. Gateway → Neon metrics DB (`GATEWAY_METRICS_DATABASE_URL`).

## Confirmed findings (pre-remediation)

### F1. The inference API key is exposed to admin browsers — `confirmed`
- Source: `entry-agents/apps/web/app/api/settings/gateway-defaults/route.ts` returns
  `{ baseUrl, apiKey }` from `process.env` to any user passing `isUserAdmin`.
- The key is then persisted **client-side** in `localStorage`
  (`entry-agents/apps/web/components/gateway-dashboard.tsx`, key
  `entry-gateway-dashboard-connection`) and sent as `Authorization: Bearer` on every
  metrics poll from the browser.
- Impact: any admin-browser compromise (malicious extension, XSS on the app origin,
  shared screen, local disk access) yields a long-lived production credential that
  spends money on every provider. Browser environments must be assumed lower-trust.
- Remediation: this redesign — metrics access moves to a server-to-server workload
  identity; the browser receives only same-origin responses.

### F2. The inference API key authorizes metrics and configuration endpoints — `confirmed`
- Source: `entry-gateway/server.js` `adminAuth` accepts `GATEWAY_API_KEYS` for
  `/metrics` and `/v1/debug/routes` (gateway-key fallback, default on); `modelsAuth`
  also accepts `ADMIN_API_KEYS`.
- Impact: a leaked inference credential (F1, or any downstream consumer) reads
  spend, token volumes, upstream URLs, and provider key *env names*.
- Remediation: Stage 1 — explicit permission boundary (`metricsAuth`); the inference
  key authorizes only `/v1/*` inference.

### F3. The metrics dashboard is public via an auto-issued session — `confirmed` (by design, being removed)
- Source: `server.js` `serveAdminDashboard` issues the `gw_dash` signed cookie to any
  visitor; `adminAuth` accepts it for `/metrics`, `/v1/models`, `/v1/debug/routes`.
- Impact: operational data (spend, routes, upstream hosts) is readable by anyone with
  the gateway URL when `ADMIN_AUTOAUTH` is on (the default).
- Remediation: Stage 1 removes the mechanism entirely; Stage 2 replaces it with an
  authenticated dashboard (email OTP restricted to `entry-agents.dev`).

### F4. Self-hosted image crashes at boot — `confirmed`
- Source: `Dockerfile` COPY list omits `spend-guard.js` while `server.js` imports it.
- Impact: `docker build` of the current tree produces an image that fails with
  `ERR_MODULE_NOT_FOUND` on first request (Vercel unaffected).
- Remediation: Stage 1 fixes the COPY list.

### H1. Hostile-Origin/CORS surface sized for a browser consumer that is being removed — `hardening note`
- The CORS allowlist (`server.js` `ALLOWED_ORIGINS` + preview regex) exists so the
  Entry Agents browser dashboard could call the gateway cross-origin. Once metrics
  move behind workload identity and the dashboard is same-origin, the allowlist is
  removed (Stage 1). Also verified as safe today: the malformed-origin path is
  wrapped, and the allowlist is exact-match plus a bounded regex.

### H2. `/health` exposes route/provider/breaker inventory unauthenticated — `hardening note`
- No secrets, and uptime probes need it; kept public deliberately and documented.
  `/health/live` and `/health/ready` carry no inventory.

## Candidates investigated and rejected
- **`gw_dash` cookie forgery via weak key derivation**: the signing secret is derived
  from the configured API keys; on Vercel, issuance is refused when all keys are
  <16 chars without a dedicated `DASHBOARD_SESSION_SECRET`. Verified `dashTokenValid`
  uses constant-time comparison. (Rejected as exploitable; superseded by removal.)
- **Timing leak in key comparison**: keys compare via SHA-256 digests +
  `timingSafeEqual`; verified no raw-key comparison path remains. (Rejected.)
- **OTP-less waitlist on the landing page**: client-side demo state only; submits
  nowhere, stores nothing. (Rejected; removed in the rebuild anyway.)
- **Metrics spoofing via NaN/Infinity**: every accumulator clamps through `num()`;
  regression-tested. (Rejected.)

## Threat model for the redesigned architecture

Assets: provider API keys (env, server-side), inference API key, metrics data (spend,
tokens, routes), admin-session capability, audit integrity.

Actors: anonymous internet, Entry Agents users (non-admin), Entry Agents admins,
Entry Agents browser malware, the dashboard server (trusted compute).

Boundaries after redesign:
1. Browser → Dashboard server: OTP-issued opaque session cookie (HttpOnly, Secure,
   SameSite=Lax, server-side revocation). OTP issuance restricted to
   `@entry-agents.dev` addresses, code delivered via Resend, 9 digits, single-use,
   hashed at rest, strict attempt/cooldown limits.
2. Dashboard server → Gateway: platform workload identity (Vercel OIDC) — 2h
   non-persistent tokens, audience- and subject-bound (dashboard project,
   production environment), verified by the gateway against Vercel's public JWKS.
   A static, narrowly-scoped `METRICS_BEARER_KEY` exists only for non-Vercel runs.
3. Client apps → Gateway: the inference key, now valid **only** for `/v1/*`.
4. Gateway → providers/DB: unchanged (server-side secrets).

Property check (from the redesign requirements):
- Browser never receives the inference key, master key, or a reusable privileged
  service credential. ✓ (workload identity never leaves server runtimes)
- Entry Agents' users are authenticated by Entry Agents; the dashboard authenticates
  operators via OTP independently. ✓
- The gateway independently verifies metrics authorization (signature + audience +
  subject + environment). ✓
- Metrics permissions are distinct from inference permissions. ✓ (separate
  credentials and middleware; the inference key is rejected on metrics routes)
- A compromised browser session exposes no gateway-wide credential. ✓
- Forged user IDs / headers grant nothing (signature verification, no trust in
  headers). ✓
- Short-lived, narrow-scope, expiring, bounded credentials. ✓ (2h OIDC tokens;
  12h revocable dashboard sessions)
- Administrative (read) actions require separate authorization from inference. ✓
