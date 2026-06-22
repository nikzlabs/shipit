---
issue: https://linear.app/shipit-ai/issue/SHI-189
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

> session merged **AND** `mergedHeadSha` recorded **AND** `HEAD === mergedHeadSha`
> **AND** working tree clean **AND** HEAD is on `session.branch` (not detached)
> **AND** no rebase/merge/cherry-pick/revert in progress
> **AND** the user did not untick the control.

- **`HEAD === mergedHeadSha`** is the load-bearing clause. The tempting "derive it
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

### Recovery / data-loss posture

No explicit recovery ref. A merged change *is* the permanent record; the branch's
prior state is a duplicate of what's already in `main`, so there is no use case for
recovering it. Whatever git keeps for free suffices — the dropped commits remain in
the clone's reflog (`HEAD@{1}`) and usually on the still-present remote branch — and
we do not force-push at reset time. (The clean-tree clause covers the one genuinely
unrecoverable case: uncommitted edits.)

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

**Interactive path only** (`runAgentWithMessage` in `agent-execution.ts`). A human
resuming is the real signal. **Queued user messages count as interactive** —
`drainNextQueuedMessage` recurses back into `runAgentWithMessage`, so a message
queued before the merge was detected still flows through this hook (and the gate
re-validates, so the first eligible message resets and the rest run on the moved,
no-longer-eligible branch). System/dispatch turns (CI auto-fix never runs on a merged
PR; programmatic `shipit session message` is niche) are out of scope — a destructive
reset underneath an automated message is more surprising than helpful. If we later
want programmatic continues to reset too, factor a shared helper then. Documented here
as a deliberate scope boundary (unlike docs/202/216, which wire both paths because
their detection is cheap and idempotent; ours is a destructive action).

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
- **Interactive path only.**
- **No recovery ref** — a merged change is the permanent record; reflog + remote
  branch suffice; clean-tree clause covers the unrecoverable (uncommitted) case.
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
(safety-only) and pushed at exactly the two points the design names: **session activation**
(`route-registry.ts`, mirroring the existing `pr_notable_files` git-derived re-seed) and
**post-turn** (the `postTurnReArmReset` every-turn closure). Client stores it in
`pr-store.resetEligibleBySession`; the composer ANDs it with the `autoResetMergedBranch`
setting. Transient, never persisted — recomputed on each (re)connect, so it self-heals.

**Phase 3 — per-send intent.** `WsSendMessage.resetMergedBranch` (`false` = unticked →
skip; `true`/absent = follow the setting) threads `send-message.ts` → `runAgentWithMessage`
→ `autoResetMergedBranchOnContinue`'s new `intent` arg. The composer carries it only when
the control was visible at send time; the server still re-validates the full safety gate,
so the checkbox is intent, never authority.

**Phase 3 — default flipped ON.** `credentialStore.getAutoResetMergedBranch()` now defaults
`?? true`; the client settings store, `GlobalSettings`, and the bootstrap fallback default
true to match. A flipped toggle takes effect on the next activation/turn (the signal is
recomputed there) — no immediate global re-broadcast, deliberately (unlike `autoFixCi`,
which has a per-session poll snapshot to refresh; this one doesn't).

## Review notes

Reviewed by Codex (cross-agent). Accepted: PR-head-SHA capture instead of local HEAD
(data-loss hole); merge the persisted card into the reset-mechanism phase (no silent
destructive op); repo-state gate clauses (detached HEAD, in-progress sequencer);
revalidate-after-fetch sequence; card-ordering contract (user row before card);
`resetEligible` is safety-only; queued user messages are interactive. Declined: an
explicit recovery ref (a merged change is the permanent record — product decision;
reflog + remote are the accepted fallback).
