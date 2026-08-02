---
issue: https://linear.app/shipit-ai/issue/SHI-235
description: Show Claude subscription limits at low usage (where the CLI stream reports nothing) via a budget-aware manual refresh of /api/oauth/usage, without reintroducing the 429 lockout.
---

# 161 — Limits at low usage: budget-aware manual refresh

## Summary

The subscription-limits pill is blank whenever usage is **below a warning
threshold** — i.e. most of the time, including exactly when the user wants
to glance at "how much do I have left before I start a big run." We want the
number to be visible at low usage too, without bringing back the 429 lockout
that killed the original poller.

## Problem

Today (post `docs/135` "event-fed" switch, commit `d73e59605`) Claude limits
flow **only** from the CLI's `rate_limit_event` stream messages:

```
Claude CLI response headers (anthropic-ratelimit-unified-*)
  → ClaudeAdapter "rate_limit_event" (adapter.ts:210)
  → agent_rate_limits event
  → recordAgentRateLimits → ClaudeLimitsProvider.setRateLimits
  → LimitsRegistry → SSE subscription_limits → SubscriptionLimitsBadge
```

The fatal gap is in `parseRateLimitWindow` (adapter.ts:449) and its doc
comment (adapter.ts:440): **Claude CLI 2.1.140 only includes `utilization`
once a warning threshold trips** (`anthropics/claude-code#50518`). Below that
threshold the CLI sends `{ rateLimitType, resetsAt }` and no number, so the
window is stored as `usedPct: null` and the badge degrades to countdown-only
(or blank if no turn has run). **The low-usage percentage simply is not
present in the CLI stream.** No amount of wiring on our side recovers a number
the CLI never emits.

The only source of the low-usage number is the endpoint we deleted:
`GET https://api.anthropic.com/api/oauth/usage` (the canonical source the CLI
itself uses to populate `/usage`).

## The hard constraint (why "just do it in the orchestrator" won't fix it)

This is the important finding. The orchestrator-centralized, turn-driven design
the user is imagining **was already built and then deliberately removed.** The
deleted `limits-poller.ts` already:

- ran in the **single orchestrator process** with one **account-global** cache
  (one fetch served every open session);
- refreshed **on each agent turn** (`triggerProviderRefresh`) with a **90s
  per-provider debounce**;
- kept only a long (30-min) safety heartbeat, not a tight timer;
- honored `Retry-After` and backed off on 429.

It still failed, because `/api/oauth/usage` is **server-side rate-limited to a
handful of calls, then returns 429 for ~30 minutes** — a known Anthropic-side
bug affecting Claude Code itself and the whole status-line community
(`anthropics/claude-code#31637`, `#30930`). During **active** agent use —
precisely when the user cares — even a 90s-debounced per-turn fetch exhausts
the budget within a few turns and locks the badge onto stale data for half an
hour. That lockout is what motivated the event-fed rewrite.

**Conclusion:** centralizing harder does not help. The budget is roughly *a few
calls per 30 minutes per account*, full stop. The design question is not "how do
we poll smarter," it's "how do we spend a near-zero budget on the moments the
user actually wants the number."

## Recommendation: human-gated refresh, not auto-polling

Spend the scarce budget only when the user explicitly asks, plus one cheap
fetch at sign-in for an initial baseline. Keep the free event-fed path for the
high-resolution near-limit signal.

### 1. Keep event-fed as-is

`rate_limit_event` remains the primary, free, accurate-near-the-limit source.
When the CLI reports a real `utilization`, that wins. No change to the adapter.

### 2. Add a single on-demand `/api/oauth/usage` fetch path (orchestrator)

Reintroduce a **minimal** Claude usage fetcher — not a poller. It is invoked
only by explicit triggers (below), and is:

- **Single-flight + globally cached.** One in-flight request per process; all
  callers await the same promise. Result cached in the existing
  `LimitsRegistry` per `AgentId`.
