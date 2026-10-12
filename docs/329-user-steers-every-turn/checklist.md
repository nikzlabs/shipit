# The user steers every turn — checklist

## Before the build

- [x] `requirements.md` from the user's words
- [x] `plan.md`
- [ ] Independent review of the requirements and the design, with one pass on
      the brief "would anyone notice if it were removed?"

## Build

- [ ] A streaming turn settles at the result of its own prompt
- [ ] `whenBusy: "queue"` is never steered
- [ ] The queue takes the user's entry before an automatic one
- [ ] `runner.sessionHold` and `takeSessionHold`; no turn writes the hold
- [ ] The steer rule reads a running turn and `runner.compacting`, not the hold
- [ ] `systemTurn` is gone from the dispatch shape, the queue entry, the executor
      and every caller
- [ ] The rebase driver keeps its hold across the resolution turn
- [ ] An answer under a session hold is queued, not refused
- [ ] A restart with a queued message of the user's parks its note and lets the
      message run first
- [ ] `wakeSessionWithTurn` passes `reusingResidentAgent` when a resident is alive

## Tests

- [ ] A message typed during a turn that ShipIt started is steered
- [ ] A dispatched streaming turn settles `completed` with no process exit
- [ ] A message typed during conflict resolution is steered; one typed between
      two steps of the rebase is queued
- [ ] A message typed during a compaction is queued in front
- [ ] The queue order, the answer under a hold, the restart note
- [ ] Mutation checks for each new test

## After the build

- [ ] Independent review of the diff against every numbered requirement
- [ ] `src/server/shipit-docs/environment.md`, `sessions.md`, and the wiki
- [ ] The older design docs that state the old rule
