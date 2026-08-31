# Network mode at session creation — implementation

- [x] `EgressEnforcementStatus` — report WHICH inactive deployment it is, since the two cases point in opposite directions
- [x] Strict validation on both session egress routes (unknown id → 404, bad `override` → 400)
- [x] No audit card for the creation-time choice; a card for every later change
- [x] `reconcileSessionEgress` — compare the resolved mode against the raw `egressContainedAtStart`, restart on disagreement
- [x] `restartContainer` gains `resetBreakers` / `agentSeed`; reconciliation takes neither of Rescue's privileges
- [x] `withFirstTurnAdmission` — session-keyed section covering competing first Sends **and** the override PUT
- [x] `turnStartInProgress` — a pre-spawn reservation `verifyRunningState()` cannot clear
- [x] First-Send reconciliation wired into `send-message.ts`, released in a `finally` around the whole handler
- [x] Quick Capture: `networkMode` through the request, persisted and reconciled before `getOrCreate`, with the agent seed
- [x] Interactive claim resets a reused draft's override (req 8)
- [x] Runner incarnation in the `active_runners` snapshot + live `runner_replaced`, so a second viewer converges
- [x] Combined flat control: Permission mode + Network access, one trigger, every viewport
- [x] Mode leaves `ComposerSettingsMenu`; the role root collapses onto the role list (req 9)
- [x] `useSessionNetworkMode` / `useComposerNetworkMode` — shared mutation clock, pre-claim draft, Send barrier
- [x] `session_egress_changed` invalidation; the global egress fields stay fresh without the Settings editor
- [x] Session settings dialog: shared copy, one name for one value, enforcement warning that names the case
- [x] Tests: reconciliation states, admission lock, the combined control, route validation, req 8 through the reuse path

## Review round 2 — findings fixed

The independent review returned "not ready" with three P1s and four requirement
gaps. All verified at the source, all fixed.

- [x] **P1** `dispatch` treats `turnStartInProgress` as busy — a first Send that lost the admission race re-entered through the shared dispatcher, which consulted only `running`, and started a second turn
- [x] **P1** a failed write reverts to the last SERVER-accepted value, not the last optimistic one; and every response is owned by the currently-mounted session, not just its revision
- [x] **P1** `runner_replaced` is announced by the caller AFTER it attaches — announcing inside the restart reached the sending tab, whose reconnect closed the socket that handler then attached as an undetachable ghost viewer
- [x] **req 7** `SessionSettingsDialog` reads and writes through the shared hook; it no longer owns a parallel fetch, mapping and PUT
- [x] **req 7** the reused-draft reset emits the transient invalidation
- [x] **req 8** the pre-claim draft is scoped to its claim, so `/repo-A/new` → `/repo-B/new` abandons it
- [x] **req 9** the menu opens onto the role list when Role is the only row the root would hold — removing the Mode row was necessary and not sufficient
- [x] **req 10** the workspace default is read before the claim, so `Inherit` cannot say "currently Contained" on an Open workspace
- [x] dead code removed: `seenRevision`, `firstTurnAdmissionHeld`, the dialog's own mode helpers

## Review round 3 — findings fixed

The re-review found the round-2 fixes incomplete and three further races. All
verified at the source.

- [x] **P1** the first turn's mode is frozen until the turn is DISPATCHED, not until reconciliation returns — a replacement container still `starting` samples its policy later, so every override writer (the PUT, and the reused-draft reset) now waits on a session-scoped claim
- [x] **P1** the claim is taken BEFORE reconciliation and is session-scoped, so it spans the window where `restartContainer` has published a replacement runner that nothing yet marks — a programmatic `dispatch()` could start a turn there
- [x] **P1** a failed write RE-READS from the server instead of reverting to a remembered value: an older write that succeeded never advanced the remembered one, so a newer failure rewound past a change the server had accepted
- [x] **req 7** `setMode` notifies sibling surfaces directly; SSE is an optimization, not the path — an interruption during a write left the two surfaces disagreeing indefinitely
- [x] **req 10** the control names no workspace default until one has been read; the store's optimistic `Contained` is a placeholder, not a fact
- [x] stale tooltip and doc comments claiming this menu still holds the permission mode

## Review round 4 — the races fixed at the cause

Round 3 hardened the locks and round 4's review found two more ways past them,
which is the signal that locking was the wrong shape. The cause is that
containment is resolved when the container is *created* — an unbounded time
after the turn is admitted — by re-reading a store anyone may write. So the
admitted turn now carries its answer and creation reads that.

- [x] **P1** the first turn's containment is **pinned** onto its claim and read at `resolveEgressConfig`, the one seam that decides it — a write landing during the rebuild persists without moving the admitted turn
- [x] **P1** the settings PUT no longer waits on the claim: the 30 s bounded wait wrote through on timeout, violating the guarantee it existed to keep. `awaitFirstTurnClaim` and its timeout are deleted, not tuned
- [x] **P1** `handleSendMessage` claims a warm session's first turn at **entry**, before its first await — the interactive `/new` reuse path may otherwise recycle the session and reset its override out from under a Send already in flight
- [x] **P1** the direct turn start re-checks the claim: it sets `running` and calls `runAgentWithMessage` without going through `dispatch()`, so it inherited nothing from that check and could start a turn beside the first
- [x] the disagreement check resolves through the container manager's seam, not the store — a docs/211 sealed sandbox otherwise reports a disagreement no rebuild can fix
- [x] `Inherit` is pinned to what it resolved to at admission, so a concurrent workspace-default change cannot move an admitted turn either — a case round 3 explicitly gave up on
- [x] the claim entry is simpler, not more complex: no promise, no timer, released by identity so a late `finally` cannot drop a newer turn's pin

Every new guard was verified by deleting it alone and watching its test go red.
One thing is deliberately **not** covered by a test: that the entry claim is taken
*early enough*. Its placement is an argument about the code above it, not an
observable the harness can drive — what is tested is the consequence, that a
held claim makes the reuse path stand down.

**Three tests in the previous round were blind by construction** and were rebuilt:
a `dispatch` test on a runner with no system-turn deps enqueues for that reason
alone; a second one reused a runner whose control turn was still in flight; and
the overlapping-write test reverted through a path the bug did not take. Each
guard is now individually proven red without its fix.