- **Hard lockout-aware.** On 429, record `lockedUntil` (= `now + Retry-After`,
  or `now + 30min` default). While locked, every trigger is a no-op that
  returns the cached snapshot; the UI shows a countdown instead of erroring.
- **Expiry-pre-check** (reuse the old `isAccessTokenExpired` /
  `LIMITS_SKIP_TICK` logic): if the shared credential's `expiresAt` is past,
  skip the doomed request and keep last-known numbers — do **not** refresh the
  shared token ourselves (blast radius — see docs/135 notes).

### 3. Triggers (deliberately sparse)

- **On sign-in / first auth_complete:** one fetch → seeds an initial baseline so
  the pill isn't blank on a fresh session. (One call, rare.)
- **Manual "refresh" control on the pill:** a small refresh affordance on
  `SubscriptionLimitsBadge`. Clicking sends a `refresh_subscription_limits` WS
  (or POST) → orchestrator runs the single-flight fetch → broadcasts the
  updated snapshot. Disabled with a countdown while `lockedUntil` is in the
  future, so spamming it can't trip (or re-trip) the 429.
- **On opening the mobile status dropdown.** The mobile header has no room for
  the pills, so they live behind a gauge button (`MobileStatusPanel`) — and
  mobile has no hover, so the tooltip's age/plan detail is unreachable. Opening
  that dropdown is an unambiguous "show me my usage", i.e. the same intent as a
  refresh click, so it spends one call on open rather than making the user tap
  the glyph as a second step. Still human-gated, still lockout-aware, and
  additionally **throttled client-side** to one automatic call per
  `AUTO_REFRESH_MIN_INTERVAL_MS` (5 min) so repeatedly opening the dropdown
  can't burn the budget: worst case 6 calls per 30 min, and a ≤5-min-old
  reading is well inside the 15-min staleness threshold. A manual press stamps
  the same throttle, so open-then-tap doesn't double-spend. Radix unmounts
  `PopoverContent` on close, so "the panel mounted" *is* "the dropdown opened";
  the trigger is a mount effect on the refresh button, which also means the
  existing spinner covers the automatic fetch.
- **No automatic per-turn fetch, and no timer-based refresh.** This is the key
  departure from the old design: auto-fetching on turns is exactly what burned
  the budget during active use. Every spend traces to a deliberate user action
  (sign-in, refresh click, opening the status dropdown) — never to the clock.

### Merge rule

In the provider/registry: event `usedPct` (when non-null) takes precedence as
the freshest near-limit number; the manual/sign-in API number fills the
baseline whenever the event stream has only `usedPct: null`. Track a per-window
`source` + `fetchedAt` so the tooltip can say where the number came from and how
old it is.

## Pill display states (the confusing-information fix)

The current pill renders `Claude 5h · resets in 4h` whenever `usedPct` is
`null` — a reset countdown with **no percentage**, which *looks* like real
usage data but actually means "we don't know your usage." That's the confusing
state. Each window must instead read its state explicitly. Per window, from
`usedPct`, `resetAt`, and the snapshot's `fetchedAt`:

| State | Condition | Pill text | Gauge | Tooltip |
|-------|-----------|-----------|-------|---------|
| **Known** | `usedPct != null`, `resetAt` not elapsed | `5h 42%` (tier color; countdown appended above 90%) | yes | `5h window: 42% used (resets …)` + age |
| **Just reset** | `resetAt` elapsed | `5h · reset` (muted) | no | `5h window just rolled over — usage ~empty, refresh to confirm` |
| **Unknown** | `usedPct == null`, not elapsed | `5h · —` (muted) | no | `Usage not reported yet — run a turn near the limit or click refresh. Resets …` |
| **Stale** | Known but `now − fetchedAt` > 15 min | same as Known, **dimmed** | yes, dimmed | `… (updated N min ago)` |

Key rule: **the reset countdown is never the headline for Unknown.** It moves
to the tooltip; the visible text is an explicit "—" so the user can tell at a
glance "ShipIt doesn't know this number" from "ShipIt knows it's 42%." Stale vs.
just-reset vs. never-known are the three flavors of "no live number," and the
user asked for them to be visually distinct — Unknown shows `—`, Just-reset
shows `reset`, Stale shows a dimmed last-known number with an age in the tooltip.

