# Network mode at session creation — implementation

- [x] `EgressEnforcementStatus` — report WHICH inactive deployment it is, since the two cases point in opposite directions
- [x] Strict validation on both session egress routes (unknown id → 404, bad `override` → 400)
- [x] No audit card for the creation-time choice; a card for every later change
- [x] `reconcileSessionEgress` — compare the resolved mode against the raw `egressContainedAtStart`, rebuild on disagreement
- [x] `restartContainer` gains `resetBreakers` / `agentSeed`; the rebuild takes neither of Rescue's privileges
- [x] The rebuild runs inside `PUT /api/egress/session/:id`, before it answers, for ungraduated sessions only
- [x] Quick Capture: `networkMode` through the request, persisted and rebuilt before `getOrCreate`, with the agent seed
- [x] Interactive claim resets a reused draft's override (req 8)
- [x] Runner incarnation in the `active_runners` snapshot + live `runner_replaced`, so a second viewer converges
- [x] Combined flat control: Permission mode + Network access, one trigger, every viewport
- [x] Mode leaves `ComposerSettingsMenu`; the role root collapses onto the role list (req 9)
- [x] `useSessionNetworkMode` / `useComposerNetworkMode` — shared mutation clock, pre-claim draft, Send barrier
- [x] `session_egress_changed` invalidation; the global egress fields stay fresh without the Settings editor
- [x] Session settings dialog: shared copy, one name for one value, enforcement warning that names the case
- [x] Tests: rebuild states, the write-time trigger, the combined control, route validation, req 8 through the reuse path

## Rounds 2–5, and the simplification that ended them

Four independent review rounds each found a race in the first-Send
reconciliation, and each was answered with more mechanism: a session-keyed
admission section, a runner-local pre-spawn reservation, a session claim, a
hand-off path, a timer-backed policy snapshot. Round 5 still found four P1s, and
named the real problem — the ownership model, not the plumbing.

**The fix was to move the rebuild from the first Send to the write itself.** The
container is then created immediately after the value it reads was written, by
the only writer there is, so there is no window for the two to disagree and
nothing to freeze. The composer's existing save barrier covers the wait, which is
the "locked until the container is available" state the product already shows on
`/new`.

Deleted rather than fixed:

- [x] `services/first-turn-admission.ts` in full — admission section, session claim, egress pin, and the 2-minute pin expiry
- [x] `turnStartInProgress` on both runner implementations, and the `verifyRunningState()` early-returns that read it
- [x] the `dispatch()` busy-check addition
- [x] the first-Send block, entry claim, hand-off and direct-turn-start guard in `ws-handlers/send-message.ts`
- [x] the pin application in `index.ts`'s `resolveEgressConfig` and its consumption in `container-lifecycle.ts`

`ws-handlers/send-message.ts`, `container-session-runner.ts`,
`container-lifecycle.ts` and `index.ts` are now **identical to `main`**, and
`session-runner.ts` keeps only the runner-incarnation counter (+31 lines), which
a container rebuild needs whoever triggers it. That is the honest measure of how
much of this feature had become mechanism defending mechanism.

Every P1 from rounds 4 and 5 is answered by the deletion rather than by a patch:
the Quick Capture self-queue (no claim exists to queue behind), the pin's
lifetime and incarnation ownership (no pin), the `Inherit` requirement reversal
(nothing is pinned, so req 3's wording stands unchanged), the reuse TOCTOU (no
claim, and the reuse reset is `main`'s behaviour), and the queued-message strand
(no entry claim).

What remains from those rounds, kept because it was right on its own terms:

- [x] **P3** `beforeFirstTurn` reads session membership, not `messages.length` — the message list is momentarily empty right after switching to an existing session, which made the control promise a rebuild the server was never going to run
- [x] **P3** a successful read opens the Send barrier, so a failed write whose recovery read also failed no longer bars Send until the user navigates away — guarded by an in-flight-write count so an invalidation cannot release it early

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

## Review round 5 — the pin's lifetime, and a requirement it had reversed

Round 4's review found the pin correct in shape and wrong in lifetime, plus one
outright break. All verified at the source before touching anything.

- [x] **P1** Quick Capture took a first-turn claim and then dispatched through the shared dispatcher, which treats a held claim as busy — so an explicit Contained/Open **enqueued its own prompt behind itself** and returned success with nothing to drain it. It now takes no claim; the claim's two jobs are meaningless for a session created in that same call
- [x] **P1** the pin was released before the container consumed it: the agent start is fire-and-forget, so `handleSendMessage` returns — and its `finally` runs — while the replacement is still being built. The pin is no longer tied to the claim; it ends when a container is **built** with it (`container-lifecycle.ts`), with a 2-minute backstop for the build that never comes
- [x] **P1** round 4 pinned `Inherit` too, which **reverses requirements 3 and 10** — the human's words leave Inherit as "the workspace setting as it stands when the session's container starts … the only case a workspace-default change during Send can move", and req 10 forbids presenting it as pinned. Only an explicit pick is pinned now. A requirement is not something a mechanism gets to change
- [x] **P2** the `/new` reuse path now **takes** the first-turn claim across its workspace reset instead of only checking it: the check passed, `refreshClaimedSession` yielded, and a Send arriving in that window claimed and ran while the reset moved the tree under it
- [x] the claim is a plain `Set` again — no promise, no timer, no pin — and its release is idempotent
- [x] the reuse-refusal test asserts the surviving override rather than the second claim's session id: which session that claim lands on depends on pool replenishment, and asserting it flaked under a loaded full-suite run while passing alone

**Known and bounded, not fixed:** a programmatic dispatch that queues while a
first Send holds the entry claim stays queued if that Send then fails validation,
until some later turn drains it. The precondition is a programmatic dispatch into
a still-**warm** session, which the sources of such dispatches (CI fix, wake,
parent message — all targeting graduated sessions, and spawns which set
`skipReuse`) do not produce. Fixing it properly means a new drain entry point on
the runner; that is more mechanism than the case earns.

Every new guard was verified by deleting it alone and watching its test go red.
One thing is deliberately **not** covered by a test: that the entry claim is taken
*early enough*. Its placement is an argument about the code above it, not an
observable the harness can drive — what is tested is the consequence, that a
held claim makes the reuse path stand down, from both sides.

**Three tests in the previous round were blind by construction** and were rebuilt:
a `dispatch` test on a runner with no system-turn deps enqueues for that reason
alone; a second one reused a runner whose control turn was still in flight; and
the overlapping-write test reverted through a path the bug did not take. Each
guard is now individually proven red without its fix.
