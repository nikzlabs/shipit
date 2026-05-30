# 161 checklist

## Server
- [x] Add single-flight `/api/oauth/usage` fetch to `ClaudeLimitsProvider` (OAuth bearer, schema parse)
- [x] Lockout state: record `lockedUntil` on 429 (Retry-After or 30min default); no-op triggers while locked
- [x] Reuse access-token expiry pre-check; skip doomed request, keep last-known on skip
- [x] Merge rule: event `usedPct` (non-null) wins; API number fills `null` windows; track `source` + `fetchedAt`
- [x] `refreshNow()` entry point on registry/provider; broadcast updated snapshot over SSE

## Triggers
- [x] One fetch on Claude `auth_complete` (sign-in baseline, `"seed"`)
- [x] `POST /api/limits/refresh` route + `refreshSubscriptionLimits` dep → `refreshNow("manual")`
- [x] Confirm NO automatic per-turn fetch is wired

## Client
- [x] Refresh glyph on `SubscriptionLimitsBadge` pill group (Claude)
- [x] Disabled + countdown while `lockedUntil` in the future
- [x] Explicit unknown (`—`) / reset / stale (dimmed) meter states
- [x] Tooltip shows source (`/usage`) + age + lock state

## Types
- [x] Extend `usage-limits-types.ts` with window `source` + snapshot `lockedUntil`
- [x] Extend `LimitsProvider` interface with optional `refreshNow()`

## Verify
- [x] Provider unit tests: merge, 429 lockout, seed self-skip, event-wins
- [x] Badge unit tests: unknown/reset/stale states, formatAge, meterDisplay
- [x] lint:dev + typecheck clean
- [ ] Manual browser check: low-usage click → percentage appears; locked button greys out (not done — dev preview is heavy/manual; verified via tests only)
