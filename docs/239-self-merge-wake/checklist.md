# Self-merge wake — checklist

ShipIt does not mutate the session branch; the agent runs the reset inside its own turn
via a tested command. The command's safety gate is load-bearing — it is what converts
three separate hazards from data loss into a visible refusal.

## Prerequisite

- [ ] **SHI-262** — queue drains before the finished turn's commit (fixed separately)

## The reset command

- [ ] `shipit branch reset-to-base` — a **distinct** `resetMergedBranchToBase` service, not the interactive policy wrapper
- [ ] Safety gate only — **ignores** `getAutoResetMergedBranch()` (else the feature no-ops for anyone who disabled it)
- [ ] Gate: `HEAD === mergedHeadSha`, clean tree, on `session.branch`, no sequencer — fails closed
- [ ] **Idempotent**: clean tree ∧ already at base tip → `already-at-base`, exit 0, "proceed" (not a refusal)
- [ ] Distinct outcomes: `reset | already-at-base | refused(reason) | error` — not one `moved: false`
- [ ] Force-push via the live-tip lease (`ls-remote`), not a bare `--force-with-lease`
- [ ] A failed force-push is **not** reported as success (else the chain continues onto a diverged remote)
- [ ] Performs the docs/216 session/poller re-arm + PR-card update its current caller does separately
- [ ] Takes `withWorkspaceLock` (it now runs during an active turn, alongside post-turn commit)
- [ ] `handWorkspaceBackToWorker` in a `finally` — the orchestrator runs as root; without it the agent hits `EACCES` on its next edit
- [ ] Refusal message is load-bearing agent-facing copy: says why, and forbids a hand-rolled reset
- [ ] Shim + worker relay + orchestrator route; budget the shim HTTP timeout (fetch + reset + push, mid-turn)

## Watch state

- [ ] `SelfMergeWatch`: `watchId`, anchor PR number, `mergedHeadSha`, `followUp`, remaining plan, `cardId`, delivery record
- [ ] Column + migration (`shared/database.ts`)
- [ ] States `armed → merge-observed → delivered`; terminal `expired`, `cancelled`, `delivery-failed`
- [ ] All transitions go through the watch manager (single writer), each checking current state
- [ ] Shared exhaustive pending predicate → list query + supervisor + polling gate
- [ ] Separate list from the child watches (no misrouting into the child handler)

## Arm surface

- [ ] `--self` + `--then-file` (stdin via `-`); inline `--then` rejected
- [ ] Validate non-empty + bounded length in shim **and** orchestrator
- [ ] Refuse: archived, no branch, unparseable remote, **no open PR**
- [ ] Resolve the PR by **live lookup** (`findPullRequestAnyState`), never from the `pr_status` snapshot
- [ ] Already-merged at arm → fire now (`checkAndFireNow`), don't arm
- [ ] Arming always replaces — no "refuse while non-terminal" rule
- [ ] Cancel route carries `watchId`
- [ ] Container-accessible route golden test

## Delivery

- [ ] Fire from `onMergeDetectedCb` immediately after `markMergedAndPruneExcess`, before the reset-eligible signal
- [ ] Carry `{prNumber, headSha, baseBranch}` into the merge callback
- [ ] Closed outcomes fan out from `onPrTerminalState` → expire, no turn
- [ ] **Startup reconcile for self-watches** (the `alreadyTerminal` hole) — merged and closed
- [ ] Restore an evicted workspace before dispatch
- [ ] Anchor bound at arm time; merged PR not matching the anchor → drop the watch with a note
- [ ] Dispatch via `prepareDispatch`; advance only on `status === "completed"`
- [ ] Don't assume a settlement always arrives
- [ ] Pending self-watches keep `PollingGlobalGate` open

## Chaining (agent-level — ShipIt models no chain)

- [ ] Arming **replaces** any existing watch, including `merge-observed` (else the wake can never re-arm)
- [ ] The woken turn re-arms with the *remaining* plan as the new follow-up text
- [ ] Cancel stops the next wake; a turn already in flight still finishes — card copy says so
- [ ] A refused reset ends the chain naturally (agent reports, does not re-arm)
- [ ] No chain object, revisions, staged links, or cancellation tombstone

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

- [ ] Arm refusals (each), already-merged-at-arm fires now, arming replaces at both `armed` and `merge-observed`
- [ ] Re-arm immediately after `gh pr create` anchors to the NEW PR, not the stale merged snapshot
- [ ] Reset command: idempotent second invocation returns `already-at-base`; setting-disabled still runs; force-push failure is not success; workspace is handed back (agent can edit afterwards)
- [ ] Crash between terminal-snapshot persist and delivery still wakes
- [ ] Closed-unmerged expires with no turn, including after restart
- [ ] Merged PR not matching the anchor drops the watch rather than retargeting
- [ ] Reset command refuses on dirty tree / moved HEAD / detached / sequencer, and the wake reports
- [ ] A wake queued behind a turn with uncommitted edits destroys nothing
- [ ] Restart during a wake produces no second destructive turn
- [ ] Evicted workspace restored before dispatch (distinct from reaped container)
- [ ] Cancel-vs-merge ordering, late settlement after cancel, stale-card cancel after re-arm
- [ ] Chaining: three-step plan runs three links; Cancel stops mid-chain
- [ ] Card round-trip, no duplicate on replay, `expired` with no runner

## Docs

- [ ] `shipit-docs/sessions.md` — `--self --then-file`, the reset command, chaining
- [ ] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant
