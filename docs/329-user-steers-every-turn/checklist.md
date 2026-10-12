# The user steers every turn — checklist

## Before the build

- [x] `requirements.md` from the user's words
- [x] `plan.md`
- [x] Independent review of the requirements and the design, with one pass on
      the brief "would anyone notice if it were removed?"

## Part 1 — work turns are ordinary turns

- [x] The wakes, the automatic CI fix, the credential removal, the rebase
      follow-up and the compaction follow-up stop setting `systemTurn`
- [x] `whenBusy: "queue"` is never steered, and those dispatches pass it
- [x] A streaming turn settles at the result of its own prompt
- [x] `completed` on a reused process needs the prompt's own result
- [x] An adopted turn settles at its next result
- [x] The delivery id travels with a turn's own prompt to the worker
- [x] The one-shot note is keyed on the process
- [x] No compaction ahead of a turn while the resident has background work
- [x] `wakeSessionWithTurn` passes `reusingResidentAgent` when a resident is alive
- [x] The queue takes the user's entry before an automatic one
- [x] The restart follow-up enters the carried queue before the hold comes off
- [x] Tests, with a mutation check for each new one
- [x] Independent review of the diff against every numbered requirement
- [x] `src/server/shipit-docs/environment.md`, `sessions.md`, and the wiki

## Part 2 — a message waits only for an agent that can read it

- [x] The design, corrected for the defects in the review record
- [x] A second review of the corrected design
- [x] The turn phase knows `ready` and `compaction`; both deciders read it
- [x] `verifyRunningState` leaves a turn in setup alone
- [x] A waiting message of the user's is delivered to the turn that starts
- [x] A waiting message with an attachment is delivered too
- [x] An answer takes the admission of a typed message
- [x] Tests, with a mutation check for each new one
- [x] Independent review of the diff against every numbered requirement
- [x] The agent-facing docs and the wiki

## Part 3 — the session hold, and the last two turns

- [x] The design, corrected for the open points of the reviews
- [x] Independent review of the corrected design, with one pass on the brief
      "would anyone notice if it were removed?"
- [x] `runner.sessionHold`; no turn writes the hold; the gate admits the
      holder's own step by identity
- [x] The rebase flow replaces the agent process before its step, counts a
      stopped or failed turn as a failed step, and ends the step's process
      before it runs git
- [x] The timeout of an automatic attempt releases the hold of its own flow
- [x] ShipIt's compaction turns take the path of every dispatched turn
- [x] `systemTurn` and `systemTurnInProgress` are deleted
- [x] Tests, with a mutation check for each new one
- [x] Independent review of the diff against every numbered requirement
- [x] The older design docs that state the old rule, the agent-facing docs
      and the wiki
