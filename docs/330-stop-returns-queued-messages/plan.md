---
issue: planning#692
title: A Stop returns the queued messages to the input box
description: Design — the Stop empties the queue itself, and the user's waiting messages wait on the server until an input box has them.
---

# A Stop returns the queued messages to the input box — design

Implements [`requirements.md`](requirements.md). Requirements are cited as
`(req N)`.

## Before this feature

- A Stop goes through `interruptAgentTurn` (`services/agent-interrupt.ts`) for
  every kind of turn. It did nothing with the queue.
- The queue was cleared later, and only by one of the drains. The typed drain
  (`drainNextQueuedMessage` in `ws-handlers/agent-execution.ts`) called
  `runner.clearQueue()` when the turn that ended had `wasInterrupted` set. The
  dispatched drain (`dispatched-turn.ts`) and the drain of an adopted turn
  (`turn-adoption.ts`) had no such branch: the next entry started at once.
- The client dropped its queue rows on every `agent_interrupted`, so the two
  server behaviours looked the same for a moment.
- "Cleared later" lost two more messages. One that the user sent between the
  Stop and the end of the stopped turn joined the queue and was cleared with
  it: the redirect that the Stop was pressed for. And a steer that the agent
  did not take was put back in the queue at the turn's end and cleared too.

## The rule

**A Stop empties the queue itself, at the moment it is pressed. A drain never
discards.** (`queue-return.ts`)

1. `interruptAgentTurn` calls `returnQueueOnStop(runner)` first, whether or not
   a turn or an agent is there to stop: a merge or a session hold can keep a
   queue while nothing runs. Every entry leaves the queue (req 2). The function
   reports `"turn"`, `"queue"` (nothing to stop, and the queue was emptied) or
   `"nothing"`; only the last is the error "No active agent process to
   interrupt".
2. A message that the user sent in this session goes to the runner's *returned
   list*, in send order (req 1). `isUsersOwnEntry` is the class:
   `execution === "interactive"`, not `automatic`, no `messageOrigin`, not a
   `steeredDispatch`. It holds a typed message, an answer on a question card, a
   submit from a card, and `/compact` or `/goal` text that waited.
3. Every entry is settled as `dropped` with the reason "stopped by the user",
   and a saved hold row is forgotten (req 3). This is what `clearQueue()` did
   behind a typed turn.
4. The typed drain has no Stop branch any more. What is in the queue when a
   stopped turn ends was sent after the Stop, and runs.

The rule lives at the Stop, so it does not read what kind of turn was stopped
(`docs/329-user-steers-every-turn` req 1).

### A message that was sent before the Stop and arrives after it

Such a message must not start a turn by itself after the Stop. Four paths
bring one:

- a steer that the agent did not take is put back in the queue — at the turn's
  result, at an exit with no result (`requeueUndeliveredSteers`, added there
  for this feature), or when the agent refuses it, which can come after the
  stopped turn has ended (`agent_steer_rejected`);
- a message that a compaction is put ahead of, when the Stop lands while that
  message's turn still sets up (`runCompactionAhead`, and the same step in
  `dispatched-turn.ts`);
- a typed message that was still on its way: it waited at the send gate, for
  an attachment, or for the commit of the turn before (`decideAndRunSend`).

The mechanism:

- **The Stop records a cutoff**: the send order at the Stop, per runner. Send
  orders only grow, so the cutoff is never cleared.
- **The send order is taken when ShipIt accepts a message**, before any gate or
  await: in `handleSendMessage` for a typed message, in `dispatchOnRunner` for
  a dispatch. It travels with the message (`AgentDispatchOptions.sendOrder`,
  kept by `toQueuedMessage` and `queuedMessageToDispatchOptions`, and by a
  steer). A held turn and a wake that is put at the head of the queue carry
  none, so they are never taken for a message sent before the Stop.
- **`sentBeforeStop(runner, order)`** is checked where a message is accepted:
  `dispatchOnRunner` returns such a dispatch instead of starting or queuing it,
  and the typed path does the same before its steer and before it claims the
  turn (`returnLateEntry`).
- **`returnQueueSentBeforeStop(runner)`** takes such entries out of the queue
  where the queue is used: in `takeRunnableQueuedTurn`, the take that every
  drain shares, in `deliverWaitingMessages`, and after a refused steer is put
  back (no drain follows the last one of a stopped turn).

### A message sent after the Stop

It runs, as its own turn after the stopped one. A turn that the user stopped
takes no message (`turnTakesMessages` reads the Stop): its process is ending,
and a message written into it would be read by nobody. So the message waits in
the queue, and the drain of the stopped turn starts it.

### A dispatch that was steered and put back

`steerToQueuedMessage` makes a queue entry `interactive` when its bubble
exists, which is true for a button action (Fix CI, Create PR) that was steered
and not taken. `trySteerDispatch` therefore marks the steer of a dispatch that
is not the user's message (`steeredDispatch`), the mark travels with the entry,
and `isUsersOwnEntry` refuses it. The mark is negative on purpose: an entry
that loses it goes to the input box, and never out of sight.