The **refresh button** (`⟳`) sits at the end of each pill — one per
**subscription**, not per-window, and not one globally (see "Follow-up:
multi-account" below, which corrects the original account-global design).
States:

- **Idle** — clickable; click → `POST /api/limits/refresh` with this pill's
  `routeId` → single-flight `/api/oauth/usage` fetch → SSE rebroadcast.
- **In-flight** — spinner while the fetch is outstanding.
- **Locked** — disabled with a countdown title (`Rate-limited — retry in N min`)
  while `lockedUntil` is in the future, so it can't re-trip the 429.
- **Failed** — warning glyph in the high-context color, with the reason in the
  tooltip, when the attempt returned an outcome other than `updated`.

## On the manual button vs. product principle §5

§5 forbids **shell-shaped affordances** — buttons/palettes/hotkeys that run a
workspace command the agent could run. A refresh control on an **account-global
status indicator** is not that: it doesn't operate on the repo, doesn't invoke
the agent, and runs no shell. It's a reload glyph on a status widget (peer to
the existing badges), analogous to a "retry" on a failed network fetch. It stays
on the right side of §5. It is also the *most* budget-efficient primitive we
have: it spends a call only on deliberate user intent.

## Tradeoffs

- **Pro:** low-usage number becomes visible on demand; near-limit stays live and
  free; the 429 lockout is structurally avoided because spends are human-gated
  and lockout-guarded.
- **Con:** the low-usage number is pull, not push — it's as fresh as the user's
  last click (or sign-in), not continuously live. Given the upstream bug, this
  is the realistic ceiling; continuous low-usage numbers are not achievable
  without Anthropic fixing the endpoint.
- **Rejected — revert to auto-polling at any cadence:** already tried, trips the
  documented 429 lockout during active use. See "hard constraint" above.
- **Rejected — refetch every N minutes (even 30):** during a working session
  that's still wall-clock polling, which the upstream bug punishes; and 30 min is
  too stale for the user's stated need anyway.

## Follow-up: the two sources report utilization on different scales

Merging the two sources exposed a scale mismatch that made the badge *worse*
than blank: a refresh showed the true `5h 92%`, then the next turn's
`rate_limit_event` overwrote it with `5h 1%`.

The two sources do not agree on units, verified on one account at one moment:

| Source | 5h | 7d |
|---|---|---|
| `GET /api/oauth/usage` (the refresh button) | `6.0` | `67.0` |
| `anthropic-ratelimit-unified-{5h,7d}-utilization` header → CLI `rate_limit_event` | `0.06` | `0.66` |

The CLI forwards the header verbatim, so its `utilization` is a **0–1
fraction** while the usage endpoint's is a **0–100 percentage**.
`parseRateLimitWindow` read the fraction as a percentage, storing `0.92` for a
92% window; the badge rounds that to `1%`, draws a ~1%-wide meter, and drops
the `resets in …` countdown (which only renders above 90%). The weekly meter
kept its correct 65% purely by accident — at 65% the CLI is below its warning
threshold, so it sent no `utilization` at all and the merge kept the API's
number. The fix scales the event value by 100, with a passthrough for values
`> 1` so an upstream switch to 0–100 degrades to correct numbers rather than a
badge pinned at 100%.

Note also that the header's `resetsAt` is bucketed to the hour (`20:00Z`) where
`/api/oauth/usage` returns the true reset (`21:20Z`), so the countdown can be
up to an hour early depending on which source last won the merge. Cosmetic;
not addressed.

## Follow-up: multi-account broke the button, four ways

With a second Claude subscription connected, the **primary** account's pill sat
at `5h · — 7d · —` and its refresh button did nothing, while the second
account's pill showed live numbers. Four compounding causes, all of which trace
back to this doc's original **account-global** framing of the refresh:

