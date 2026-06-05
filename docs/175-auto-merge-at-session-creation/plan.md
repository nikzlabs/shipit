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

### 2. Always show the toggle — inform, never block

Arming at creation is sharper than arming mid-session: today the user toggles
auto-merge *after* seeing the agent's work; here they're trusting code they
haven't read at all. The only thing between a bad turn and `main` is the CI gate
in `AutoMergeManager` (`checks.state === "success"` + mergeable + approvals), and
on a repo with **no required checks** that gate is effectively empty
(`checks.state === "none"` counts as passing, including the managed-merge
fallback in docs/077).

We considered gating the creation-time toggle on the repo having required checks.
**Rejected.** Experimental / throwaway projects legitimately have no CI and may
never want any — for those, "merge as soon as the PR is open and mergeable" is
exactly the intended behavior, not an accident. Hiding the toggle to protect the
user from a choice they deliberately made is the paternalism failure: it blocks a
real use case to guard against a mistake that **decision #1 already prevents.**
The explicit, per-session, default-off, type-it-every-time opt-in *is* the gate;
a second CI-presence gate on top of it would only frustrate the no-CI user
without making the deliberate user any safer. It would also cut against §5 — we'd
be second-guessing stated intent.

So the toggle is **always present**, on every repo. The honesty obligation is met
by **transparency, not a block**: when auto-merge is armed on a repo with no
required checks, the UI states plainly what will happen — e.g. *"Will merge as
soon as the PR is open and mergeable — this repo has no CI gate."* The user is
informed; the user is never blocked.

This line must appear in **both** surfaces, not just one:

- **The quick-capture overlay**, inline next to the checkbox, *at arm time*. This
  is the load-bearing one for this feature: a quick session is fire-and-forget —
  the user may **never open the session and never see the PR card**. If the only
  warning lived on the card, the user who most needs it (armed-and-walked-away)
  would never see it. So the overlay must show the no-CI consequence at the moment
  the box is checked.
- **The PR lifecycle card**, as the durable reminder once the PR exists, for the
  user who *does* come back to the session.

**Implementation implication:** showing the line in the overlay means we must know
whether the *selected* repo has required checks **at overlay time** — before the
session or PR exists — and re-evaluate it when the repo dropdown changes. The card
half is cheap (CI state is already in hand once the PR exists); the overlay half
needs a lightweight "does this repo gate on checks?" lookup keyed by repo. Treat
that lookup as part of this feature, not an afterthought — without it the overlay
line can't render. Cache per repo within the overlay session to avoid refetching
on every keystroke.

**Mobile is a first-class target, not an afterthought.** Quick-capture is heavily
a mobile / on-the-go surface (it's the "I just thought of something" path), so the
checkbox + no-CI line must look deliberate on a narrow viewport, not a desktop
control crammed into a phone. Both the overlay control and the PR-card line must
be verified on mobile breakpoints — the card especially, since #1054 is itself
reworking the card's responsive layout (the inline toggle was previously
`md:hidden`). Lay the overlay control out so the label, checkbox, and warning line
wrap cleanly and stay tappable at mobile width.

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
| `src/client/components/QuickCaptureOverlay.tsx` | New auto-merge checkbox in the overlay form; default off; **not** wired to `localStorage`. Always present (no CI-presence gating, per decision #2). Renders the inline "no CI gate" line when the selected repo has no required checks; must look deliberate on mobile breakpoints. |
| Repo required-checks lookup (overlay-time) | A lightweight "does this repo gate on required checks?" query, keyed by repo, so the overlay can render the no-CI line before any session/PR exists. Likely a small server route + client hook; cache per repo within the overlay. |
| `src/client/stores/actions/session-actions.ts` | `createHeadlessSession()` carries an optional `armAutoMerge` flag into the request. |
| `src/server/orchestrator/api-routes-session.ts` | `POST /api/sessions/headless` accepts the optional flag (validate as boolean). |
| `src/server/orchestrator/services/headless-sessions.ts` | `CreateHeadlessSessionOptions` gains the flag; after the session is claimed/graduated, seed the per-session armed auto-merge state. |
| `src/server/orchestrator/services/github.ts` / `auto-merge-manager.ts` / `pr-status-poller.ts` | **Reused as-is** — the seed calls the existing toggle/arm path; no new merge logic. |
| `src/client/components/PrLifecycleCard.tsx` | Durable "no CI gate on this repo" transparency line on the card when armed without required checks (decision #2). Coordinate with PR #1054's inline-toggle placement and verify on mobile breakpoints (#1054 reworks the card's responsive layout). |

## Relationship to other docs

- **docs/077-managed-auto-merge** — the merge machinery this reuses; source of
  the managed-fallback / `checks.state === "none"` risk in decision #2.
- **docs/145-quick-capture-overlay** — the surface that gains the toggle.
- **docs/156 / docs/169** — established the pre-PR armed state and the
  overflow-menu toggle; PR #1054 refines its placement.
- **PR #1054** — must merge first (sequencing note above).
