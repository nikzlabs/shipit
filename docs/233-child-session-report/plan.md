---
issue: planning#243
title: Child → parent (and sibling) session reports
description: A spawned session pushes a finding to its parent and cohort with `shipit session report`, landing as a persisted card plus a queued wake-turn instead of waiting to be pulled from a PR.
---

# Session reports (`shipit session report`)

Session-report wake turns carry the reporting session's id, title, and
relationship as persisted message provenance. Their user-shaped prompt bubble
is therefore labeled as coming from a child or sibling session rather than
appearing to be direct user input; the existing report card remains the richer
human-facing summary. The model-facing wake prompt is also wrapped in the same
agent-to-agent provenance envelope before dispatch.

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

The motivating case (planning#243): three siblings authoring one spell catalog each
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

## Resolved-child delivery gate (planned)

The production remediation adds one recipient eligibility rule: a child shown
by the existing UI as **Recently resolved** does not receive a direct parent
message or a sibling cohort report. It receives no transcript card and no wake
turn. The sender gets a synchronous, named skip result.

### One lifecycle module, not client/server mirrors

Create `src/server/shared/session-resolution.ts` as the only code location that
implements resolution rules. It exports a layered API because attention/cap
ranking and rendered grouping ask related but different questions:

```ts
resolvedAt(session)
isTerminalPrResolved(session)
isResolvedForGrouping(session, { hasVisibleBrood })
```

`isTerminalPrResolved` owns the terminal-PR + continuation baseline using the
existing fields:

```text
(mergedAt OR closedAt) AND NOT (lastUsedAt > resolvedAt)
```

Every started turn must advance `lastUsedAt`. Add
`sessionManager.track(sessionId)` unconditionally at the start of the shared
turn executor. Then a self merge-wake, adopted turn, CI fix, conflict
remediation, or other system continuation reactivates the session immediately,
even if the turn later crashes without `agent_result`. The existing terminal
update can remain idempotent. A later PR lifecycle establishes a newer terminal
instant and can resolve the session again.

`isResolvedForGrouping` composes the baseline and returns true only when the
session is not pinned, has no visible brood, and is not currently running. The
helper accepts the already computed `hasVisibleBrood` and optional `isRunning`
facts: root-level sidebar grouping passes any-depth
visible-descendant membership; brood-member grouping and server delivery pass
visible direct-child membership. A visible child has neither `archived` nor
`userArchived`; archived descendants do not keep a session active.

The module owns timestamp normalization through `parseTimestampMs`, pin logic,
and composition. No client component, attention hook, sidebar grouping
function, orchestrator service, or test helper may reconstruct these rules.
Callers compute only the visible-brood and server liveness context.

Delete client `resolvedAt` / `reopenedAfterResolve` / `isRecentlyResolved`
mirrors from `useSessionGrouping.ts`; sidebar and attention consumers import the
appropriate shared layer. Migrate the actual Active/Recently resolved split in
`SessionGroup.tsx` too: root and brood-member rendering call
`isResolvedForGrouping` with their existing hierarchy context, intentionally
fixing sort/render drift for pinned sessions. Attention hooks import
`isTerminalPrResolved` because they suppress stale terminal-PR attention
independently of grouping exemptions. Move server `resolvedAt` /
`reopenedAfterResolve` logic out of `sessions.ts`. In
`filterVisibleInSidebar`, only the resolved ranking uses
`isTerminalPrResolved`; existing pin, reservation, and root-hierarchy visibility
exemptions remain unchanged. This enforces one implementation without forcing
two product questions through one composite boolean.

No new lifecycle column, migration, or user-ingress writer is needed. One
dispatched-turn-start update closes the current timing gap; `lastUsedAt` then
records the approved single-PR-versus-continuation distinction on every path.

### Direct parent → child message

`sendChildMessage` already resolves and authenticates the child through
`assertChildOfParent`. Immediately after that lookup and before the workspace,
container, credential, or runner paths, call `isResolvedForGrouping` with the
visible-child context.

On a match, the service throws a resolved-child `ServiceError(409, ...)`. The
child-message route recognizes that case and explicitly sends
`{ error, sessionId, title, reason: "resolved", delivered: false }`. `error`
contains the full human sentence that the child received no message or wake
turn. `handleSessionMessage` handles this structured 409 before its generic
non-2xx branch: `--json` writes the full body then exits non-zero; human output
uses `error`. The guard must precede
`runnerRegistry.getOrCreate`, so a rejected delivery cannot resume a container
or mutate its queue.

### Child → cohort report

Only sibling rows are child recipients on this path. The parent recipient is
unchanged, even when the parent has a terminal PR, because resolved-parent and
child-to-parent behavior are out of scope.

During recipient resolution in `deliverSessionReport`:

1. Keep the existing archive filter.
2. For each sibling, evaluate the shared `isResolvedForGrouping` helper with its
   visible-child context.
3. Put an eligible sibling in the existing delivery list.
4. Put a resolved sibling in a new `skippedRecipients` result list with
   `sessionId`, `title`, and `reason: "resolved"`.

The initial filter happens before `enforceRateLimit` and report/card ID
construction. Because fan-out awaits each recipient sequentially and a wake can
spend up to 30 seconds resuming a worker, re-read and re-check each sibling
immediately before its `surfaceCard` call. A sibling that became resolved while
earlier recipients were waking moves to `skippedRecipients` and gets no card,
live event, container resume, or queue entry. Eligible recipients retain the
current per-recipient best-effort path.

`DeliverSessionReportResult` gains `skippedRecipients`. The shim prints each
resolved skip after the delivery count, for example:

```text
  sibling Druid catalog (<id>): NOT delivered (session is resolved; no card or wake turn was sent)
```

JSON output carries the same structured result. Exit behavior does not change:
success still means at least one recipient was woken. A call whose initial
filter finds only resolved skips does not consume a rate-limit slot. If the
fresh in-loop re-check resolves the last initially eligible sibling, the call
has already consumed its one per-call slot; no rollback bookkeeping is added.
The existing generic
archived/no-recipient error remains only when there are no eligible recipients
and no resolved skips. If the parent is archived or absent and every sibling is
resolved, return the named `skippedRecipients` result rather than incorrectly
claiming that every recipient was archived.

### Deliberate boundaries

- `shipit session whoami` continues to show resolved siblings. It is a topology
  read, not a promise that every peer is eligible for delivery.
- A resolved parent still receives a child's direct parent report. Only resolved
  **child recipients** are gated.
- Every eligible `fyi`, `warn`, and `blocker` report still persists a card and
  wakes the agent. No severity split is introduced.
- The five-per-ten-minute sender rate limit stays unchanged. There is no report
  chain, content fingerprint, or semantic deduplication.
- The gate is checked at delivery time. A stale earlier `whoami` or `list` result
  cannot authorize delivery after the child becomes resolved.

### Verification

- Add shared-module tests for both predicate layers: merge and close,
  continuation-turn reactivation, pin
  exemption, visible-child exemption, archived-child non-exemption, and mixed
  timestamp formats. Remove superseded mirror tests rather than testing two
  implementations.
- Add a dispatched-turn integration test proving `lastUsedAt` advances at turn
  start, including abnormal exit. Add an end-to-end self merge-wake case:
  merged child → wake starts → sibling cohort report is delivered while the
  continuation turn is still running.
- Add direct-message service/integration cases proving a resolved child returns
  `409`, names the child, and creates no runner or queue entry; prove a reopened
  child still receives the message.
- Add `session-report.test.ts` cases proving a resolved sibling appears only in
  `skippedRecipients`, receives no history card or dispatch, and does not change
  delivery for the parent or active siblings. Cover no rate-limit charge, no live
  `session_report_card` event, the all-skipped branch, merge/close/reopen, and all
  severities without duplicating the same structural assertion three times.
- Add shim tests for human-readable and JSON direct/cohort resolved outcomes.
  Preserve the existing exit-code contract when other recipients were woken.
- Update `src/server/shipit-docs/sessions.md` unconditionally: both commands gain
  a terminal resolved-child outcome, while `whoami` can still list an
  undeliverable resolved peer.

## Key files

| File | Role |
|---|---|
| `src/server/session/agent-shim/shipit-session.ts` | `handleSessionReport` / `handleSessionWhoami`; bare `view` → whoami; 404s point at whoami |
| `src/server/session/agent-shim/shipit.ts` | Dispatch (`report`, `whoami`) + help text |
| `src/server/session/agent-ops-routes.ts` | Worker broker: `GET /agent-ops/session/cohort`, `POST /agent-ops/session/report` |
| `src/server/orchestrator/api-routes-session-spawn.ts` | `GET /api/sessions/:sessionId/cohort`, `POST /api/sessions/:sessionId/report` (both `containerAccessible`) |
| `src/server/orchestrator/services/session-report.ts` | Validation, recipient resolution, rate limit, card + wake fan-out, wake-turn prompt |
| `src/server/shared/session-resolution.ts` | Sole client/server resolved-session classifier |
| `src/server/orchestrator/sessions.ts` | Consumes the shared classifier for resolved view-cap ranking |
| `src/client/components/SessionSidebar/useSessionGrouping.ts` | Consumes shared classifier; deletes local mirrors |
| `src/client/components/SessionSidebar/SessionGroup.tsx` | Routes actual root/brood Active-vs-resolved rendering through the shared classifier |
| `src/server/orchestrator/services/child-sessions.ts` | Early resolved-child guard for direct parent messages |
| `src/server/orchestrator/api-routes-session-spawn.ts` | Builds the structured direct-message 409 response |
| `src/server/orchestrator/turn-executor.ts` | Advances activity at dispatched-turn start so continuation is immediately active |
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