1. **The button was unscoped, so one press spent every account's budget.**
   `POST /api/limits/refresh` took only `agentId`, and `LimitsRegistry.refreshNow`
   fans out over `provider.routeIds()` when no route is given. The budget is
   *per subscription* and allows only a handful of calls per ~30 min — so with
   two accounts, pressing the pill that showed no numbers was the fastest way
   to 429-lock both, including itself. The fan-out is still correct for the
   once-per-sign-in seed; it was never right for a button press.
2. **A locked-out route with no prior reading reported nothing at all.**
   `ClaudeLimitsProvider.fetch` returned `null` when it had neither an event nor
   an API reading — dropping `lockedUntil` on the floor for *exactly* the route
   whose button looks broken. An account 429'd before it ever reported a number
   rendered an **enabled** button that silently no-op'd for ~30 minutes. It now
   returns a lockout-only snapshot, so that pill shows the countdown and a
   disabled button like any other locked route.
3. **Every failure path was a silent early return.** `refreshNow` returned
   `void`, and the client deliberately swallowed errors ("the SSE broadcast is
   the source of truth"). Rate-limited, no credentials on disk, expired access
   token, upstream 500, unparseable payload — all indistinguishable from a
   broken button. `refreshNow` now resolves a `LimitsRefreshResult` per route,
   the HTTP response carries them, and the button renders the reason.
4. **The client's auto-refresh throttle was keyed by provider, not route.** The
   first pill to mount stamped `lastRefreshAttemptAt` for the whole provider, so
   the second pill's mount-time baseline fetch was skipped for 5 minutes — the
   primary account never got its own baseline reading in the first place.

The general lesson: "account-global" was a fair simplification when one
subscription per provider was the only shape, and every one of these bugs is
that assumption surviving past it. Anything keyed by `AgentId` that describes a
*subscription* — cache, throttle, lockout, button — wants a `routeId`.

## Key files

| File | Role / change |
|------|---------------|
| `src/server/orchestrator/agents/claude/limits-provider.ts` | Single-flight `/api/oauth/usage` fetch + per-route lockout state; merge with event snapshot; `refreshNow` resolves a per-route outcome; `fetch` reports a lockout even with no readings |
| `src/server/orchestrator/agents/claude/` (auth) | Reuse OAuth bearer + `isAccessTokenExpired` pre-check |
| `src/server/orchestrator/limits-registry.ts` | On-demand refresh entry point; returns one result per attempted route; cache + SSE broadcast |
| `src/server/orchestrator/agents/types.ts` | `LimitsProvider.refreshNow()` returns `LimitsRefreshResult` |
| `src/server/orchestrator/api-routes-limits.ts` | `POST /api/limits/refresh` — accepts + validates `routeId`, returns `results` |
| `src/client/components/SubscriptionLimitsBadge.tsx` | Per-route refresh glyph, disabled-with-countdown while locked, failure glyph + reason tooltip, source/age in tooltip; `autoRefresh` on-mount fetch + route-keyed module-level throttle |
| `src/client/components/MobileStatusPanel.tsx` | Mobile dropdown content — passes `autoRefresh` so opening it refreshes usage |
| `src/server/shared/types/usage-limits-types.ts` | `source`/`lockedUntil` fields; `LimitsRefreshOutcome` + `LimitsRefreshResult` |
| `src/server/session/agents/claude/adapter.ts` | `parseRateLimitWindow` — scale the CLI's 0–1 `utilization` fraction to 0–100 (see follow-up above) |

## Reference

- `docs/135-subscription-limits-badge/plan.md` — original badge design + the
  abandoned poller's full refresh strategy and 429 notes.
- Deleted `src/server/orchestrator/limits-poller.ts` (pre-`d73e59605`) — the
  prior orchestrator-side, turn-driven implementation this doc deliberately does
  not resurrect wholesale.
- `anthropics/claude-code#50518` (utilization only above warning threshold),
  `#31637` / `#30930` (usage endpoint 429 lockout).
