---
issue: planning#191
title: Auto-update a merged session's branch to latest base when work continues
description: When a user resumes a merged session, offer (checked by default) to reset the branch to the latest base before the turn runs, tell the agent, and record the move with a transcript card.
---

# Auto-update a merged session's branch to latest base when work continues

## Problem

After a session's PR merges, its branch is left **exactly where it was** at the
pre-merge tip. Nothing fetches, rebases, or resets it (the merge path only stamps
`merged_at` and prunes volumes — `markMergedAndPruneExcess`). So when a user keeps
the session alive and asks for the *next* slice of work, the branch still points at
the now-superseded merged commits, sitting behind the advanced base.

Today the only way the branch catches up is **manually**: the user (or the agent,
following the system-prompt instruction) runs `git fetch origin && git reset --hard
origin/<base>` themselves, and ShipIt's **reactive** re-arm machinery then notices
and updates the PR card:

- **docs/202** — branch *rebased onto base + new work* → re-arm + new PR.
- **docs/216** — branch *reset to a clean base* → re-arm + clean "ready" card.

Both react to a git move the human already made. Neither **performs** the move. The
result: the user must remember the incantation, or the agent burns a turn on
plumbing (and risks getting the base / force-push lease / conflict handling subtly
wrong) before doing the actual work. In a chat-shaped IDE the expected behavior is
that resuming a shipped session just *starts from latest*.

## Goal

When a user sends a **new message** to a **merged** session whose branch **has not
moved since the merge**, ShipIt should — with the user's (default-on, opt-out-able)
consent, **before the agent turn runs**:

1. `git fetch origin` and **`git reset --hard origin/<base>`** — move the branch to
   the latest base (`<base>` = the merged PR's own base branch).
2. **Inject a context message** into the turn telling the agent its previous PR
   merged and the branch was moved, so it starts fresh and does not re-apply
   already-shipped work.
3. **Emit a persisted card** into the chat transcript so the user plainly sees the
   branch was updated — a destructive automatic op must not happen silently.

The action is **explicit, not silent**: a checked-by-default control sits in the
composer when (and only when) a reset would fire, and the user can untick it to skip
this one time. The behavior is otherwise governed by a global setting (default on),
a sibling of `autoResolveConflicts` / `autoFixCi`.

## Why lazy (on continue), not eager (on merge)

The merge is detected in the **poller** (`pr-status-poller.ts`), a background loop.
Resetting there is the wrong place:

- **The common case is "done."** Most merged sessions are finished; resetting every
  merged branch eagerly is wasted work on branches no one resumes.
- **No live container is guaranteed.** After merge → idle, the container is
  destroyed and the workspace may be disk-evicted; the poller would have to
  rehydrate a clone just to maybe-never-use it, risking lock races.
- **It only matters when work continues.** Continue-time is exactly when a live,
  rehydrated workspace exists and the move has a purpose.

So the trigger is the **pre-turn path of an interactive message** (mirroring how
docs/202/216 are post-turn, turn-gated).

That choice has one cost, and `docs/282-merge-race-at-turn-admission` pays it: a
pre-turn gate is only as right as the merge state it reads, and that state is
poll-driven, so a turn admitted inside the ~15-second poll window used to
evaluate this gate against a session that did not read as merged yet and run on
the merged tip. The merge state is now refreshed at turn admission, ahead of the
gate; nothing about the trigger or the gate itself changed.

## Why `reset --hard`, not rebase

GitHub's three merge methods all leave the branch's local commits **not replayable**:
*squash* never enters the commits into the base (one new squash commit instead),
*merge* / *rebase-and-merge* have the content already in the base. Since the branch
has **no new work** (that is the gate), every commit on it is already shipped, so the
correct conflict-free op is a clean **`reset --hard origin/<base>`** — discard the
now-phantom commits, start from the latest base. A rebase is strictly worse here
(slower, can conflict, replays phantoms).

## The explicit control (the primary UX)

The reset is a destructive default, so it earns visible **pre-consent** rather than
after-the-fact explanation. This is not a §5 "shell-shaped affordance" violation: it
is a per-turn behavior toggle in the same family as the existing permission-mode
selector that already lives by the composer — not a command-runner button.

**Placement (decided): inside the composer border, top row** (option B of
`mockup-control-placement.html`). It lives *inside* the existing composer container —
the same containment the footer controls already use — so **the input's
border-radius never changes**; there is no fragile conditional border math. It keeps
room for a one-line explanation, which makes the feature self-teaching. (Options A
detached-card, C above-footer, D footer-chip were considered and are kept in the
mockup for reference.)

**Behavior:**

- The control appears **only when a reset would actually fire** — i.e. the session
  is reset-*eligible*: merged, `mergedHeadSha` recorded, `HEAD === mergedHeadSha`,
  and a clean working tree (see "Safety gate"). If the branch already carries new
  work, there is nothing to reset, so no control.
- It is **checked by default**, the default driven by a global setting
  `autoResetMergedBranch` (default on). Unticking is a **per-send** choice that does
  **not** persist — the next eligible message shows it checked again. The global
  setting is the escape hatch for someone who never wants it.
- **Visibility is derived from live session state, recomputed after each turn — not
  a one-shot flag.** Two behaviors fall out naturally:
  - **Sent checked →** the reset runs, the branch moves off the merged tip, the
    session re-arms; eligibility is now false → the control disappears and stays
    gone (nothing left to reset).
  - **Sent unticked →** no reset, branch still at the merged tip, still merged →
    eligibility holds → the control reappears (checked) on the next message.
- **Correctness is server-side.** The checkbox value is only the user's *intent*; the
  pre-turn helper re-validates the full gate at send time regardless of what the
  client sent, so a stale client eligibility flag can never cause an unsafe reset.

### Eligibility signal

The client can't run git, so the server computes a transient `resetEligible` boolean
and surfaces it with the session/PR state, recomputed on session activation and after
each turn. **`resetEligible` is safety eligibility only** — merged + `mergedHeadSha`
recorded + `HEAD === mergedHeadSha` + clean tree + good repo state. It deliberately
**excludes** the global setting and the per-send intent. The composer then shows the
control iff `resetEligible && getAutoResetMergedBranch()`: when the global setting is
**off**, the control is hidden entirely (a global opt-out means we don't nag; manual
git remains available). When on, it shows **checked**, with a per-send untick. The
flag is transient (derived; never persisted).

## Safety gate — "no new work since the merge"

A hard reset is destructive, so it fires **only** when the branch carries nothing
that isn't already merged AND the repo is in a plain, resettable state. The full
gate (all clauses; any failure → skip the reset, run the turn on the un-moved branch):

> session merged **AND** a base branch is known **AND** working tree clean
> **AND** HEAD is on `session.branch` (not detached)
> **AND** no rebase/merge/cherry-pick/revert in progress
> **AND** ( HEAD is contained in `origin/<base>` **OR**
> `mergedHeadSha` recorded **AND** `HEAD === mergedHeadSha` )
> **AND** the user did not untick the control.

- **HEAD contained in `origin/<base>`** is a *proof*, not a heuristic: every commit
  reachable from the branch is already reachable from the base, so the reset discards
  nothing by construction — no stored anchor and no operator trust required. It is the
  general case of the `HEAD === origin/<base>` idempotence short-circuit in
  `resetBranchToBaseExplicit`, which only ever caught the exact-equality instant and so
  refused a branch merely sitting *behind* an advanced base. This is **not** the rejected
  shortcut below: a commit made without rebasing puts a commit on HEAD that is not in the
  base, so containment is false and the anchor clause decides as it always did. It reads
  `origin/<base>`, so it is evaluated after the caller's fetch.
- **`HEAD === mergedHeadSha`** is the load-bearing *stored* clause. The tempting "derive it
  from existing git state" shortcut (`!advancedBeyondMergedBase && !headIsAtBase` →
  resettable) has a **data-loss hole**: a user who commits new work *without
  rebasing first* leaves merge-base ≠ base tip (not "progressed") and HEAD ≠ base tip
  (not "at base"), so the shortcut would classify their new commit as resettable and
  `reset --hard` would destroy it. Only the stored merged-tip SHA reliably
  distinguishes "untouched since merge" from "new un-rebased work."
