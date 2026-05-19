# 135 — Subscription limits badge — checklist

## Phase 0 — Spike (blocking prereqs)

- [ ] Capture the Claude `/api/oauth/usage` endpoint against a real
      Pro/Max account behind `mitmproxy`. Confirm URL, headers, OAuth
      scope behavior, and the response JSON shape. Save the captured
      response as a test fixture. The provider's `parseClaudeUsage`
      tolerates several name variants (`five_hour`, `session`,
      `utilization`, `used_pct`, fractional vs 0–100) but the
      empirical schema may differ further — adjust the parser to
      match.
- [ ] Capture the Codex `/codex/usage` (or whatever the real path
      turns out to be) against a ChatGPT-plan-authenticated `codex`
      CLI. Update `CODEX_USAGE_URL` and `parseCodexUsage` field
      lists to match the captured shape.
- [ ] Confirm Claude OAuth scope. If the captured request uses a
      scope the persisted ShipIt token doesn't have, the feature is
      not buildable without re-auth — set `status: paused` and stop.
- [ ] Confirm refresh behavior: running the Claude CLI refreshes
      `.credentials.json` in place so the orchestrator never has to
      drive its own refresh-token call.

## Phase 1 — Claude (in-progress)

Implementation landed; depends on Phase 0 to flip on confidently.

- [x] `SubscriptionLimits` / `SubscriptionLimitsMap` shared types
      (`src/server/shared/types/usage-limits-types.ts`).
- [x] `LimitsProvider` interface (`src/server/orchestrator/limits/types.ts`).
- [x] `ClaudeLimitsProvider` with tolerant schema parser
      (`src/server/orchestrator/limits/claude-limits.ts`).
- [x] `AuthManager.getAccessToken()` reading
      `~/.claude/.credentials.json` (file) and
      `ANTHROPIC_AUTH_TOKEN` (env / dogfooding path), explicitly
      excluding `ANTHROPIC_API_KEY`.
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
