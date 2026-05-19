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
- [ ] Capture the Codex `/codex/usage` (or whatever the real path
      turns out to be) against a ChatGPT-plan-authenticated `codex`
      CLI. Update `CODEX_USAGE_URL` and `parseCodexUsage` field
      lists to match the captured shape.
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

## Phase 2 — Codex

Implementation landed in the same change to keep the provider
architecture symmetric; gated by Phase 0 confirmation.

- [x] `CodexLimitsProvider` with tolerant schema parser.
- [x] `CodexAuthManager.getAccessToken()` reading
      `~/.codex/auth.json`.
- [x] Registered in `app-di.ts` / `index.ts` so the pill appears
      whenever Codex credentials are on disk.
- [ ] Verify against the real Codex `/status`-backing endpoint.

## Phase 3 — Header fallback (optional, deferred)

- [ ] Capture `anthropic-ratelimit-unified-*` headers from completed
      turns. Significantly more invasive than this doc — call out
      for completeness rather than as a planned follow-up.

## Open questions to resolve during implementation polish

- [ ] Tooltip prose (Open question 1) — current strings are
      reasonable defaults; revisit after Phase 0 fixtures land.
- [ ] Per-pill provider label — defaulted to name prefix; revisit
      if brand-icon assets land later.

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