- **Clean tree** guards an *irreversible* loss: uncommitted changes don't move HEAD,
  so a dirty tree could pass the SHA check, and `reset --hard` would wipe edits that —
  unlike committed work — are **not** reflog-recoverable.
- **On `session.branch`, not detached, no in-progress sequencer.** `reset --hard`
  only moves the current ref; on a detached HEAD it would not move the branch (making
  the card's "branch updated" claim false), and during an in-progress
  rebase/merge/cherry-pick/revert it would clobber recovery state. These are
  fast local checks; bail on any of them.

### Sequence (revalidate after fetch — closes the TOCTOU window)

The pre-turn helper, server-side, regardless of the client's checkbox:
1. evaluate the full gate (repo state, clean tree, `HEAD === mergedHeadSha`);
2. `git fetch origin`; verify `origin/<base>` resolves;
3. **re-evaluate** the gate (repo state, clean tree, `HEAD === mergedHeadSha`) — the
   fetch yields to the event loop, during which a terminal edit or agent could move
   the branch;
4. `reset --hard origin/<base>`.

### Recording `mergedHeadSha` — the **PR's** head SHA, not local HEAD

`mergedHeadSha` is the SHA GitHub actually merged (the PR's `head.sha`), **not** the
local clone's HEAD. Local HEAD is unsafe: the session stays alive, so a turn fired in
the window between the GitHub merge and the poller detecting it advances local HEAD to
*new, unmerged* work; capturing that would store unmerged work as the "merged tip,"
and a later `HEAD === mergedHeadSha` reset would destroy it.

So capture it from the authoritative source: extend `findPullRequestAnyState`
(`github-auth-prs.ts`) to return the PR's `head.sha`, and persist it in
`verifyMissingPr` (`pr-status-poller.ts`) where the terminal PR payload is in scope,
**before** firing the merge side effects. (This also avoids the `onMergeDetectedCb`
signature limitation — that callback only receives `sessionId`.) Follows the
`previousMergedPr` (docs/202) persisted-field pattern: `merged_head_sha TEXT` column +
migration, `SessionRow` + `fromRow` parse + `SessionInfo.mergedHeadSha`, a setter.

**Fail closed.** If no PR head SHA is available, store **no SHA** and never
auto-reset — the user falls back to today's manual flow (still picked up by
docs/202/216).

**…but the anchor must survive a re-arm.** `clearMerged` nulls `merged_at` and
`merged_head_sha` in one statement, and `PrStatusPoller.reArm` nulls the live PR snapshot
in the same beat, so a re-armed session (docs/202 / docs/216 — the ordinary
keep-working-after-a-merge path) lost every input the gate reads. The automatic reset is
right to stop firing — the session is no longer *in* the merged state — but the explicit
`shipit branch reset-to-base` reads the same clauses, so the same clear made every
re-armed session **force-only forever**: it could never satisfy the gate again no matter
what its branch looked like, and it refused naming a clause about unshipped work when the
real one was `not-merged`. So `PreviousMergedPr` now carries `mergedHeadSha` alongside
`baseBranch` (both re-arm paths copy it before the clear, `pr-rearm.ts`), and
`computeResetBlocker` falls back to the breadcrumb for the merged fact, the base, and the
anchor. The merged **state** is gone after a re-arm; the merged **fact** is not. The
breadcrumb copy is still the SHA GitHub merged — never refreshed from local HEAD, for the
reason above. Commit `84f866b8` made the base lookup durable for exactly this population
and left the gate reading the cleared columns; this finishes it.

### Recovery / data-loss posture

No explicit recovery ref. A merged change *is* the permanent record; the branch's
prior state is a duplicate of what's already in `main`, so there is no use case for
recovering it. Whatever git keeps for free suffices — the dropped commits remain in
the clone's reflog (`HEAD@{1}`). (The clean-tree clause covers the one genuinely
unrecoverable case: uncommitted edits.)

> **Superseded — we now DO heal the remote at reset time.** The original posture
> additionally leaned on "the dropped commits usually survive on the still-present
> remote branch" and therefore "we do not force-push at reset." That left the
> *local* branch reset to `origin/<base>` while the *remote* branch
> (`origin/<session-branch>`) still pointed at the old merged commits — a
> divergence. Because the ordinary debounced auto-push (`scheduleAutoPush` → plain
> `git push`) is non-force, every subsequent commit's push became a
> **silently-dropped non-fast-forward** until the PR-create path (the only
> force-pushing path) happened to heal it. So the reset now force-pushes the
> branch (`forcePush` → live-tip `--force-with-lease`) immediately after the
> `reset --hard`, healing the remote so later pushes fast-forward. The reflog
> (`HEAD@{1}`) remains the recovery source; the lease refuses to clobber a remote
> that moved unexpectedly (false-merge guard preserved). See the heal block in
> `pre-turn-reset.ts`.

