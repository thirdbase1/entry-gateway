# Architecture Decision Record: Entry Agents → Gateway metrics access

Date: 2026-10-11 · Status: accepted · Deciders: gateway owner + redesign agent

## Context

The gateway's `/metrics` and `/v1/debug/routes` must be reachable by the new admin
dashboard without exposing or relying on the inference API key, and metrics
permissions must be distinct from inference permissions. Both workloads run on
Vercel: the gateway (Express function, project `entry-gateway`) and the new dashboard
(Next.js 16, project `entry-gateway-dashboard`, this repo's `dashboard/` directory).
Entry Agents (`entry-agents` project) is a separate Next.js monorepo that today
fetches metrics from the browser with the shared inference key (finding F1).

## Options considered

### Option 1 — Backend-for-frontend with a static scoped key
The dashboard server holds a `METRICS_BEARER_KEY`; the gateway compares it
constant-time and scopes it to metrics routes only.
- Security: browser never sees it; but it is a long-lived reusable secret shared
  between two projects (rotation is manual; any dashboard-side leak is reusable).
- Complexity: trivial. Deployment: works everywhere.

### Option 2 — Platform workload identity (Vercel OIDC) ✅ chosen (primary)
The dashboard's server presents the platform-issued OIDC token
(`x-vercel-oidc-token`, audience-exchanged via `@vercel/oidc`
`getVercelOidcToken({ audience })`); the gateway verifies it with `jose` against
Vercel's public JWKS, checking issuer (team-scoped), audience, subject
(`owner:<team>:project:entry-gateway-dashboard:environment:<env>`), and expiry.
- Security: **no shared secret exists at all**; tokens are 2h, non-persistent,
  platform-minted, bound to project + environment; a compromised dashboard runtime
  cannot mint anything outside its identity; the browser never touches a credential.
- Complexity: gateway adds `jose` + JWKS caching (~40 lines); dashboard uses
  `@vercel/oidc` (~10 lines). Latency: JWKS cached; verification is local crypto.
- Deployment: requires both workloads on Vercel and OIDC federation enabled
  (team mode). A static `METRICS_BEARER_KEY` fallback covers Docker/self-hosted,
  keeping the same middleware contract.

### Option 3 — Short-lived signed assertions (Ed25519/HMAC)
The dashboard signs `{iat, exp, aud, scope}` assertions; the gateway verifies a
public key.
- Security: equivalent strength to OIDC for this topology.
- Complexity: higher than OIDC (key generation, rotation, distribution) with no
  added property on a single platform. Rejected.

### Option 4 — Embedded dashboard / iframe sharing the gateway session
Render the gateway's dashboard inside Entry Agents via iframe.
- Security: cross-site iframe cookie semantics (SameSite/ third-party cookie
  deprecation) make session sharing fragile; embedding does not solve the
  service-auth problem at all. Rejected as the *primary* mechanism; the new
  dashboard UI is componentized so Entry Agents can reuse the components behind its
  own server proxy later.

## Decision

Option 2 (Vercel OIDC) as the primary credential path, with Option 1's static key as
an explicitly-scoped fallback for self-hosted deployments only. The dashboard issues
its own operator sessions (email OTP + opaque server-side sessions) — independent of
the gateway's inference credentials. The gateway's inference key is restricted to
`/v1/*` exclusively.

## Required properties → mechanism mapping

| Property | Mechanism |
|---|---|
| Browser never receives a privileged credential | Browser polls same-origin dashboard API; OIDC token exists only in the dashboard's server runtime |
| Gateway independently verifies authorization | `jose.jwtVerify` against Vercel JWKS (signature, iss, aud, sub, exp) |
| Metrics permissions ≠ inference permissions | Separate credentials (`METRICS_BEARER_KEY`/OIDC vs `GATEWAY_API_KEYS`) and separate middleware; inference key rejected on metrics routes |
| Compromised browser session ⇒ no gateway-wide credential | The browser holds only a revocable dashboard session cookie; no service credential is ever sent to it |
| Forged user IDs / headers grant nothing | All authorization derives from verified JWT claims or a hashed session row; request headers are never trusted |
| Short-lived, narrow scope, expiring, revocable | 2h OIDC tokens bound to project+environment; 12h dashboard sessions with server-side revocation rows; audit log for auth events |
| Works on the actual platform | Both workloads are Vercel projects; Vercel OIDC federation is a platform setting |

## Consequences

- Gateway gains a `jose` dependency and a JWKS cache; fails closed on verification
  errors, with `METRICS_BEARER_KEY` as the documented non-Vercel path.
- Entry Agents' existing browser dashboard breaks when the restriction lands
  (scheduled after the new dashboard is live); its remediation — server-side proxy or
  linking to the new dashboard — lives in the entry-agents repository.
- Auth state (OTP hashes, sessions, audit) lives in the same Neon Postgres the
  gateway already uses; new tables are additive (`gw_admin_otp`, `gw_admin_sessions`,
  `gw_admin_audit`).
