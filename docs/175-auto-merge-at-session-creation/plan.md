---
description: Expose a per-session, never-persisted auto-merge toggle in the quick-capture overlay so trivial tasks can be armed to merge-on-green at creation, without reopening the session.
---

# Auto-merge at session creation

## Goal

Let the user arm auto-merge for a new session **at the moment they create it** —
in the quick-capture overlay (docs/145) where they type the prompt and pick the
repo — instead of having to come back to the session later and flip the toggle on
the PR card. For small tasks the user already trusts the agent to handle
("rename this prop everywhere", "bump the dep", "fix this typo"), this collapses
the whole loop to: type prompt → check "auto-merge" → forget about it → it lands
on `main` when CI is green.

The distraction this removes is the *return trip*: opening the session later just
to arm a toggle or merge by hand, which is exactly the context-switch the
quick-capture overlay was built to avoid in the first place.

## Why it fits

This is squarely §1/§5 in `CLAUDE.md`: the user **declares intent at the input
surface** and the agent + existing automation carry it out. It adds no
shell-shaped affordance — it's one checkbox next to the prompt, semantically
identical to the model/agent pickers already in the overlay. The user is not
operating the box; they're stating "ship this one when it's green."

## This is a new entry point, not new machinery

The capability to have auto-merge **armed before a PR exists** already ships.
Per docs/156 and docs/169, and as reaffirmed by PR #1054, the Session-actions
overflow exposes the auto-merge toggle in the pre-PR phase (gated on
`canAutoMerge`). When the agent's first turn opens a PR, `PrStatusPoller` /
`AutoMergeManager` (docs/077) pick up the already-armed state and merge on green
— GitHub-native or managed fallback, transparently.

So **the application path is done.** What's missing is only an *earlier entry
point* into that same armed state — one that lives in the overlay so the user
never has to mount the session view at all. Concretely: thread a boolean from
the overlay through `createHeadlessSession` and, after the session is claimed,
seed the same per-session auto-merge state the overflow toggle would have set.

> **Sequencing:** implementation waits until PR #1054
> ("Surface the auto-merge toggle inline on the PR card; drop the redundant
> status line") merges, to avoid conflicts in `PrLifecycleCard.tsx` and the
> overflow-gating logic this feature builds on. #1054 establishes the
> "inline for an open PR, overflow otherwise (incl. pre-PR)" placement — the
> overlay becomes a third surface that seeds the *same* armed state, never a
> fourth merge code path.

## Two load-bearing decisions

These are the only things a reader can't recover from the diff. Everything else
is mechanical.

### 1. Per-session, never persisted, never remembered

The toggle defaults **off** and the user must opt in **every single time**. We
deliberately do **not**:

- persist it to the session row / `SessionInfo`, and
- remember the last choice in `localStorage` the way the model and agent pickers
  do.

**Why:** a sticky "auto-merge" is a footgun. The model/agent pickers are safe to
remember because a wrong guess is visible and cheap to change. A remembered
auto-merge is invisible and **irreversible** — it would silently ship a PR the
user actually meant to review, simply because they armed it on some unrelated
task last week. Forcing an explicit per-session opt-in keeps the default
("PRs are for review") intact and makes arming a conscious act tied to *this*
task's triviality.

> **Rejected alternative — remember in `localStorage` like model/agent.**
> Considered for consistency with the other overlay controls and rejected on
> purpose. Convenience here trades against accidental merges of review-intended
> PRs, which is the worse failure. If a future change proposes "make auto-merge
> sticky," that change is wrong unless it also solves the silent-accidental-merge
> problem — re-read this section before implementing it.

This also means the feature stays consistent with auto-merge's existing nature:
`AutoMergeManager` state is already per-session and in-memory/ephemeral
(docs/077). We are not introducing persistence anywhere — the overlay boolean is
consumed once at creation and then lives only as the normal ephemeral armed
state.

### 2. Green CI is the only safety net — be honest about it

Arming at creation is sharper than arming mid-session: today the user toggles
auto-merge *after* seeing the agent's work; here they're trusting code they
haven't read at all. The only thing between a bad turn and `main` is the CI gate
in `AutoMergeManager` (`checks.state === "success"` + mergeable + approvals).

That's an acceptable bet for trivial tasks **only when CI is real**. The danger
case is the managed-merge fallback (docs/077) on a repo with **no required
checks**: `checks.state` can be `"none"`, which counts as passing, so a managed
merge could land with effectively zero gating.

**Open question (resolve during implementation):** should the creation-time
toggle be *disabled / hidden* unless the repo has required checks, while the
mid-session PR-card toggle keeps its current behavior? Leaning yes — the
asymmetry is justified because at creation the user hasn't seen anything, so the
"no gate at all" case is strictly worse than mid-session. Needs a cheap way to
know whether the repo has required checks at overlay time (we may not have it
without an API round-trip; if so, fall back to arming + a clear "no CI gate on
this repo" warning on the session/PR card rather than blocking).

## Data flow

```
QuickCaptureOverlay.tsx        ← new checkbox, default off, NOT persisted
  └─ createHeadlessSession()   (session-actions.ts) ← add armAutoMerge?: boolean
       └─ POST /api/sessions/headless                ← new optional field
            └─ CreateHeadlessSessionOptions          (headless-sessions.ts)
                 └─ after claim/graduate: seed the per-session auto-merge
                    armed state via the SAME path the pre-PR overflow toggle
                    uses (services/github.ts toggleAutoMerge / the poller's
                    AutoMergeManager), so the PR-creation handoff is unchanged.
```

No DB column, no `SessionInfo` field, no migration — the boolean is transient by
design (decision #1).

## Key files

| File | Change |
|------|--------|
| `src/client/components/QuickCaptureOverlay.tsx` | New auto-merge checkbox in the overlay form; default off; **not** wired to `localStorage`. Gating per the §"open question". |
| `src/client/stores/actions/session-actions.ts` | `createHeadlessSession()` carries an optional `armAutoMerge` flag into the request. |
| `src/server/orchestrator/api-routes-session.ts` | `POST /api/sessions/headless` accepts the optional flag (validate as boolean). |
| `src/server/orchestrator/services/headless-sessions.ts` | `CreateHeadlessSessionOptions` gains the flag; after the session is claimed/graduated, seed the per-session armed auto-merge state. |
| `src/server/orchestrator/services/github.ts` / `auto-merge-manager.ts` / `pr-status-poller.ts` | **Reused as-is** — the seed calls the existing toggle/arm path; no new merge logic. |
| `src/client/components/PrLifecycleCard.tsx` | **Touched only if** the §"open question" warning ("no CI gate on this repo") needs surfacing. Coordinate with PR #1054's placement. |

## Relationship to other docs

- **docs/077-managed-auto-merge** — the merge machinery this reuses; source of
  the managed-fallback / `checks.state === "none"` risk in decision #2.
- **docs/145-quick-capture-overlay** — the surface that gains the toggle.
- **docs/156 / docs/169** — established the pre-PR armed state and the
  overflow-menu toggle; PR #1054 refines its placement.
- **PR #1054** — must merge first (sequencing note above).
