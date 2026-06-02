
# Session Status Indicators

## Problem

When a user has multiple sessions open, they have no clear way to know which sessions need their attention. The current sidebar shows status *facts* (agent running, CI state, PR state) but doesn't communicate *"you need to act on this."* A session with failed CI looks almost identical to an idle session at a glance — the small red CI dot is easy to miss.

Users need to answer one question quickly: **"Which of my sessions need me right now?"**

## Design

### Attention border

When a session needs attention, its entire sidebar row gets a colored left border — a 2px vertical accent line on the leading edge. This is high-visibility without being noisy: the eye naturally scans the left edge of a list.

```
  Sessions
  ┌──────────────────────────┐
  │  ◆ Fix login bug    2m   │  ← normal (no border)
  ┣──────────────────────────┤
  ┃  ◆ Add auth flow   15m   │  ← attention border (left edge colored)
  ┣──────────────────────────┤
  │  ◆ Refactor API     1h   │  ← normal
  └──────────────────────────┘
```

The border color uses a new semantic token `--color-attention` so it adapts per theme:

| Theme | Token value | Rationale |
|-------|-------------|-----------|
| Dark  | `#f59e0b` (amber-500) | Warm amber stands out against cool gray-900 backgrounds without clashing with red (error) or green (success) |
| Light | `#d97706` (amber-600) | Slightly darker amber for sufficient contrast on white/gray-50 |

The border is always solid (no animation). Animated pulsing borders were considered but rejected — they compete with the agent-running pulse and create visual noise when multiple sessions need attention.

### Attention conditions

A session is in the "needs attention" state when **any** of the following are true:

| # | Condition | Why it needs attention |
|---|-----------|----------------------|
| 1 | **CI failed** and agent is idle and auto-fix is not running | CI broke; no automated recovery in progress — user must investigate or enable auto-fix |
| 2 | **Auto-fix exhausted** (3 attempts, still failing) | Automated recovery gave up — user must intervene manually |
| 3 | **PR has merge conflicts** (`mergeable === false`, PR still open) | PR can't merge until conflicts are resolved |
| 4 | **Auto-merge error** (missing branch protection / repo config) | Merge automation is stuck on a config issue only the user can fix |
| 5 | **Agent finished turn** and session is not the active one | Work completed in background — user should review the results |

Conditions are evaluated in priority order, but the visual treatment is the same for all — a single amber border. The *reason* is communicated via tooltip on hover (see below).

**Conditions that do NOT trigger attention:**

- Agent is running — already shown by the green pulsing dot; the session is making progress
- CI is pending — checks are still running; nothing to act on yet
- PR is merged — that's a success state, not an attention state
- PR is open with passing CI — everything is fine

### Tooltip on hover

When hovering over a session that has the attention border, a tooltip explains why:

| Condition | Tooltip text |
|-----------|-------------|
| CI failed (no auto-fix) | "CI checks failed" |
| Auto-fix exhausted | "CI fix failed after 3 attempts" |
| Merge conflicts | "PR has merge conflicts" |
| Auto-merge error | "Auto-merge needs repo configuration" |
| Agent finished (background) | "Agent finished — review results" |

If multiple conditions are true simultaneously, show the highest-priority one (using the numbered order above).

### Consolidated status dot

Replace the current separate `AgentDot` + `CiDot` with a single `SessionStatusDot` component. This reduces visual clutter and establishes a clear single-icon status summary.

Priority order (highest wins):

| Priority | State | Icon | Color token | Animation |
|----------|-------|------|-------------|-----------|
| 1 | CI failed + needs manual fix | `XCircle` | `--color-error` | none |
| 2 | Merge conflict / merge error | `Warning` | `--color-warning` | none |
| 3 | Auto-fix running | `Wrench` | `--color-autofix` | `animate-spin` |
| 4 | Agent running | filled circle (2x2) | `--color-success` | `animate-pulse` |
| 5 | CI pending | `CircleNotch` | `--color-warning` | `animate-spin` |
| 6 | CI passed | `CheckCircle` | `--color-success` | none |
| 7 | idle / no data | *(nothing)* | — | — |

All icons are 12px (`ICON_SIZE.XS`), consistent with the current `CiDot`.

### Auto-merge badge (right-aligned on the meta line)