**Known limitation of the heal — it is local-side proof only.** Every clause of the
gate reasons about the LOCAL branch; the heal then force-pushes. `forcePush` leases
against the tip it reads from the remote at that moment, so a commit that exists
only on the remote is treated as the expected tip and overwritten rather than
refused. This is a property of the heal as designed (the whole point is to clobber
a remote still holding the merged commits), and it predates the containment clause —
but that clause makes it reachable for off-anchor branches too, so state it rather
than leave it implicit. It is bounded by how a session branch is written: only this
clone's auto-push and the PR-create force-push write it, so "remote-only work" means
the local clone was rewound while the remote kept a commit — which is recoverable
from the local reflog. Cross-agent review (Codex) raised it; the fix considered and
rejected for now was gating the heal on the remote tip being absent / equal to the
merged anchor / itself contained in the base, because a refusal at that point is too
late (the local reset has already happened) and moving the check earlier costs a
network round-trip on every reset to cover a state nothing in ShipIt produces.

## The two messaging surfaces

The reset speaks to two audiences over two channels.

**(a) Agent — per-turn prompt prefix (not shown to the user).** Prepended to the
prompt string (`assembleAgentPrompt(...)`), this turn only:

```
[System] Your previous pull request (#<N>) was merged into <base>. This branch
has been automatically reset to the latest origin/<base> — it no longer contains
the merged commits and starts from current code. Build the requested work on top
of this fresh base; do not re-apply or recreate anything from the merged PR.
```

The last sentence is load-bearing: it stops the agent from recreating shipped work.
Rides the existing prompt-assembly path; no persistence.

**(b) User — a persisted "branch updated" card.** Emitted into the transcript right
after the user's message and before the agent's response (produced at continue-time,
just after the reset). Form: a small, quiet inline card on its own message row (the
`CARD_MESSAGE_FIELDS` / empty-text-message pattern), branch glyph, plus a concrete
`was <sha> → now <sha> (origin/<base>)` line for auditability:

> **Branch updated to latest `<base>`**
> Your previous PR #N merged, so this branch was automatically reset to the latest
> `<base>` before continuing.
> `was a1f3c9d → now 7e02b48 (origin/main)`

This is **transcript content, so it must be persisted, not emit-only** (CLAUDE.md
"Chat transcript content MUST be persisted"). It is a **side-channel card** (arrives
outside the agent-event stream), so follow the `emitChatCard` recipe (docs/188/191):
emit via `emitChatCard` (atomic emit + in-band record anchored by `afterGroupIndex`
+ persist in-progress turn); add a typed `PersistedMessage` field (e.g.
`branchAutoReset: { base, prNumber, prUrl, fromSha, toSha }`) + column +
`toRow`/`fromRow` + migration; rehydrate in `loadSessionHistory`; register in
`CARD_MESSAGE_FIELDS` (`visual-elements.ts`) + extend `EVERY_OPTIONAL_FIELD_MESSAGE`;
add history round-trip + no-duplicate-on-replay tests. The two guard tests
(`chat-history.test.ts`, `visual-elements.test.ts`) make this self-enforcing.

**Ordering contract.** The card must render *after* the user's message bubble. But
`executeAgentTurn` persists the resumed user row itself (via `persistUserMessage`,
inside `turn-executor.ts`), *after* `runAgentWithMessage` would call the pre-turn
helper — so naively emitting the card first persists it above the user row and it
reloads out of order. Fix: in `runAgentWithMessage`, **persist the user message row
before the reset**, then emit the card anchored after it (`emitChatCard`'s
`afterGroupIndex`), then run the turn (suppressing the executor's duplicate user-row
append). The reset git op still happens pre-turn so the agent works on the fresh base.

The card is the **user-facing signal of record** — it does **not** depend on the
docs/216 "ready" card (which is indirect, and in practice has not been firing
reliably). The composer control is transient (persists nothing); the card is the
durable record. Control = intent (before); card = record (after).

## Path coverage

**Every turn that starts, whichever transport starts it.**

The original scope was the interactive path only (`runAgentWithMessage` in
`agent-execution.ts`), on the reasoning that "a destructive reset underneath an
automated message is more surprising than helpful", with the note *"if we later
want programmatic continues to reset too, factor a shared helper then."*
**planning#333 did exactly that** — see "Phase 5" under As built. The wiring now lives
in `pre-turn-reset-hook.ts` (`applyPreTurnReset`) and both adapters call it:

- **Interactive** (`runAgentWithMessage`) — a typed message, and any **queued**
  user message (`drainNextQueuedMessage` recurses back through it).
- **Dispatched** (`runDispatchedTurn`) — an Agent Interface SDK message
  (docs/242), `shipit session message`, a notify-on-merge wake, a Create-PR
  button, and every queue drain on that side.

Nothing narrows by *who sent it*, because **the safety gate already is the
narrowing**: a CI-fix turn's session is not merged (`not-merged`), and a branch
carrying unshipped work fails `head-moved`. A second, caller-keyed gate could
only disagree with the first one.

The per-send tick box stays a composer concept: a dispatched turn passes no
intent, so it follows the global `autoResetMergedBranch` setting.

**Two exclusions, both about what the turn *is* rather than which transport
carried it:**

- **`/compact`** (interactive) — a maintenance command, not a continuation of
  work. See Edge cases.
- **`postTurn: "none"`** (dispatched) — a step *inside* a git operation the
  driver owns: docs/146's rebase-conflict resolution turn, which commits via
  `rebase --continue` and force-pushes once the flow ends. No reset could fire
  there (the tree is conflicted), but the planning#297 skip machinery would still
  persist "this branch still sits on the already-merged commits" and point the
  agent at `shipit branch reset-to-base` while its actual job is to edit the
  conflicted files. Note the clause it would report is **`dirty-tree`, not
  `rebase-in-progress`** — `computeResetBlocker` checks `isClean()` first, and a
  conflicted rebase has an unclean tree — so this exclusion is load-bearing
  rather than belt-and-braces.

## Composition with docs/202 / docs/216 — no new PR-card logic

After the reset, `HEAD == origin/<base>`. The turn runs. The **existing** post-turn
hooks then settle the PR card with no new code:

- Agent did **new work** → `advancedBeyondMergedBase` → `detectAndReArmMergedSession`
  (docs/202) → re-arm + **new PR**.
- Agent did **nothing committable** → `headIsAtBase` → `detectAndReArmResetSession`
  (docs/216) → re-arm + **clean "ready" card**.