## Where the returned messages wait

**On the server**, in a list beside the runner (a `WeakMap` in
`queue-return.ts`). The list has the lifetime of the queue that the messages
came from.

- `queue_updated` carries the list in `returned`: every message that waits, not
  only the new ones. It is sent when the list grows, and in the snapshot that a
  viewer gets when it attaches. The attach loop removes `returned` from a
  replayed copy of an earlier event: the list is state, and the copy can name a
  message that was taken since.
- A viewer puts each message that it has not applied into its input box, saves
  the draft, and answers `queue_returned_taken { ids }`. The server removes
  those ids.
- A returned message is `{ id, text, files? }`. `id` is the id of the queue row
  (`clientRequestId`). `files` holds the file references and the uploads (paths
  under `/uploads/`); a steer that was put back keeps its upload paths for this
  (`QueuedMessage.uploadPaths`).

Why a list with an acknowledgement, and not one event: the turn-event log that
replays events to a viewer that connects again is cut when the rows of the
stopped turn are saved, seconds after the Stop. A viewer whose connection
dropped for those seconds would get an empty queue and no messages.

## The input box

- `handleQueueUpdated` hands the list to `returnedToComposer` in the session
  store, **with its session id**. It removes a predicted queue row of a
  returned message (an empty snapshot keeps predicted rows), and the bubble of
  one that was still on its way at the Stop (it had no queue row to take it).
- `MessageInput` takes an offer only when it is the chat composer of that
  session and can take text. Until then the offer stays in the store, and the
  server keeps its copy; a session switch drops the offer, and the next attach
  offers it again.
- `takeReturnedMessages` (`utils/returned-messages.ts`) places the text against
  the composer's current text: before what the user was writing, and after
  returned text that is still at the head of the box, so a message that returns
  later keeps its place in the send order. It records the ids **per tab**
  (`sessionStorage`), as the input box is per tab, and keeps only the ids the
  server still offers — one the server was answered for never comes again.
- The composer sets that text and saves it as the draft, adds the files as file
  chips (`pendingFiles`; the send path turns a path under `/uploads/` back into
  an upload), and only then calls `onReturnedTaken`, which sends the
  acknowledgement.
- A list that arrives a second time (the acknowledgement was lost, or the tab
  was loaded again) adds nothing, and is acknowledged again.
- A session switch clears the file chips: they name the outgoing session's
  files.
- `handleAgentInterrupted` no longer clears the queue rows. The server's
  `queue_updated` says what the queue holds, and a row for a message that the
  user sent after the Stop stays.

## Choices of this design

None of these is a requirement. Each has a reason.

- **The user's "Kill agent" applies the same rule** (`killAgent` with
  `stoppedByUser`, set by the route `POST /agent/kill`). Before, the typed drain
  cleared the queue after a Kill, because a Kill is marked as the user's stop.
  Without this choice the queue would start to run after a Kill. The other
  caller of `killAgent`, the restart of the process after a plugin install,
  leaves the queue.
- **A row that the user cancels in the queue strip is settled as dropped**
  (`handleCancelQueuedMessage`). It was removed with no word to its sender: an
  automatic CI fix then stayed "running" for ever, and its claim blocked the
  automatic merge for 30 minutes. This is the same statement as point 3 of the
  rule.
- **Every viewer that is attached when the list arrives takes the messages**,
  two tabs of one browser too. The input box is per tab, and the server cannot
  know which one the user looks at. Two tabs of one session share one saved
  draft, as before this feature: the last one to change it wins.
- **A file chip is cleared on a session switch** (`resumeSessionInternal`).
  Before, a chip added with "Add to chat" stayed and was sent with the next
  session's message.
- **Uploads return as file chips, not as upload chips.** An upload chip owns
  its file: removing it deletes the file, which an earlier message can still
  show. A file chip is a reference.

## Each sender of a ShipIt entry (req 3)

Requirement 3 says that a sender delivers again by its own rule. Each rule was
read at the source on 2026-10-12. "Dropped" is the outcome that a Stop gives.

| Entry | What its sender does when it is dropped |
|---|---|
| Notice that the session's own pull request merged or closed (`merge-watch.ts`) | Sends again by itself: 30 s to 10 min later, five attempts in all. |
| Message from another session (`services/session-inbox.ts`) | Sends again by itself: when the session is idle, and on a 60 s pass. The notice is a database fact until the agent has read it. |
| Automatic CI fix (`auto-fix-manager.ts`) | Starts again by itself at a later poll, about 1 to 3 minutes later. A dropped fix counts as no attempt. |
| Note after a container restart, note about stopped background jobs, follow-up of a rebase | Kept as a note for the session's next turn. Nothing starts a turn for it. |
| Result of a finished consult (`services/consult-result-delivery.ts`) | **Not sent again.** The result stays on its card, and `shipit agent result` reads it. |
| An action that the user started with a button and that waited (Fix CI, Create PR, Fix preview errors), a message from a page (`window.shipit`) | **Not sent again.** The user presses the button again. |
| A compaction that the agent asked for | **Not done.** |
| A held turn that came back from the database after an orchestrator restart | **Not sent again**, except the merge notice above. Its callback died with the old process. |