Auto-merge is a session-level preference that can be armed before any PR exists (stored in `pr-store`'s `autoMergeBySession`, falling back to the open-phase `card.autoMerge`). When armed, `AutoMergeBadge` renders a small `GitMergeIcon` (`weight="bold"`, `ICON_SIZE.XS`) **right-aligned (`ml-auto`) at the end of the session row's meta line** (the line that holds the status dot, repo label, and relative time). It's a separate component from `SessionStatusDot` — the status dot stays focused on the single CI/agent glyph; the auto-merge badge is its own indicator with its own slot and its own `"Auto-merge enabled"` tooltip.

Two earlier placements were tried and rejected: a corner-badge overlay on the status dot read as a single blurred squiggle at 12px and, in warm/light themes (e.g. claude-light, where `--color-accent` is terracotta), shared a color with the amber CI-pending spinner; a side-by-side pair next to the status dot crowded the leading edge. The right-aligned meta-line slot gives the attribute its own breathing room.

The badge is independent of CI/PR state by design: the preference is session-level, so the indicator must show whenever the preference is on, not only once a PR/CI exists. **Color:** `--color-text-secondary` (neutral) — it's an informational "armed" attribute, not a status, so it must not collide with the colored CI glyphs (accent and success collide with status colors in warm/light themes). The same `GitMergeIcon` is duplicated on the `AutoMergeToggle` label (`PrStatusControls.tsx`) so the badge and the toggle that controls it share one glyph. We use `GitMergeIcon` (not `LightningIcon`, which already means "Quick session" in the sidebar). Per the answered design question, the badge tracks on/off only — it does not call out auto-merge error / managed-config states.

### "Agent finished" tracking

## Data flow

All data needed for the attention border is already available client-side:

```
PrStore.cardBySession[id]         → checks, autoFix, autoMerge, phase
PrStore.statusBySession[id]       → mergeable, prState
SessionStore.activeRunnerSessions → agent running
```

The `needsAttention(sessionId)` derivation is a pure function of these stores — no new server messages or API calls required. No separate "seen/unseen" tracking is needed.

### Staleness across SSE reconnects (mobile foreground)

Because the derivation reads only client store snapshots, the sidebar is only as
correct as those snapshots. On mobile the SSE socket dies silently when the tab
is backgrounded (`readyState` stays OPEN over a dead connection), so the client
misses `session_agent_finished` / incremental `pr_status` events. When the tab
returns to the foreground `useServerEvents` forces a fresh `/api/events`
connection — so the **initial-connect snapshot must be authoritative**, not a
delta:

- `active_runners` is **always** sent on connect, even when empty. The client
  replaces its `activeRunnerSessions` set wholesale, so a session that finished
  while hidden gets its stale "running" flag cleared. This matters doubly
  because `computeAttentionReason` short-circuits to `null` while a session is
  running — a stale running flag also *masks* that session's CI-failed / PR
  attention reason.
- `pr_status` is sent with `isSnapshot: true` carrying the complete
  poller-derived set. `applyPrStatusUpdates` then prunes poller state
  (`statusBySession`, and `cardBySession` entries in poller phases
  open/merged/closed) for any session absent from the snapshot, so a PR that
  merged/closed while hidden no longer leaves a stale card. In-flight,
  WS-driven cards (creating/ready/error) are preserved.

Key files: `src/server/orchestrator/index.ts` (`/api/events` snapshot),
`src/client/hooks/useServerEvents.ts` (`pr_status` listener),
`src/client/stores/pr-store.ts` (`applyPrStatusUpdates` snapshot reconcile),
`src/server/orchestrator/integration_tests/sse-snapshot.test.ts`.

## Key files

| File | Change |
|------|--------|
| `src/client/themes/dark.css` | Add `--color-attention` and `--color-attention-subtle` tokens |
| `src/client/themes/light.css` | Add `--color-attention` and `--color-attention-subtle` tokens |
| `src/client/components/SessionSidebar.tsx` | Replace `AgentDot` + `CiDot` with `SessionStatusDot`; add attention border to `SessionItem`; add attention tooltip |

## Non-goals

- **Unread count badge** on the sidebar header — adds clutter; the border is visible enough.
- **Sound or browser notifications** — out of scope for this feature.
- **Sorting sessions by attention** — interesting follow-up, but changes list stability and muscle memory. Defer.
- **Server-side persistence** of attention state — this is a transient UI concern, not worth the round trip.
