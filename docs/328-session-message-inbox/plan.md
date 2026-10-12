---
issue: planning#688
title: Session message inbox
description: A stored inbox for each session, one notice instead of a turn for each message, and a read command that returns all unread messages.
---

# Session message inbox

Implements [requirements.md](./requirements.md).

## The problem

A message between sessions is delivered today as a turn of its own, and two paths
do it differently:

- A child report, and a notice about a child's pull request, use
  `wakeSessionWithTurn`, which marks the dispatch `systemTurn: true`. A system
  dispatch is never steered (`isSteerableDispatch`, `dispatch-steering.ts`), so a
  busy parent gets one queued turn for each message and runs them one at a time.
- A parent's message, and a message the user approved on a proposal card, use
  `deliverSessionMessage`, which dispatches the full text. It is steered into a
  running turn, or it becomes a turn.

The wake path cannot steer because it confirms delivery by "the turn ran"
(`docs/196-session-notify-on-merge/plan.md`, planning#256): a steered message has
no turn of its own, so there was nothing to confirm.

## The mechanism

Delivery is split in two. **Storing** a message is the delivery, and it is durable.
**Telling** the agent is a short notice that carries no message text.

### Store (req 2)

`session_inbox` holds one row for each message sent to a session: the recipient, the
sender as `SessionMessageOrigin` holds it (empty for ShipIt's own notice), the text
that the agent reads, and the time. Rows go when their session is deleted, and not
before.

`session_inbox_state` holds two numbers for each recipient: the id of the last
message that its agent read, and the id of the last message that its agent was told
about. A notice is **owed** while a message is newer than both.

Both tables reference `sessions`, so the store uses the session manager's database.

### Read (req 2, req 4)

`shipit session inbox` returns every unread message of the calling session, oldest
first, and moves the read number in the same transaction.
`shipit session inbox --all` returns every message that was ever sent to the session
and moves nothing.

A message that a session's agent wrote is printed inside the frame that
`formatSessionMessagePrompt` gives it today, so the reader can tell an agent's text
from the user's. A notice about a pull request is ShipIt's own text and has no frame.

### Tell (req 1, req 3, req 5, req 7)

**The notice rides the prompt of the session's next turn.** ShipIt already tells an
agent what became of a card in this way (`session-message-outcome-notice.ts`): a
`[ShipIt]` line in front of the prompt, with a receipt that is recorded only when the
agent has produced a result for that prompt. The inbox notice is one more line of
that kind, in both places that compose a prompt. Its receipt moves the told number.

So the notice needs no turn of its own when a turn is coming, whatever started that
turn: a message the user typed, a queued message, an automatic turn. It needs no
identity in the queue, no completion callback and nothing in memory, and a restart
loses nothing, because the owed state is two numbers in the database.

What remains is to make a turn exist, and to tell a busy agent early:

| Recipient | What ShipIt does |
|---|---|
| Idle, or stopped | Starts one short turn (req 3). The notice rides it. |
| In a streaming turn that can take a steer | Steers the notice text into that turn (req 7), one time until the agent reads or the session goes idle. The turn keeps its permission mode. |
| In any other turn | Nothing now. The session gets its turn when it goes idle (req 1, req 5). |

Nothing is put in the queue. The dispatch asks for "steer or start, or else refuse",
a third value of `DispatchAdmission.whenBusy`, so a gate that would queue the turn
refuses it, and a later trigger tries again. A steer that the CLI does not take is
dropped too (`bestEffortSteer`): its row leaves the transcript, as a user's lost steer
does, but it is not put back in the queue, which would make the notice a queued turn.

**Triggers.** One function, `tell`, applies the table. It runs when a
message is stored, when the recipient's runner goes idle, and from a sweep once a
minute over the sessions that are owed a notice. The sweep is the one recovery path:
it covers a session that could not be started, a refused turn with no idle event
after it, and a restart.

**Bounds.** A message is told when the notice that covers it gets its receipt, and a
told message causes no further notice. A turn that ShipIt started and that did not
reach the agent is tried again after a delay that starts at one minute and doubles
with each failure, up to one hour; a session that could not be started is tried again
in the same way. A message that arrives after a notice got its receipt is new, and
does not wait for that delay. A steered notice has no receipt: when the agent does
not read, the idle trigger gives the session its turn, one time.

**Guards on the started turn.** It does not start while the session's resident
process has background work, because a new ordinary turn can replace that process
(`releaseResidentOnSpawnChange` and its siblings, `dispatched-turn.ts`). It does not
start while the worker runs a turn that the runner does not show (`hasTurnInFlight`).
With no runner at all, which is the state after a restart, only the worker can say
whether it still has a turn, background tasks or an install, so ShipIt asks it
(`workerHasLiveWork`, `restart-turn-reattach.ts`). A runner whose container is gone
counts as a stopped session, whatever the runner says: the wake path replaces it. One
trigger at a time can start a session; a second one that arrives meanwhile waits.

**A question holds the turn** (docs/322-question-holds-automatic-turns). The started
turn is `automatic`, so it is refused while the agent waits for the user's answer,
and nothing is saved for later: the user's reply is a turn, and the notice rides it.
A message that the user approved on a proposal card is not automatic, as it is not
today, so its turn starts.

### Senders

| Sender | Before | After |
|---|---|---|
| `deliverSessionReport` (child to parent) | Card, then a wake turn | Card, then store and tell |
| `deliverSessionMessage` (parent to child, proposal card) | Dispatch of the full text | Store and tell |
| `MergeWatchManager`, the parent's watch (req 6) | Wake turn with a tracked delivery | Store with the end of the watch, then tell |

The card that a report puts in the parent's transcript, and the "Child PR merged"
card, stay as they are: the user reads them, the agent reads the inbox. A parent's
message and a message from a proposal card had no card, so `deliverSessionMessage`
puts one in the recipient's transcript: the report card, with no severity, that shows
the message and names its sender (docs/314-session-message-proposal req 6). It is a
card and not a message row, because a row with text is replayed to an agent as part
of its own conversation (`buildConversationReplay`, `services/replay.ts`).

`deliverSessionMessage` loses its own copy of the "boot the session, then dispatch"
steps and uses the wake path, which gains the admission option.

**The parent's merge watch** (req 6) stores the notice and ends the watch in one
database transaction: `SessionInbox.add` takes the sender's own write and runs it
in the transaction that stores the message. So there is no state between "observed"
and "told" to retry. The watch then surfaces its card and calls `tell`, which is
why it does not use `post`: the user sees the card before a session start that can
take a minute. Its attempt counter, retry supervisor and failure state now serve
only a session's watch on its own pull request. That watch is not a message from
another session; it keeps the wake turn.

A parent's watch that an older ShipIt left with a wake turn in delivery is not
stored a second time while that turn can still end: the watch asks the runner and
the held turns for the turn's delivery id, as before. When the turn is gone or
fails, the notice goes to the inbox. The design of the watch is in
`docs/196-session-notify-on-merge/plan.md`.

Other wake turns are unchanged, because they are not messages between sessions: a
finished consult, a restart note, a quota continuation, and a report of stopped
background jobs.

### What the sender is told

`shipit session message` and `shipit session report` say that the message is in the
recipient's inbox and how its agent learns of it: during its running turn, by a turn
that started, or later. When ShipIt could not start the recipient, the output says so
and says that the message is stored, so the sender does not send it again. The old
response fields stay for a container that still runs an older shim.

### A container that is older than the running ShipIt

Such a container can lack the `inbox` command, and it stays until its session is idle
or is restarted (docs/242-stale-session-container-indicator). ShipIt knows it by its
build id (`getContainerFreshness`). Its agent is not told to run the command: the
notice in front of its prompt carries the messages themselves, and the receipt of
that notice marks them read. It gets no steered notice, because a steer has no
receipt.

## Verified dependencies

- A notice in front of the prompt gets its receipt only when the agent produced its
  own result for that prompt: `notePromptDelivered`, `turn-executor.ts`. Both
  composition sites pass `noticeDeliveries`: `dispatched-turn.ts` and
  `ws-handlers/agent-execution.ts`.
- A resident streaming turn does not settle its dispatch, so a turn's settlement is
  not evidence that a notice arrived: the note on `NoticeDelivery`,
  `turn-settlement.ts`. This design reads no settlement.
- A dispatch with no `systemTurn`, no `onTurnComplete` and no attachments is steered
  when the running turn can take it: `isSteerableDispatch` and `trySteerDispatch`,
  `dispatch-steering.ts`.
- The idle signal fires after the drain and the commit, and not while a turn runs:
  `signalIdleIfIdle`, `turn-executor.ts`; it reaches `onRunnerIdle` in
  `runner-registry-factory.ts`. Idle is a trigger here, never the recovery.
- A refusing dispatch is not queued by any gate: `enqueueOrRefuse` in
  `dispatchOnRunner`, `session-runner.ts`.
- A steer is put back in the queue only when it was recorded with the text that the
  CLI must echo: `requeueUndeliveredSteers`, `ws-handlers/agent-message-builder.ts`,
  and the `agent_steer_rejected` branch of `wireAgentListeners`.
- A steer applies the permission mode of the dispatch it carries: `trySteerDispatch`,
  `dispatch-steering.ts`. The notice carries the running turn's own mode.
- A transcript row with text is replayed to an agent when its conversation is rebuilt,
  and a card row with no text is not: `buildConversationReplay`, `services/replay.ts`.

## Key files

- `src/server/shared/database.ts` — the two tables.
- `src/server/orchestrator/session-inbox-store.ts` — rows and the two numbers.
- `src/server/orchestrator/services/session-inbox.ts` — `post`, `add`, `tell`,
  `read`, the idle trigger and the sweep.
- `src/server/orchestrator/services/session-inbox-notice.ts` and the three
  `session-inbox-*.md` files beside it — the notice and its receipt.
- `src/server/orchestrator/dispatched-turn.ts`,
  `ws-handlers/agent-execution.ts` — the notice in the prompt.
- `src/server/orchestrator/session-runner.ts`, `wake-session.ts`,
  `dispatch-steering.ts` — the admission value and the dropped steer.
- `src/server/orchestrator/services/session-report.ts`,
  `services/child-sessions.ts`, `merge-watch.ts` — the senders.
- `src/server/orchestrator/api-routes-session-spawn.ts`,
  `src/server/session/agent-ops-routes.ts`,
  `src/server/session/agent-shim/shipit-session.ts` — the read command.
- `src/client/components/SessionReportCard.tsx` — the card for a report, and for a
  message from a parent or from a proposal card.
- `src/server/shipit-docs/sessions.md`, the agents' `system-prompt.md` files and the
  wiki — what the agent and the user are told.

## Review record

- 2026-10-11 — An independent review with the brief "what can be removed" replaced
  the first design. That design tracked each notice through the queue with a
  per-message mark, an in-memory record and the turn's settlement; the review showed
  that a resident streaming turn never settles, so the record would have suppressed
  every later notice. Removed with it: the `kind`, `label`, `dedupe_key`, `read_at`
  and `told_at` columns, the notice in the queue, and the merge watch's retry of an
  inbox notice.
- 2026-10-11 — An independent review of the implementation found six defects, and all
  six are fixed: a steered notice reset the running turn's permission mode; after a
  restart a turn could start over background work that no runner showed; a lost steer
  became a queued turn; a parent's message was no longer in the recipient's
  transcript; an older container was told to run a command that it does not have;
  and one failure doubled the retry delay two times.
- 2026-10-11 — A second pass on those fixes changed three of them. The transcript
  record of a message became a card, because a message row could be replayed to the
  agent as the user's text. The lost steer of a notice now loses its row. Two triggers
  can no longer start one session together. Not changed: a container with no known
  build id is treated as current, so one that is older and unlabelled is still told
  to run the command.
