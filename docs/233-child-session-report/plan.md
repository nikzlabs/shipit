---
issue: https://linear.app/shipit-ai/issue/SHI-241
title: Child → parent (and sibling) session reports
description: A spawned session pushes a finding to its parent and cohort with `shipit session report`, landing as a persisted card plus a queued wake-turn instead of waiting to be pulled from a PR.
---

# Session reports (`shipit session report`)

Session-report wake turns carry the reporting session's id, title, and
relationship as persisted message provenance. Their user-shaped prompt bubble
is therefore labeled as coming from a child or sibling session rather than
appearing to be direct user input; the existing report card remains the richer
human-facing summary.

## Problem

Session coordination was strictly **one-directional**. Every lever the shim
exposed — `list`, `view`, `message`, `wait`, `notify-on-merge` — runs
parent → child, resolved through `parentSessionId`. There was no channel the
other way, and a spawned session could not even resolve **itself**:

```
$ shipit session view "${SHIPIT_SESSION_ID}"
Spawned session not found, or not a descendant of this parent.

$ shipit session list
No spawned sessions for this parent.
```

`shipit session message <id>` would have worked mechanically, but the id was
unobtainable from inside the child *and* the route is descendant-scoped anyway.

That gap bites exactly where the CLI's fan-out pattern is strongest: one parent
spawning a cohort of children against a shared plan. Such a cohort reliably
produces information that must travel **upward or sideways**:

- work the child is scoped **not** to touch (shared machinery, policies, docs)
  but has found to be broken;
- blockers that stop part of the child's assignment and change what the cohort
  should expect from it;
- findings that invalidate or endanger a **sibling's** work.

The motivating case (SHI-241): three siblings authoring one spell catalog each
against a shared plan. The elementalist child found that a shared regeneration
command silently deletes **all three** catalogs, not just its own. It had no way
to tell the parent and no way to warn the siblings — the ones actually at risk.
It fell back to filing issues in the *product's* tracker and cross-linking them
from its PR: coordination traffic in the wrong system, and still **pull**, not
push.

The pre-existing outlets — PR body, PR comments, the final turn summary — are all
pull. Nobody learns anything until someone goes and looks.

## Model — push, both halves, cohort-scoped

`shipit session report` delivers a report from the calling session to recipients
**derived from its own parent linkage**:

- `--to parent` (default) — the session that spawned it.
- `--to cohort` (or `--cohort`) — the parent **and** every live sibling.

Each recipient gets **both halves of a notification**, exactly like docs/196's
notify-on-merge:

1. a **persisted `SessionReportCard`** in its transcript — the human sees the
   report inline, and it survives a session switch / full reload; and
2. a self-describing **system turn** enqueued on its runner
   (`wakeSessionWithTurn`) — the recipient **agent** is re-invoked rather than
   having to poll. A busy recipient's turn is queued and drains post-turn; a
   report never preempts a running agent.

`shipit session whoami` is the read half: it resolves the calling session plus
its parent, siblings, and children, so a child can answer "who am I, and who am
I working alongside?" A bare `shipit session view` (no id) is an alias for it,
and every descendant-scoped 404 now points at it.

### Severity

`fyi` (default) / `warn` / `blocker`. Severity shapes the card's tone **and** the
instruction in the wake-turn, so what the user sees and what the recipient agent
was told to do about it cannot drift:

| Severity | Wake-turn instruction |
|---|---|
| `fyi` | informational; acknowledge if relevant, no action likely required |
| `warn` | may invalidate or endanger part of your work — check before continuing |
| `blocker` | stop and assess before continuing your current plan |

### Why every report costs a turn

An `fyi` that only lands as a card is the same failure the issue describes: the
agent never sees it. So **every** report wakes its recipients, and the cost is
made explicit to the sender instead of being optimized away — the docs tell the
agent to batch findings into one report, and a per-reporter rate limit (5 per 10
minutes, in-memory) stops a runaway report → react → report loop. The limit is
charged only after validation passes, so a rejected call doesn't burn budget.

