# 135 — Subscription limits badge — checklist

## Phase 0 — Spike (blocking prereqs)

- [x] **Capture the Claude `/api/oauth/usage` endpoint.** Done
      2026-05-19 via direct fetch with the credentials file's OAuth
      bearer (no mitmproxy needed). URL:
      `https://api.anthropic.com/api/oauth/usage`. Headers: plain
      `Authorization: Bearer`. Real body captured at
      `src/server/orchestrator/limits/__fixtures__/claude-usage-max-20x.json`
      and locked in via parser tests. Key finding: the response
      doesn't carry a plan field — derived from
      `claudeAiOauth.subscriptionType` + `rateLimitTier` in the
      credentials file instead.
- [x] **Codex usage source — resolved without an HTTP endpoint.**
      The community-reported `/backend-api/codex/usage` path 401/403s
      even with a valid bearer (it wants a `chatgpt-account-id`
      header and possibly more), so polling it surfaced a permanent
      "auth expired" on the badge. Replaced with the *event-driven*
      source the Codex App Server already pushes: an
      `account/rateLimits/updated` JSON-RPC notification carrying the
      same `primary` (5h) / `secondary` (weekly) windows it draws its
      own `/status` line from. Verified present in prod session logs.
      No `CODEX_USAGE_URL` / `parseCodexUsage` — see the rewritten
      "Codex (OpenAI)" section in `plan.md`.
- [x] **Confirm Claude OAuth scope.** Done 2026-05-19. The CLI's
      existing scopes (`user:file_upload, user:inference,
      user:mcp_servers, user:profile, user:sessions:claude_code`)
      grant access to `/api/oauth/usage` — no extra scope needed.
- [x] **Confirm refresh behavior.** Done 2026-05-19. The CLI
      rotates `.credentials.json` in place when the access token
      nears expiry; the orchestrator re-reads the file on every
      `getAccessToken()` call so refreshes propagate automatically.

## Phase 1 — Claude (verified end-to-end)

Implementation landed and Phase 0 confirmed the endpoint, scope,
and refresh behavior. Ready to ship.

- [x] `SubscriptionLimits` / `SubscriptionLimitsMap` shared types
      (`src/server/shared/types/usage-limits-types.ts`).
- [x] `LimitsProvider` interface (`src/server/orchestrator/limits/types.ts`).
- [x] `ClaudeLimitsProvider` with tolerant schema parser
      (`src/server/orchestrator/limits/claude-limits.ts`).
- [x] `AuthManager.getAccessToken()` reading
      `~/.claude/.credentials.json` (file) and
      `ANTHROPIC_AUTH_TOKEN` (env / dogfooding path), explicitly
      excluding `ANTHROPIC_API_KEY`. Also returns the plan label
      derived from `subscriptionType` + `rateLimitTier` so the
      provider doesn't need its own credentials read.
- [x] `LimitsPoller` — 60s cadence, per-provider failure tracking
      (auth-stall / 429 backoff / exp-backoff for 5xx + schema /
      network), `markAuthRefreshed()` for auth-complete hooks.
- [x] SSE wiring: `subscription_limits` event, initial-connect
      snapshot, broadcast on change.
- [x] Client store entry, `useServerEvents` handler.
- [x] `SubscriptionLimitsBadge` component placed before
      `<UptimeBadge>` in `AppLayout`.
- [x] Unit tests: parser, provider, poller, badge.

## Phase 2 — Codex (event-driven)

The Codex pill is fed by the App Server's `account/rateLimits/updated`
stream rather than an HTTP poll (see Phase 0 above for why). The pill
is blank until the first turn of a session delivers a snapshot — an
accepted trade for using the one source we've *verified* works.

- [x] `CodexLimitsProvider` — *event-fed*, not polled. `setRateLimits()`
      stores the latest pushed windows; `fetch()` returns them enriched
      with the plan tier; `canFetch()` is true once a snapshot has
      arrived (`limits/codex-limits.ts`).
- [x] `CodexAdapter` captures the `account/rateLimits/updated`
      JSON-RPC notification and emits an `agent_rate_limits`
      AgentEvent (`session/agents/codex-adapter.ts`).
- [x] Event plumbing: worker SSE → `ProxyAgentProcess` →
      `wireAgentListeners` calls `recordCodexRateLimits()`, which pushes
      into the provider and fires `markAuthRefreshed("codex")` so the
      pill updates within seconds.
- [x] `CodexAuthManager.getAccessToken()` + `extractCodexPlan()` read
      the `chatgpt_plan_type` JWT claim from `~/.codex/auth.json` for
      the tooltip's plan tier (`limitName` in the payload is null).
- [x] Registered in `app-di.ts` / `index.ts`.
- [x] Verified against the real App Server stream (snapshot observed
      in prod session logs).

## Phase 3 — Header fallback (optional, deferred)

- [ ] Capture `anthropic-ratelimit-unified-*` headers from completed
      turns. Significantly more invasive than this doc — call out
      for completeness rather than as a planned follow-up.

## Open questions resolved during implementation

- [x] Tooltip prose (Open question 1) — shipped with the current
      strings (full breakdown, reset times, plan name); cosmetic, can
      be tuned later without design changes.
- [x] Per-pill provider label — shipped with the name prefix
      ("Claude" / "Codex"); revisit only if brand-icon assets land.

## Risk register

- **Endpoint URL drift.** Both `CLAUDE_USAGE_URL` and
  `CODEX_USAGE_URL` are exported constants — change in one file
  when upstream moves. Logged-with-truncated-body on schema
  mismatch so the next regression is diagnosable from
  orchestrator logs.
- **Stale OAuth tokens.** Provider returns
  `error: "auth expired"` on 401/403; the poller halts that
  provider until `auth_complete` re-fires. No refresh-token
  handling in the orchestrator by design (the CLI does this in
  place).
