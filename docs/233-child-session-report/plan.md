---
issue: planning#243
title: Parent-mediated child-session reports
description: A child pushes findings only to its parent as a persisted card plus a queued wake turn.
---

# Session reports (`shipit session report`)

This design implements [the parent-mediated coordination
requirements](./requirements.md). Child sessions can report upward, but they
cannot message siblings. The parent is the single coordination hub.

## Problem

A spawned child needs to push blockers and cross-cutting findings to the session
that assigned its work. PR text and final summaries are pull surfaces: the
parent does not learn about the finding until it inspects the child.

The first report design also allowed `--to cohort`, which woke the parent and
every sibling. That formed a graph of active agents. A report could cause peer
reactions and more reports, producing a message storm despite a per-sender rate
limit. The safe topology is a tree: children report upward, and parents decide
what to send downward.

## Command model

`shipit session report` derives its only recipient from the calling session's
server-owned `parentSessionId`:

```sh
shipit session report --severity blocker --subject "Shared generator is unsafe" \
  --body-file - <<'EOF'
The shared generator deletes catalogs outside my assigned scope.
EOF
```

`--to parent` remains accepted for compatibility and is the default. The shim
rejects `--cohort`; the orchestrator independently rejects any `to` value other
than `parent`. The server check protects existing containers that still run an
older shim after an orchestrator update. There is no target session-id flag.

`shipit session whoami` still shows the caller, parent, siblings, and children.
Sibling rows are read-only topology. Visibility does not grant delivery rights.

## Delivery

Each accepted report gives the parent both notification halves:

1. A persisted `SessionReportCard` is appended to the parent's transcript and
   emitted to attached viewers.
2. A self-describing system turn is delivered through `wakeSessionWithTurn`.
   Busy parents queue the turn; reports never preempt running work.

The wake prompt carries the reporting child's id, title, severity, subject, and
body. It marks the content as peer-provided context, not a user instruction.
The report rate limit remains five accepted reports per reporter per ten
minutes.

A top-level or detached session has no parent and cannot report. An archived
parent also makes the report unavailable. Delivery failures keep the persisted
card and return `woken: false` so the sender does not mistake the report for a
successful agent wake.

## Direct parent-to-child messages

`shipit session message <id>` remains parent-to-direct-child only. It uses
`assertChildOfParent` and rejects unrelated or sibling ids. The shared
resolved-session classifier also blocks messages to a resolved child before a
runner, card, or queue entry is created. A later started turn can reactivate the
child and make it eligible again.

`src/server/shared/session-resolution.ts` remains the sole implementation of
the resolved-session rules used by server and client consumers. It combines PR
terminal time, later `lastUsedAt` activity, pin state, visible descendants, and
runner liveness. `turn-executor.ts` advances `lastUsedAt` at dispatched-turn
start, including system continuations and abnormal exits. The report service no
longer needs this classifier because siblings are never report recipients.

## Compatibility

Historical report cards can contain `relation: "sibling"`. The persisted domain
and client renderer retain that legacy value so old transcripts continue to
load. New delivery code creates only `relation: "child"` cards in a parent
session.

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/services/session-report.ts` | Validates parent-only reports, persists the card, and wakes the parent |
| `src/server/session/agent-shim/shipit-session.ts` | Rejects cohort/sibling targets and formats report results |
| `src/server/session/agent-shim/shipit.ts` | CLI help and coordination guidance |
| `src/server/orchestrator/api-routes-session-spawn.ts` | Container-accessible cohort-read and parent-report routes |
| `src/server/orchestrator/services/child-sessions.ts` | Parent-to-direct-child authorization and resolved-child gate |
| `src/server/shared/session-resolution.ts` | Sole client/server resolved-session classifier for direct child eligibility and grouping |
| `src/server/orchestrator/turn-executor.ts` | Advances activity when any user or system continuation starts |
| `src/server/orchestrator/wake-session.ts` | Shared non-preempting wake path |
| `src/server/orchestrator/chat-history.ts` | Persisted report-card field |
| `src/server/shared/types/domain-types/session.ts` | Report card and legacy relation types |
| `src/client/components/SessionReportCard.tsx` | Inline report rendering, including legacy sibling cards |
| `src/server/shipit-docs/sessions.md` | Agent-facing command reference |

## Verification

- Service and integration tests prove `to: "cohort"` returns `400` and creates
  no report card, runner, queue entry, or wake turn.
- Shim tests prove `--cohort`, sibling ids, and arbitrary targets fail before a
  broker call.
- Existing tests retain parent report persistence, wake behavior, validation,
  rate limiting, and direct resolved-child message coverage.