The rows in bold lose their entry. All of them did so before this feature
behind a turn that the user typed; the feature makes it true behind every
turn. planning#695 tracks the consult result, which is the one that costs the
user work.

## Known limits

- The returned list is in memory. It is lost with the runner, as the queue is:
  a runner that is disposed, or an orchestrator restart, before a viewer took
  the messages. A Stop from the chat has a viewer; a Stop on a scheduled run
  from the Schedules panel can have none, and the messages then wait for the
  next viewer of that session.
- The file chips of a returned message are not saved across a reload of the
  page, as for any file reference in the input box. The text is.
- The per-message choices of a returned message are not restored: its
  permission mode, its "Compact the context" and "Reset the branch" ticks, and
  its link to an action card or a status-card offer. The text of a card submit
  is the full instruction, and the card stays marked as sent.
- An inline image (`images` on the frame) does not return. The composer sends
  uploads, never inline images.
- When only a message on its way is there at the Stop (no turn, no queue), the
  Stop still answers "No active agent process to interrupt"; the message
  returns to the input box all the same.
- The draft and the per-tab record are written one after the other, and a full
  storage drops a write without a word, as for any draft. A tab that closes
  between them, or a draft that could not be saved, can show a message two
  times or lose it on a reload.
- A held turn whose saved row could not be deleted (a database error) comes
  back after a Stop or a cancel, as it did before this feature, and its
  sender's callback can be called a second time.
- A turn that the user stopped while it set up was the user's answer to a
  question: the automatic turns that the question held are put back in the
  queue by that setup, after the Stop, with no send order. They run, as
  `docs/322-question-holds-automatic-turns` req 4 says for a user's turn that
  ended. Before this feature the typed drain discarded them.
- A message that waits in the queue of a runner that a container restart
  replaces is carried to the new runner. A Stop during that restart does not
  reach it.

## Review record

2026-10-12, on the first version of this design, before any code. One run of
the configured reviewer with three briefs: the requirements, "would anyone
notice if it were removed?", and what is wrong.

- **Kept after the removal brief:** the list on the server with an
  acknowledgement, the second pass, the attachments, the return of commands and
  answers, the record of applied ids.
- **Removed:** a message type of its own. The list rides `queue_updated`.
- **Changed:** the second pass was keyed to the turn that was stopped, and a
  turn that the CLI starts by itself replaced that key; it is a cutoff per
  runner now. The send order was taken when an entry entered the queue, which
  is after the Stop for a message whose turn was setting up; it is taken at
  acceptance now. A Stop with no turn and no agent returned nothing; it empties
  the queue now. The class of the user's messages read `execution` alone; the
  mark of a steered dispatch was added. The input box took an offer with no
  session id; the offer carries one, and the draft is saved before the answer.
  Uploads were to return as upload chips; they return as file chips. A steer
  that was put back had lost its upload paths; it keeps them. "Kill agent" was
  left out, which changed it; it follows the rule now.
- **Not changed:** the held turns of a stopped answer turn (see "Known
  limits").

2026-10-13, on the code. One run of the configured reviewer.

- **Changed:** a message sent after the Stop was written into the ending
  process, and lost when it ended with no result; a stopped turn takes no
  message now. A message on its way at the Stop could start a turn after it;
  the cutoff is checked where a message is accepted now, not only in the queue.
  A steer that the stopped agent never read stayed a bubble when its process
  ended with no result; it is put back and returned. A refused steer that came
  after the stopped turn's last drain stayed in the queue; the refusal applies
  the cutoff. Returned messages that came in two parts were in reverse order;
  the composer keeps the order. The record of applied ids was shared by the
  tabs of a browser and capped at 100; it is per tab and pruned by the
  server's list. The draft was written from storage and the box from React
  state; both take the same text now. File chips crossed a session switch;
  the switch clears them.
- **Not changed:** the storage failures and the held-row deletion failure
  ("Known limits"); the held turns of a stopped answer turn; a Stop during a
  container restart (the queue is carried to the new runner); the consult
  result (planning#695).

## Key files

- `src/server/orchestrator/queue-return.ts` — the rule, the list, the cutoff.
- `src/server/orchestrator/services/agent-interrupt.ts` — the Stop.
- `src/server/orchestrator/queue-drain.ts`, `dispatch-steering.ts` — the second
  pass.
- `src/server/orchestrator/session-runner.ts`, `prepared-dispatch.ts`,
  `ws-handlers/send-message.ts` — the send order at acceptance.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — the typed drain
  without its Stop branch.
- `src/server/orchestrator/ws-handlers/misc-handlers.ts` — the acknowledgement,
  and the cancel that settles.
- `src/server/orchestrator/route-registry.ts` — the list on attach.
- `src/server/orchestrator/services/recovery.ts` — the user's Kill.
- `src/client/utils/returned-messages.ts`,
  `src/client/hooks/message-handlers/queue-updated.ts`,
  `src/client/components/MessageInput/MessageInput.tsx` — the client side.