This feature's net addition is the **pre-turn reset + the explicit control + the
agent prefix + the persisted user card**. The PR-card lifecycle (docs/202/216) is
treated as corroborating, not as the user-facing signal of record.

**A false docs/202 re-arm used to disable this feature (planning#240).** The composition
above runs in one direction, but there was a feedback edge in the other: docs/202's
detection reads `origin/<base>` from the session clone, which nothing on the merge
path fetches, and a stale base ref makes `advancedBeyondMergedBase` report progress
for a branch that never moved. So on a session where the reset did *not* fire (the
setting off, a per-send untick, no `mergedHeadSha`, a dirty tree, `/compact`), the
next committing turn falsely re-armed — and `clearMerged` drops `mergedHeadSha`,
which is this feature's load-bearing safety anchor. From then on
`computeResetEligible` was permanently false: no composer control, no auto-advance,
and a gray "ready" card showing the stale full-branch diff with a "Create PR"
button. The user-visible read was "the branch-advance feature doesn't work."
Fixed in docs/202 (`pr-rearm.ts#freshenBaseRef` + the `unmovedSinceMerge`
anchor short-circuit); see that plan's "The base ref must be current".

**Pre-turn PR-card re-arm (timing fix).** The post-turn `detectAndReArmResetSession`
above only settles the PR card *after* the whole agent turn finishes, so the stale
"merged" PR card lingered while the user already saw the branch-updated card — the
"separate bug to file" this section originally flagged. Fix: when the pre-turn reset
moves the branch (`reset.moved`), `agent-execution.ts` calls the **same**
`detectAndReArmResetSession` helper immediately (the branch is already at the clean
base, so `headIsAtBase` is true), flipping the PR card to the gray no-current-PR
"ready" state in lockstep with the branch-updated card. The post-turn call stays as a
fail-safe for the manual-`git reset` path and no-ops here (it has already cleared
`mergedAt`). No new PR-card logic — just an earlier invocation of the docs/216 helper.

## Edge cases

- **New work since merge** (`HEAD !== mergedHeadSha`): not eligible, no control, no
  reset; docs/202/216 own the card.
- **`mergedHeadSha` missing** (pre-feature session, evicted clone at merge, or a
  rate-limit false-merge): not eligible → skip. No silent data loss.
- **False merge positive:** the gate only resets a branch the user hasn't touched,
  and the reset is reflog-recoverable; we never force-push. Merged state is itself
  REST-confirmed by `verifyMissingPr`, so genuine false positives are narrow.
- **Dirty working tree:** not eligible → skip (don't hard-reset over uncommitted
  edits).
- **`origin/<base>` missing / fetch fails / workspace evicted:** fail safe → skip,
  run the turn normally. (The continue path rehydrates the clone before this hook.)
- **Stale client eligibility flag:** harmless — the server re-validates the full gate
  at send time, so the checkbox is intent only.
- **`/compact` on a merged, eligible session (docs/178):** a between-turns `/compact`
  routes through `runAgentWithMessage` with `compact: true`, which would otherwise
  reach this pre-turn reset. Compaction is a maintenance command, not a continuation
  of work — so the reset block is gated on `!opts.compact` and skipped for compaction
  requests. Without the guard the reset moved the branch to base **and** prepended the
  `[System] …PR was merged…` prefix to the `/compact` prompt, so the agent reacted to
  the merge notice instead of compacting. The reset still runs on the next real turn.

## Product-principle check

- **§5 agent-as-actor:** the user continues in chat and ticks/unticks a behavior
  toggle; ShipIt operates the box (fetch + reset). The control is a turn modulator
  (like permission mode), not a command-runner button.
- **§1/§2 inline:** nothing leaves ShipIt; the move and its explanation surface
  inline (the composer control before; the persisted card after).

## Key files

| Area | File | Change |
|---|---|---|
| Capture (source) | `src/server/orchestrator/github-auth-prs.ts` | Extend `findPullRequestAnyState` to return the PR's `head.sha` |
| Capture (persist) | `src/server/orchestrator/pr-status-poller.ts` | In `verifyMissingPr`, persist `mergedHeadSha = pr.head.sha` before the merge side effects; fail closed if absent |
| Persist | `src/server/shared/database.ts` | `merged_head_sha TEXT` column + migration |
| Persist | `src/server/orchestrator/sessions.ts` | `SessionRow.merged_head_sha` + `fromRow` parse + setter |
| Type | `src/server/shared/types/*` | `SessionInfo.mergedHeadSha?: string`; transient `resetEligible?: boolean` |
| Detection + action | `src/server/orchestrator/services/pre-turn-reset.ts` (new) | `autoResetMergedBranchOnContinue` — gate → fetch → re-gate → `reset --hard origin/<base>` → return `{ moved, base, prNumber, prUrl, fromSha, toSha }` + agent prefix; fail-safe |
| Eligibility | `src/server/orchestrator/services/pre-turn-reset.ts` + session/PR state plumbing | `computeResetEligible(session, git)` (safety-only); surface `resetEligible` on activation + post-turn |
| Git primitives | `src/server/shared/git.ts` | Reuse `getHeadHash`, `fetch`; add/confirm a `reset --hard origin/<base>` helper; `isClean()`, detached-HEAD / in-progress-sequencer checks for the repo-state clauses |
| Global setting | `src/server/orchestrator/credential-store.ts` (+ settings UI) | `getAutoResetMergedBranch()` (default on), sibling of `getAutoResolveConflicts`/`getAutoFixCi`; settings toggle |
| Pre-turn wiring | `src/server/orchestrator/ws-handlers/agent-execution.ts` | Call the helper between session-track and `executeAgentTurn`; prepend the prefix to `prompt`; honor the per-send override |
| Send payload | `ws-handlers/send-message.ts` + `ws-client-messages.ts` | `resetMergedBranch?: boolean` on the user message (the per-send intent) |
| Composer control | `src/client/components/` (composer) | Placement B control: shown iff `resetEligible`, checked from the global setting, per-send opt-out (non-sticky) |
| User card — emit | `src/server/orchestrator/chat-card-persistence.ts` | Emit the card via `emitChatCard` |
| User card — persist | `shared/types/*`, `chat-history.ts`, `session-data.ts`, `database.ts` | `branchAutoReset` `PersistedMessage` field + column + `toRow`/`fromRow` + migration; rehydrate in `loadSessionHistory` |
| User card — register | `visual-elements.ts` | Add to `CARD_MESSAGE_FIELDS`; extend `EVERY_OPTIONAL_FIELD_MESSAGE` |
| User card — render | `src/client/components/` (new card component) | Render "Branch updated to latest `<base>`" + `was → now` SHAs |
| Phase 9 — measure | `src/server/orchestrator/services/push-divergence.ts` (new) | `measurePushDivergence` (fetch → `aheadBehind` → `mergeBase` → name remote-only commits) + `formatDivergedPushNotice`, one recovery per shape |
| Phase 9 — measure | `src/server/shared/git.ts` | `commitSubjects(range, maxCount)` — the primitive that lets the notice NAME the at-risk commits |
| Phase 9 — report | `src/server/orchestrator/services/auto-push-scheduler.ts` | Measure at the rejection (once per episode, after the fast surfaces); `destructiveGitGuarded` dep so the notice never names a force-push the hook would block |
| Phase 9 — guidance | `src/server/orchestrator/prompts/pull-requests.md`, `shipit-docs/github.md`, `shipit-docs/sessions.md` | Check the branch's state before moving it; never a hand-rolled rebase/reset onto the base |
| Phase 9 — hook | `docker/agent-hooks/block-branch-ops.mjs` | `git rebase` joins the guard-armed destructive set; in-progress verbs exempt |

## Testing

- `sessions.test.ts` — `mergedHeadSha` round-trips (set at merge, read in `fromRow`).
- `pre-turn-reset.test.ts` (new) — gate matrix: non-merged → no-op; merged but
  `HEAD !== mergedHeadSha` → no-op; missing SHA / base → no-op; dirty tree → no-op;
  merged + eligible + checked → fetch + reset + returns move info & prefix; unticked
  → no-op; git throw → fail-safe no-op; `computeResetEligible` truth table.
- Integration — a continue turn on an eligible session resets the branch and the
  post-turn docs/216 hook settles the PR card; a continue with new commits leaves the
  branch alone (docs/202); the per-send override threads through.
- Card persistence — `chat-history.test.ts`: the card round-trips persist → reload
  and does not duplicate on turn-event replay; `visual-elements.test.ts`: the field
  is in `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE` (self-enforcing).
- Client — composer shows the control iff `resetEligible`, default-checked from the
  setting, opt-out non-sticky; the card renders.

## Visual reference

- `mockup.html` — the composer control (intent) + the persisted card (record).
- `mockup-control-placement.html` — placement options A–D; **B chosen**.

## Resolved decisions

- **Lazy on continue, not eager in the poller.** (Q "trigger")
- **`reset --hard origin/<base>`, not rebase.** (squash-safe; nothing to replay)
- **Safety gate is the persisted `mergedHeadSha` + clean tree + plain repo state**
  (not detached, no in-progress sequencer), not derived git state (which has a
  data-loss hole). Re-validated after the fetch (TOCTOU).
- **`mergedHeadSha` is the PR's `head.sha`, captured in `verifyMissingPr`** — not
  local HEAD (which can advance to unmerged work in the merge-vs-detection window).
  Fail closed if absent (no SHA → no auto-reset).
- ~~**Interactive path only.**~~ **Superseded by planning#333** — every turn, whichever
  transport starts it, with one exclusion (`postTurn: "none"`, a step inside the
  driver's own git operation). See "Path coverage".
- **No recovery ref** — a merged change is the permanent record; the reflog covers
  recovery; clean-tree clause covers the unrecoverable (uncommitted) case.
- **Heal the remote at reset (force-with-lease).** Supersedes the original "never
  force-push at reset" decision: leaving the remote branch diverged from the reset
  local branch turned every later plain auto-push into a silently-dropped
  non-fast-forward. The reset now force-pushes (live-tip lease) right after the
  `reset --hard`. See the superseded note under "Recovery / data-loss posture".
- **Explicit composer control (placement B) + global default setting**, checked by
  default, per-send opt-out that doesn't persist.
- **Persisted transcript card is the user-facing signal of record**, independent of
  docs/216.

## Open questions

_None — see "Resolved decisions". The docs/216 card's reliability is tracked
separately if observation confirms it's broken._

## As built

**Phase 1 (PR #1565, merged).** `findPullRequestAnyState` → `head_sha`; `merged_head_sha`
column + `SessionInfo.mergedHeadSha` + `setMergedHeadSha` setter; captured in
`verifyMissingPr` before the merge side effects, fail-closed when absent; cleared in
`clearMerged` on a docs/202 re-arm.

**Phase 2 — card-ordering divergence (principled).** The plan prescribed "persist the
user row *before* the reset, then `emitChatCard`, then run the turn (suppressing the
executor's duplicate user-row append)." That can't work as written: `executeAgentTurn`
calls `resetRunnerTurnState` at turn start, which **clears `recordedCards`** — so a
card recorded by an `emitChatCard` in `runAgentWithMessage` (before the executor runs)
would be wiped, and it would also miss the fresh turn's reconnect buffer. Instead: the
**git reset** happens pre-turn in `runAgentWithMessage` (so the agent works on the
fresh base, and the prompt prefix is prepended there), but the **card emit** is
deferred into the executor via a new `TurnInput.afterUserMessagePersisted` hook, fired
once immediately after the resumed user row is persisted (post `resetRunnerTurnState`).
Net transcript order is identical to the design — user bubble → branch-updated card →
agent response — and the card rides the fresh turn's `recordedCards`/buffer correctly
(survives reconnect + reload). No user-row suppression was needed.

**Phase 2 — setting source.** `SessionInfo` doesn't carry `prStatus` (it's poller-owned
live state), so the helper reads the merged PR's base/number/url from a new
`SessionManager.getPrStatus(id)` that parses the persisted `pr_status` snapshot
(survives a container restart). The global toggle is `credentialStore
.getAutoResetMergedBranch()`, **default OFF in Phase 2** (the mechanism ships dark);
Phase 3 flips it ON and adds the composer control + settings UI.

**Phase 2 — checkpoint deferred.** The checklist's "enable the setting and observe a
live reset + card" checkpoint needs a way to toggle `autoResetMergedBranch`, which only
arrives with Phase 3's settings UI. Phase 2 is verified by unit + git-fixture tests
(`pre-turn-reset.test.ts`, `git-rearm-detect.test.ts`, the card round-trip/idempotency
tests); the live end-to-end observation folds into Phase 3.

**Phase 3 — `resetEligible` is a standalone WS signal, NOT a poller field.** The plan's
"Eligibility signal" section imagined surfacing `resetEligible` on the PR status
payload. In practice the poller deliberately **excludes merged sessions** from its
broadcast flows (`broadcastAllSnapshots` skips `mergedSessions`), and `attachAutomationState`
is synchronous on the poll path — so computing a git-derived boolean there would mean an
async refactor of the poll loop AND fighting the merged-session exclusion. Instead the
signal is a dedicated transient WS message (`reset_eligible`), computed by `isResetEligible`
(safety-only) and pushed at three points: **session activation**
(`route-registry.ts`, mirroring the existing `pr_notable_files` git-derived re-seed),
**post-turn** (the `postTurnReArmReset` every-turn closure), and **merge detection while the
user is viewing the session** (the poller's `onMergeDetectedCb` in `app-lifecycle.ts`, via
`emitResetEligibleSignal`). The third point closes a gap: a PR that merges while the user
sits ON the session — never re-activating it and never taking a turn — sets `mergedAt` +
`mergedHeadSha` but would otherwise leave the composer control hidden until a switch-away-and-
back, because only activation and post-turn recomputed. The merge callback now recomputes and
pushes the signal to the attached runner's viewers (skipped when no live runner — activation
covers reattach). Client stores it in `pr-store.resetEligibleBySession`; the composer ANDs it
with the `autoResetMergedBranch` setting. Transient, never persisted — recomputed on each
(re)connect, so it self-heals.

**Phase 3 — per-send intent.** `WsSendMessage.resetMergedBranch` (`false` = unticked →
skip; `true`/absent = follow the setting) threads `send-message.ts` → `runAgentWithMessage`
→ `autoResetMergedBranchOnContinue`'s new `intent` arg. The composer carries it only when
the control was visible at send time; the server still re-validates the full safety gate,
so the checkbox is intent, never authority.

**Hide the control the moment the reset runs (not post-turn).** The `reset_eligible` signal
is recomputed + pushed *post-turn*, so after a reset-bound send the control would stay visible
for the **entire turn** (often long) until that recompute fired — visibly wrong, since the
"Branch updated to latest base" card already shows the reset happened. Two complementary
fixes, mirroring how docs/216 re-arms the PR card "NOW" rather than lagging until post-turn:

1. **Server (authoritative, all send paths).** Right after `autoResetMergedBranchOnContinue`
   returns `moved: true` and `detectAndReArmResetSession` runs (`agent-execution.ts`), the
   branch sits at the fresh base (`HEAD !== mergedHeadSha`), so eligibility is definitively
   false — the handler emits `reset_eligible: false` immediately. This covers **every** send
   path (composer, propose-action buttons, programmatic follow-ups), independent of turn
   length. The post-turn recompute stays as the fail-safe (manual `git reset` with no pre-turn
   move) and reconciles an unticked send back to eligible.
2. **Client (optimistic, composer path).** `handleSubmit` (`MessageInput.tsx`) also clears the
   signal (`setResetEligible(sessionId, false)`) on a *checked* send, so the control vanishes
   on click without even a WS round-trip. An *unticked* send leaves it intact (no reset runs).
   Covered by the "optimistically clears / keeps eligibility" tests in `MessageInput.test.tsx`.

**Phase 3 — default flipped ON.** `credentialStore.getAutoResetMergedBranch()` now defaults
`?? true`; the client settings store, `GlobalSettings`, and the bootstrap fallback default
true to match. A flipped toggle takes effect on the next activation/turn (the signal is
recomputed there) — no immediate global re-broadcast, deliberately (unlike `autoFixCi`,
which has a per-session poll snapshot to refresh; this one doesn't).

**Phase 4 — remote heal at reset (dropped-push fix).** Field report: after a
merge → auto-reset → new PR, a later commit was silently not pushed. Root cause: the
reset moved only the local branch; the session's remote branch survived the merge
(auto-delete off, or ShipIt's best-effort delete — which runs in the *bare cache*
clone, not the session clone — failed) pointing at the old merged commits, so local
and remote diverged. The PR-create path force-pushes through divergence
(`agentCreatePr`/`quickCreatePr`, `git.forcePush`), which is why the *PR* appeared;
but the ordinary debounced auto-push (`scheduleAutoPush` → plain `git push`) is
non-force, so any commit pushed via that path landed as a non-fast-forward rejection
(`git_push_rejected`) and stayed local with no retry. Fix: `autoResetMergedBranchOnContinue`
now calls `git.forcePush("origin")` immediately after `resetHardToRemoteBase`, healing
the remote so subsequent plain auto-pushes fast-forward. `forcePush` leases against the
remote's **live** tip via `ls-remote` (not the stale local tracking ref the session
clone never pruned), so both "deleted at merge" (create) and "surviving + diverged"
(lease) resolve; best-effort (a lease rejection / error leaves the pre-fix divergence
rather than throwing — the reset still stands and the turn runs). This reverses the
"never force-push at reset" decision (see the superseded note above). Tests in
`pre-turn-reset.test.ts` (heal called on success; best-effort on failure).

**planning#297 — a skipped reset is no longer silent, and a merged session no longer
silently auto-pushes.** Two halves of one user-facing failure ("my session's PR
merged and nothing said so"), from a production incident where a turn ran two
minutes after the merge, the reset did not fire, and the post-turn auto-push
*recreated* the branch GitHub had deleted — leaving an orphan commit that belonged
to no PR. The user worked it out themselves ("Pr was actually already merged");
the second time they had reported "changes are missing from the merged PR".

- **The skip reports its clause.** `computeResetEligible` is now a thin wrapper
  over `computeResetBlocker`, which returns *which* clause refused instead of a
  bare boolean — one implementation, so the explanation can't drift from the
  gate. On a **merged** session, `autoResetMergedBranchOnContinue` turns that
  clause into three surfaces: a `[pre-turn-reset] skipped for <id> (<clause>)`
  log line (so the next ops investigation greps one line instead of proving a
  negative by diffing two sessions' logs), a **persisted** transcript notice via
  `emitNoticeInTurn` on the existing `afterUserMessagePersisted` hook (same
  anchor as the branch-updated card), and an agent prompt prefix (the agent was
  as unaware as the user — it went on to author a commit for a dead PR).
  Non-merged sessions stay silent: nothing to reset, nothing to say. Safety
  clauses report at `warn`; the two deliberate opt-outs (global setting off,
  per-send untick) at `info` — which narrows this plan's "a global opt-out means
  we don't nag" to what it should always have meant: hide the *control*, not the
  fact that a merged branch is stale.
- **No clause was weakened.** The incident's blocker was almost certainly
  `git.isClean()` — a dirty tree at 16:33:58 — and that refusal is correct: a
  `reset --hard` over uncommitted edits is the one irreversible loss. The bug was
  the silence, not the refusal.
- **The merged-branch push guard** (`services/merged-push-guard.ts`, wired into
  `postTurnCommit`) refuses the *silent debounced* auto-push while the session is
  merged and the commit is stacked on the merged tip. The commit still happens
  (work is never lost, and stays reflog-recoverable); only the push is refused,
  with a persisted notice naming the merged PR and the two recovery routes. An
  explicit `gh pr create` is unaffected — it force-pushes through its own path,
  the same carve-out the ops-session gate makes. The `mergedHeadSha`-ancestry
  test is what keeps it precise: a branch rebased onto the fresh base (the flow
  ShipIt's own agent instructions prescribe after a merge) still has `mergedAt`
  set at commit time, because the docs/202 re-arm that clears it runs *after* —
  so gating on `mergedAt` alone would have blocked and mis-explained a
  legitimate pre-PR push.

**Phase 5 (planning#333) — programmatic messages continue on the fresh base too, and
the card is unconditional.** The Agent Interface SDK (docs/242) turns a click
inside a page the agent built into a real agent turn — dispatched, not typed. It
therefore reached `runDispatchedTurn`, which had none of this feature's wiring,
so on a merged session the turn ran on a branch still sitting on already-shipped
commits with no prefix and no card. Two changes:

- **The wiring is shared.** `pre-turn-reset-hook.ts#applyPreTurnReset` holds
  everything that used to be inline in `agent-execution.ts` — the reset call, the
  branch-updated card, the planning#297 skip notice, the docs/216 re-arm, and the
  `reset_eligible: false` push. `runAgentWithMessage` calls it directly;
  `runDispatchedTurn` calls it through the optional `SystemTurnDeps.preTurnReset`
  dep (wired in `runner-registry-factory.ts`, the same lazy-poller shape
  `postTurnReArmReset` uses). One implementation, so the transports cannot drift
  — which is the same reason the gate itself was collapsed into one function in
  planning#297.
- **The record has two triggers, latched.** The card is delivered at its
  transcript anchor (`afterUserMessagePersisted`), *or*, if the turn dies before
  it reaches that anchor — an admission refusal, a spawn failure, a throw in env
  prep — by `ensureRecorded` from the caller's `finally`. Whichever runs first
  latches; the other is a no-op. A branch that moved always leaves evidence,
  because the card is the only durable record that a destructive move happened
  at all.

On the dispatch side the hook runs **once per message**, outside the no-result
retry loop, so a retried turn neither re-resets nor duplicates the card.

Three things the cross-agent review (Codex) caught, each a way the "always
recorded" guarantee was still hollow:

- **Post-reset bookkeeping must not reject.** The branch is already moved and
  force-pushed by the time the docs/216 re-arm runs, and that re-arm catches only
  its own git checks — `clearMerged` / `reArm` / SSE / emit can still throw. The
  throw propagated out of `applyPreTurnReset`, *past* both callers'
  `try/finally` (which are established only after it returns), aborting the turn
  and destroying the delivery callbacks with it. Now wrapped: the PR card and the
  composer control are self-healing post-turn; the transcript record is not.
- **The latch closes on success, not on attempt.** `emitChatCard` emits *before*
  it records or persists, so a throwing WS listener consumed the only delivery
  and left the card in neither `recordedCards` nor durable history — the
  emit-only failure class CLAUDE.md prohibits — while `ensureRecorded` no-opped
  on an already-flipped latch. A failed attempt now leaves the latch open for the
  fallback's direct append.
- **The dispatched post-turn path never recomputed `reset_eligible`.** Only a
  turn that *moved* the branch emitted `false`, so a dispatched turn that skipped
  the reset and then committed left an activation-time `eligible: true` standing,
  and the composer kept offering a reset the server would refuse.
  `runner-registry-factory.ts`'s `postTurnReArmReset` now recomputes and pushes
  the signal, matching what the WS adapter already did.

### Phase 8 — planning#341: the eligibility signal stops going stale, and the refusal names the files

An Ops investigation into a refused reset. A session whose PR had merged; an
agent-built preview compose service mounted the workspace read-write, wrote two
tracked files when the user clicked Approve in that page, and then called
`window.shipit.agent.sendMessage()`. The user saw the composer's "start from the
latest base" checkbox, sent, and got "Branch not updated to the latest base."

Two visibility defects, no change to the gate. **The refusal itself was correct** —
a hard reset would have destroyed the uncommitted edit — and no clause of
{@link computeResetBlocker} was touched. That a write-then-send action can never
satisfy the clean-tree gate on a merged session is a real product limit (ShipIt
deliberately never stashes on auto-paths, docs/146), not something this phase
tries to fix.

- **The `reset_eligible` signal is recomputed when the workspace changes.** It
  was computed at exactly three moments — WS activation, post-turn, merge
  detection — and never in between, so anything that dirtied the tree of a
  merged, untouched session left the client holding a `true` the server would no
  longer honour: the UI painted a control for an operation the pre-turn gate then
  refused with `dirty-tree`. The things that dirty a tree between turns are not
  things a user thinks of as work (a terminal command, a compose service writing
  to the mounted workspace, a dev server materialising a generated file), and
  none of them ends a turn. New `reset-eligible-watch.ts` wires a debounced
  recompute onto the runner's existing `files_changed` stream, from
  `onRunnerCreated`.
- **Why the watcher rather than re-validating at send time.** The server already
  re-validates at send time — `autoResetMergedBranchOnContinue` evaluates the full
  gate twice and, since planning#297, reports the clause that refused. A second,
  client-driven pre-send check would be a round trip that changes nothing about
  correctness and still leaves the control painted for as long as the user looks
  at it before sending. The defect is that the *painted* control outlives the fact
  it depicts, so the fix belongs where the fact changes.
- **Three gates keep a chatty watcher cheap**, since `isResetEligible` shells out
  to git: it only recomputes for sessions with a merged pull request (the signal
  is a constant `false` for everything else); it collapses a burst into one
  recompute (750 ms); and it skips while a turn is running, because the agent
  rewrites files continuously and the post-turn recompute fires immediately
  afterwards anyway.
- **The debounce is capped at 5 s, because a trailing edge alone starves.** Every
  `files_changed` replaces the pending timer, so a writer producing changes more
  often than the window postpones the recompute forever and the control stays
  stale indefinitely — this module's own failure mode, reintroduced by its
  optimisation. Not hypothetical: the worker's file watcher already collapses
  events on a 300 ms trailing debounce, so anything writing on a 300–750 ms
  cadence emits a stream that never leaves a quiet window. The recompute now
  fires at the latest 5 s after the *first* change of a run.
- **No emitter deduplicates a push against a value it remembers privately.** A
  watcher-local "I already said `false`" check was written and deleted: the
  client holds ONE value per session and takes whichever message arrived last, so
  a private check reasons about state the unconditional emitters may have
  overwritten since. Concretely — watcher says `false`; a turn runs and its
  post-turn emitter says `true`; a service dirties the tree; the watcher computes
  `false`, matches its own remembered `false`, and suppresses the only message
  that would have corrected the client. The saving was one WS message and one log
  line, never the git work — the comparison could only happen after the recompute.
- **The `dirty-tree` refusal names the files.** "The working tree has uncommitted
  changes" is unactionable when you did not knowingly change anything — in the
  incident the writer was a compose service, not the user. `computeResetBlocker`
  now appends the paths from the existing `GitManager.uncommittedPaths()` to the
  clause's `detail`, capped at 10 with a `+N more` count and sorted for stability.
  `detail` is the single string every skip surface is built from, so this reaches
  the `console.warn`, the persisted transcript notice and the agent prompt prefix
  at once. Fail-safe (a throw degrades to the bare sentence rather than losing the
  refusal) and charged only to the refusal path — the healthy path never makes the
  second `git status` call.
- **`reset_eligible` is logged, with its origin and its reason.** The
  investigation could not distinguish "the client held a stale `true`" from "the
  tree became dirty later", because neither the emitted value nor its reason was
  recorded anywhere. The four recompute sites now go through one
  `emitResetEligible` helper that logs `reset_eligible=<value> for <id> (<origin>)`
  plus the refusing clause and detail — merged sessions only, so a fleet-wide
  constant `false` cannot bury the interesting lines. A git failure is logged as
  such rather than collapsing into an unexplained `false`: `computeResetEligibility`
  keeps the `merged` flag it learned before the throw and carries the error, so the
  one case the log exists to disambiguate cannot itself go dark.
- **Cross-agent review (Codex) — three signal-correctness bugs, all fixed:** the
  watcher-local dedupe described above (which could wedge a client at the opposite
  value); the starving trailing-edge debounce; and a change that landed *during* an
  in-flight recompute being dropped — the in-flight result was read from a tree
  predating it, and nothing was scheduled to correct it, so the watcher now
  re-runs once the in-flight one settles. Also from that review: a git throw no
  longer erases its own log line, and the wiring hands back the one
  max-listener slot its permanent `message` listener consumes (each attached
  viewer registers up to two, so without it a five-viewer session starts printing
  a `MaxListenersExceededWarning` that reads like a leak). Accepted as a known
  cost: a dirty merged session runs two `git status` calls per recompute
  (`isClean()` then `uncommittedPaths()`). Deriving cleanliness from the path list
  would collapse them into one, but that changes what the *gate* means by clean,
  and this phase does not touch the gate.

### Phase 9 — continuing after the reset: the guidance that undid it, and a notice that measures

The 2026-08-30 incident (session e48417b0). Everything this feature owns worked:
the pre-turn reset moved the branch to the fresh base, the heal force-push
re-created the remote, and `detectAndReArmResetSession` cleared the merged state
so the destructive-git guard disarmed for later turns. A later turn then
committed and pushed one commit that belonged to no pull request. Inside the
container, the agent rebased — and the branch LOST that already-published
commit. Every auto-push after it was rejected as non-fast-forward, for 23 hours,
leaving the session with no pull request, no diff, and its only work sitting on
the remote.

Two defects, neither in the reset itself.

- **The agent instructions still described the pre-reset world.**
  `prompts/pull-requests.md` told the agent, unconditionally, to
  `git fetch origin && git rebase origin/<base>` before opening a follow-up PR.
  That was right when the branch sat at the merged tip and nothing moved it; once
  *this* feature became the common path it is wrong (the branch is already on the
  base), and once a commit has been pushed it is actively harmful — a rebase then
  rewrites published history with no `--force-with-lease` to finish it. The
  paragraph now says to LOOK first (`git status -sb`, `git log`) and branches on
  what it finds: already on the base ⇒ just commit; still at the merged tip ⇒
  `shipit branch reset-to-base`; commits made after the merge ⇒ stop and ask the
  user. It matches CLAUDE.md post-turn invariant 4 instead of contradicting it.
  The same correction landed in the agent-facing copies
  (`shipit-docs/github.md`, `shipit-docs/sessions.md`).
- **The rejection notice guessed the shape instead of measuring it.**
  `services/auto-push-scheduler.ts` emitted a fixed three-case menu that opened
  with "the commit is safe in this session's local history" and emphasised
  `shipit branch reset-to-base --force`. In this incident there *was* no local
  commit, and that command — which resets to the base and force-pushes the heal —
  would have deleted the one commit that existed anywhere. `services/push-divergence.ts`
  now measures at the moment of the rejection (fetch the branch, count both sides
  of the symmetric difference, check the merge base, name the remote-only
  commits) and the notice states what it measured and names the ONE recovery that
  fits. The rule that ShipIt never force-pushes on its own is untouched — the
  defect was the report, not the refusal.

`git rebase` also joined the hook's destructive set
(`docker/agent-hooks/block-branch-ops.mjs`, docs/130), armed by the same
`SHIPIT_GUARD_DESTRUCTIVE_GIT=1` as its siblings and exempting the in-progress
verbs. That does not cover this incident — the guard was already disarmed by the
re-arm above — but it closes the gap where the one rewrite ShipIt's own docs
forbid in that window was also the only one the hook did not mention. A broader
block was rejected: a rebase is legitimate nearly always, and deciding otherwise
would mean shelling out to git from a PreToolUse hook to compare the branch with
its own remote.

## Review notes

Reviewed by Codex (cross-agent). Accepted: PR-head-SHA capture instead of local HEAD
(data-loss hole); merge the persisted card into the reset-mechanism phase (no silent
destructive op); repo-state gate clauses (detached HEAD, in-progress sequencer);
revalidate-after-fetch sequence; card-ordering contract (user row before card);
`resetEligible` is safety-only; queued user messages are interactive. Declined: an
explicit recovery ref (a merged change is the permanent record — product decision;
reflog + remote are the accepted fallback).
