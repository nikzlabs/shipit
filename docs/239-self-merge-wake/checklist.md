# Self-merge wake — checklist

ShipIt does not mutate the session branch; the agent runs the reset inside its own turn
via a tested command. The command's safety gate is load-bearing — it is what converts
three separate hazards from data loss into a visible refusal.

## Prerequisite

- [ ] **SHI-262** — queue drains before the finished turn's commit (fixed separately)

## The reset command

- [ ] `shipit branch reset-to-base` over the existing `pre-turn-reset` logic
- [ ] Gate: `HEAD === mergedHeadSha`, clean tree, on `session.branch`, no sequencer — fails closed
- [ ] Force-push via the live-tip lease (`ls-remote`), not a bare `--force-with-lease`
- [ ] Handles both "remote branch deleted" and "delete failed, remote diverged"
- [ ] Shim + worker relay + orchestrator route

## Watch state

- [ ] `SelfMergeWatch`: `watchId`, anchor PR number, `mergedHeadSha`, `followUp`, remaining plan, `cardId`, delivery record
- [ ] Column + migration (`shared/database.ts`)
- [ ] States `armed → merge-observed → delivered`; terminal `expired`, `cancelled`, `superseded`, `delivery-failed`
- [ ] Atomic CAS on `{watchId, expectedState}` for every transition
- [ ] Shared exhaustive pending predicate → list query + supervisor + polling gate
- [ ] Separate list from the child watches (no misrouting into the child handler)

## Arm surface

- [ ] `--self` + `--then-file` (stdin via `-`); inline `--then` rejected
- [ ] Validate non-empty + bounded length in shim **and** orchestrator
- [ ] Refuse: archived, no branch, unparseable remote, **no open PR**
- [ ] Already-merged at arm → fire now (`checkAndFireNow`), don't arm
- [ ] Amend replaces an `armed` watch; refused once `merge-observed`
- [ ] Cancel route carries `watchId`
- [ ] Container-accessible route golden test

## Delivery

- [ ] Fire from `onMergeDetectedCb` immediately after `markMergedAndPruneExcess`, before the reset-eligible signal
- [ ] Carry `{prNumber, headSha, baseBranch}` into the merge callback
- [ ] Closed outcomes fan out from `onPrTerminalState` → expire, no turn
- [ ] **Startup reconcile for self-watches** (the `alreadyTerminal` hole) — merged and closed
- [ ] Restore an evicted workspace before dispatch
- [ ] Supervisor refactored to key by `{kind, watchId}` (child + self on one session must not collide)
- [ ] Anchor bound at arm time; docs/202 re-arm → `superseded`
- [ ] Dispatch via `prepareDispatch`; advance only on `status === "completed"`
- [ ] Don't assume a settlement always arrives
- [ ] Pending self-watches keep `PollingGlobalGate` open

## Chaining

- [ ] The woken turn may re-arm with the remaining plan
- [ ] Cancel stops the whole chain, not just the current link
- [ ] Each link's card shows what remains queued

## docs/218 overlap

- [ ] A pending self-watch suppresses `resetEligible`
- [ ] The wake prompt is built from delivery-time state, not merge-time state

## Prompt

- [ ] Co-located `prompts/self-merge-wake.md`, `loadPrompt` at module top level
- [ ] Instructs: run the reset command first; stop and report if it refuses; don't re-apply shipped work
- [ ] Shared escape clause with docs/196 via one `buildWakeTurnPrompt`

## Card

- [ ] Arm via `emitChatCard`; transitions via `persistCardTransition`
- [ ] `persistCardTransition` works with no runner (`expired` starts none)
- [ ] `cardId` on the watch; card repairable from watch state
- [ ] Archive-after-arm transitions the card visibly
- [ ] Persisted field + column + migration + `toRow`/`fromRow`; rehydrate in `loadSessionHistory`
- [ ] `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`; WS type in `TRANSCRIPT_SCOPED_MESSAGES`
- [ ] Client card + handler + Cancel

## Tests

- [ ] Arm refusals (each), already-merged-at-arm fires now, amend replace/refuse
- [ ] Crash between terminal-snapshot persist and delivery still wakes
- [ ] Closed-unmerged expires with no turn, including after restart
- [ ] docs/202 re-arm supersedes rather than retargets
- [ ] Reset command refuses on dirty tree / moved HEAD / detached / sequencer, and the wake reports
- [ ] A wake queued behind a turn with uncommitted edits destroys nothing
- [ ] Restart during a wake produces no second destructive turn
- [ ] Child + self watch on one session don't collide in the supervisor
- [ ] Evicted workspace restored before dispatch (distinct from reaped container)
- [ ] Cancel-vs-merge CAS, late settlement after cancel, stale-card cancel after re-arm
- [ ] Chaining: three-step plan runs three links; Cancel stops mid-chain
- [ ] Card round-trip, no duplicate on replay, `expired` with no runner

## Docs

- [ ] `shipit-docs/sessions.md` — `--self --then-file`, the reset command, chaining
- [ ] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant
