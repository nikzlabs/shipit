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
- [ ] Independent review of the diff against every numbered requirement
- [x] `src/server/shipit-docs/environment.md`, `sessions.md`, and the wiki

## Part 2 — the session hold, and the last two turns

- [ ] The design, corrected for the defects in the review record, and reviewed
- [ ] `runner.sessionHold`; no ordinary turn writes the hold
- [ ] The conflict-resolution turn accepts a message from the user
- [ ] ShipIt's compaction turns, and a message typed during one
- [ ] An answer under a hold is queued, not refused
- [ ] `systemTurn` and `systemTurnInProgress` are deleted
- [ ] The older design docs that state the old rule
