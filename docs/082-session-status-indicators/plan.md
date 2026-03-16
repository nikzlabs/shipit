---
status: done
---

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

### "Agent finished" tracking

To know whether a session's agent finished while the user was looking at a different session, we need a lightweight "unseen result" flag.

**Client-side only** — no server changes needed:

1. In `session-store`, add `unseenResults: Set<string>` (set of session IDs).
2. When an `agent_result` event arrives for a session that is *not* the currently viewed session, add its ID to `unseenResults`.
3. When the user switches to that session (via `onResume`), remove it from `unseenResults`.
4. The attention border checks `unseenResults.has(sessionId)` as condition #5.

This resets naturally on session switch — no persistence needed.

## Data flow

All data needed for the attention border is already available client-side:

```
PrStore.cardBySession[id]         → checks, autoFix, autoMerge, phase
PrStore.statusBySession[id]       → mergeable, prState
SessionStore.activeRunnerSessions → agent running
SessionStore.unseenResults (new)  → agent finished in background
SessionStore.sessionId            → currently active session
```

The `needsAttention(sessionId)` derivation is a pure function of these stores — no new server messages or API calls required.

## Key files

| File | Change |
|------|--------|
| `src/client/themes/dark.css` | Add `--color-attention` and `--color-attention-subtle` tokens |
| `src/client/themes/light.css` | Add `--color-attention` and `--color-attention-subtle` tokens |
| `src/client/components/SessionSidebar.tsx` | Replace `AgentDot` + `CiDot` with `SessionStatusDot`; add attention border to `SessionItem`; add attention tooltip |
| `src/client/stores/session-store.ts` | Add `unseenResults` set + `markUnseen` / `clearUnseen` actions |
| `src/client/hooks/useMessageHandler.ts` (or equivalent) | On `agent_result` for non-active session, call `markUnseen` |

## Non-goals

- **Unread count badge** on the sidebar header — adds clutter; the border is visible enough.
- **Sound or browser notifications** — out of scope for this feature.
- **Sorting sessions by attention** — interesting follow-up, but changes list stability and muscle memory. Defer.
- **Server-side persistence** of attention state — this is a transient UI concern, not worth the round trip.
