---
issue: planning#689
title: The user steers every turn
description: A turn that ShipIt starts runs as a turn that the user started, and a message from the user goes to the agent at once.
---

# The user steers every turn

What the feature must do, in the user's terms. Design lives in
[`plan.md`](plan.md).

The report that started it, from the user on 2026-10-12: "if a session, for
example, restarts its own container and continues after that, I cannot steer it
anymore. […] I want to be able to steer it all the time, regardless of
technicalities."

## Requirements

1. Any turn that ShipIt starts behaves exactly the same way as a turn that the
   user started.
2. A message from the user steers the current agent at once, regardless of any
   queued message from other sources.

## Open questions

None.

## Resolved questions

- 2026-10-12 — *What must the feature do?* The user: "My requirements are:
  1. Any turn started in ShipIt should behave exactly the same way as if the
  user started it. 2. The user message should instantly steer the current
  agent, regardless of any queued message from other sources." These are
  requirements 1 and 2.
- 2026-10-12 — *Does the answer of 2026-09-03 in
  `docs/287-consult-result-delivery` stay?* That answer was "No" to "Should
  system turns simply be made streaming?". Requirement 1 reverses it. The
  receipt is in that document.
- 2026-10-12 — *What happens to the flag that marks a turn that ShipIt
  started?* The agent had said that only one of its three meanings is necessary:
  a lock that stops a new turn while ShipIt changes the branch itself, "a lock on
  the branch. It is not a property of a turn." The user: "let's have a separate
  flag for that, and delete the old one." Constraint for the design: the lock is
  a flag of its own, and the old flag does not stay under any name.
- 2026-10-12 — *In what order is the work done?* The user: "Then design and
  build. Don't forget to review the requirements and the design before
  building." The independent review of this document and of `plan.md` comes
  before any code.

## How the requirements are read

The user gave the two sentences above. Nothing in this section is the user's.
It is written down so that a review can see what was not asked for.

### What the two sentences are taken to mean

- **Requirement 1 is about a turn that has started.** It covers what the user
  and the agent can observe of the turn: whether it accepts a message from the
  user, how a Stop ends it, whether the background jobs of the agent go on
  after it, and what ShipIt does after it. It is not taken to cover *when*
  ShipIt may start a turn, or what ShipIt writes into a turn's prompt.
- **Neither requirement names an exception.** A compaction that ShipIt starts
  is a turn that ShipIt starts, and behaves as a compaction that the user
  starts. The agent that resolves the conflicts of a rebase is "the current
  agent". Where this design still differs or waits, "Choices of this design"
  below says so, with the reason.
- **"At once" means the first moment an agent can read the message.** Where no
  agent can read it now, it goes to the agent at the first moment one can, and
  before any message from a different source. The cases:
  - no agent process exists: the container starts or restarts, or the process
    starts;
  - the agent does not have the prompt of the turn yet: the turn sets up;
  - the agent's harness cannot take a message during a turn;
  - ShipIt changes the branch or the container, and no turn runs: a rebase
    between its turns, a restart, the commit after a turn, a merge.
- **An answer on a question card is a message from the user.**

### Requirements of other features that stay

- `docs/322-question-holds-automatic-turns`: no automatic turn starts while the
  agent waits for the user's answer. Requirement 2 speaks of a "queued message
  from other sources", so a message from a different source can still wait in
  a queue.
- The user's own setting `advanced.liveSteering`. Off asks for the queue, and a
  message then waits for the turn's end, whoever started the turn.
- ShipIt still knows who started a turn. The transcript shows it, and the
  sender of a notice still learns whether its turn ran.

### Choices of this design

Each is a choice with a reason. None follows from the user's words alone.

- **A message sent during a compaction turn waits in ShipIt's queue**, and goes
  to the agent when the compaction ends, in the order it was sent. The rule
  does not read who started the compaction. Reason: a compaction turn gives
  ShipIt nothing to steer into, and a message written to the agent then runs
  later as a turn that ShipIt did not order, possibly before the message that
  waited for the compaction, on a branch that message is about to reset
  (`docs/295-compact-context-on-merge`).
- **The agent process of a conflict-resolution turn ends with that turn.** A
  background job that the turn started stops there, and the agent is told. The
  rebase, not the turn, makes the commit. Reason: while ShipIt runs git on the
  branch in a rebase, nothing else may write to the workspace, and ending the
  process is how this design makes sure of that.
