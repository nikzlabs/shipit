# 161 checklist

## Server
- [ ] Add single-flight `/api/oauth/usage` fetch to `ClaudeLimitsProvider` (OAuth bearer, schema parse)
- [ ] Lockout state: record `lockedUntil` on 429 (Retry-After or 30min default); no-op triggers while locked
- [ ] Reuse `isAccessTokenExpired` pre-check; skip doomed request, keep last-known on skip
- [ ] Merge rule: event `usedPct` (non-null) wins; API number fills `null` windows; track `source` + `fetchedAt`
- [ ] `refreshNow()` entry point on registry/provider; broadcast updated snapshot over SSE

## Triggers
- [ ] One fetch on Claude `auth_complete` (sign-in baseline)
- [ ] `refresh_subscription_limits` WS message (or HTTP route) + handler → `refreshNow()`
- [ ] Confirm NO automatic per-turn fetch is wired

## Client
- [ ] Refresh glyph on `SubscriptionLimitsBadge` pill
- [ ] Disabled + countdown while `lockedUntil` in the future
- [ ] Tooltip shows source (event vs. usage endpoint) + age

## Types
- [ ] Extend `usage-limits-types.ts` with `source` / `lockedUntil` as needed
- [ ] Extend `LimitsProvider` interface if `refreshNow()` is added there

## Verify
- [ ] At low usage, click refresh → real percentage appears
- [ ] Spamming refresh stays disabled during lockout; never re-trips 429
- [ ] Near-limit live event still overrides the manual number
- [ ] lint:dev + typecheck clean