## Safety properties

- **No agent-supplied target.** There is deliberately no `--to <session-id>`.
  The reporter is the worker-injected `SESSION_ID`; recipients are computed
  server-side from `parentSessionId` and that parent's children. A report can
  therefore only reach the tree the parent already coordinates — the same blast
  radius the existing parent→child routes have, viewed from the other end.
- **Read, not remote control.** The wake-turn frames the body as *information
  from a peer agent to judge*, explicitly not as a user instruction, and tells
  the recipient not to reply with a report unless it has genuinely new
  information. A report must not become a session-to-session command channel.
- **Archived peers are skipped**; a reporter with no parent (top-level, or
  spawned `--detached`) is refused with a message pointing at its PR body or
  `shipit issue create`.
- **Per-recipient best effort.** The card is appended first, then the wake is
  attempted. A recipient whose container can't be resumed comes back with
  `woken: false` + an error rather than failing the whole call — one unreachable
  sibling must not swallow a blocker the others need. The shim exits non-zero
  only when *nothing* was woken.

## Shared wake path

`wake-session.ts` was extracted from `merge-watch.ts`'s `deliverWakeTurn`, which
had already solved the three problems any out-of-turn wake faces: a stale runner
whose container was reaped (tear down, re-create), cold credentials on a resumed
container (idempotent `prepareSessionAgentEnvironment`), and a phantom ack (wait
for `whenWorkerReady`, throw if the runner was disposed). Both the merge watch
and report delivery now go through it, so a resumed container behaves identically
on both paths and the invariant "a queued wake never preempts a running agent"
lives in one place.

## Key files

| File | Role |
|---|---|
| `src/server/session/agent-shim/shipit-session.ts` | `handleSessionReport` / `handleSessionWhoami`; bare `view` → whoami; 404s point at whoami |
| `src/server/session/agent-shim/shipit.ts` | Dispatch (`report`, `whoami`) + help text |
| `src/server/session/agent-ops-routes.ts` | Worker broker: `GET /agent-ops/session/cohort`, `POST /agent-ops/session/report` |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `GET /api/sessions/:sessionId/cohort`, `POST /api/sessions/:sessionId/report` (both `containerAccessible`) |
| `src/server/orchestrator/services/session-report.ts` | Validation, recipient resolution, rate limit, card + wake fan-out, wake-turn prompt |
| `src/server/orchestrator/wake-session.ts` | Shared out-of-turn wake (extracted from `merge-watch.ts`) |
| `src/server/orchestrator/chat-history.ts` | `sessionReport` persisted field + `session_report` column |
| `src/server/shared/database.ts` | `messages.session_report` migration |
| `src/server/shared/types/domain-types/session.ts` | `SessionReportCard`, `SessionReportSeverity` |
| `src/server/shared/types/ws-server-messages/spawn.ts` | `WsSessionReportCard` |
| `src/client/components/SessionReportCard.tsx` | Inline card (severity tone, body, Open) |
| `src/client/hooks/message-handlers/session-report.ts` | Live handler, idempotent by `cardId` |
| `src/server/shipit-docs/sessions.md` | Agent-facing reference (*Reporting upward*) |

## Deliberately not built

- **A reply channel.** A report is one-way. The recipient reacts in its own
  session (and may report onward); there is no threaded conversation between
  sessions, which would turn coordination into an unbounded loop.
- **Arbitrary targets / cross-tree reach.** See *Safety properties*.
- **A separate "needs attention" flag.** `severity` already carries it; a second
  axis would only drift from the first.
- **Persisted delivery state / retry.** Unlike a merge watch (which waits on a
  human, possibly for days), a report is delivered synchronously inside the
  reporter's own turn, and the truthful per-recipient outcome is returned to the
  agent, which can act on it immediately. There is nothing to re-derive after a
  restart.
