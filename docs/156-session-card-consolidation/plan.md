---
status: planned
priority: medium
description: Merge the session top bar and the PR lifecycle card into a single sticky session header, and collapse session-name / PR-title into one canonical name.
---

# 156 — Session card consolidation

Today the chat panel has two pieces of "session chrome":

1. **`SessionTopBar`** at the top — session name (inline-editable), search, overflow menu (rename / download / archive / auto-merge toggle).
2. **`PrLifecycleCard`** pinned just above `MessageInput` — PR phase, CI status, merge button, auto-fix / auto-merge toggles, failure list.

This plan merges them into a single sticky session header at the top of the chat panel, and collapses the redundant "session name" / "PR title" pair into one canonical name.

## Why

Two concrete problems with today's layout:

### 1. The PR card sits directly above the message input

That puts the most destructive button on the entire screen — **"Squash & merge"** — one row above where the user is typing. The author of this plan has clicked the merge button instead of the send button on multiple occasions. The merge is irreversible; "send" is not. The two affordances should not be neighbors.

### 2. The pinned card forces accidental complexity at the input boundary

`MessageInput` currently switches between `rounded-xl` and `rounded-b-xl` based on a `hasPrCard` prop, and `PrLifecycleCard` uses `rounded-t-xl border-b-0` to fake a shared border with the input. This works but bleeds card state into the input component, and breaks down in the quick-session case where the input is rendered standalone. See `App.tsx:1074` and `PrLifecycleCard.tsx:643`.

### 3. Session name and PR title are two strings for the same thing

The session-naming flow today:

1. User sends first message.
2. Server generates a short session name from that message (early, low context).
3. Agent works, eventually creates a PR.
4. PR title is generated from full conversation context + diff (later, high context).
5. Session name is never updated. The two strings drift apart in quality, not in meaning.

The sidebar shows the early name; the PR card shows the rich name; they're nearly always describing the same work. Putting them on adjacent rows (as this plan does) makes the redundancy impossible to ignore.

## Design

### Layout: one sticky session header, two rows

```
┌─────────────────────────────────────────────────────────────────┐
│ Add stop-hook PR enforcement                              ⋯     │   ← row 1: session.title (inline editable), overflow menu
├─────────────────────────────────────────────────────────────────┤
│ [PR] #42 · ✓ 5/5 · main ← shipit/abc123 · [Merge ▾] · [⋯-auto]  │   ← row 2: PR phase, status, actions
└─────────────────────────────────────────────────────────────────┘
                                ⋮
                            (chat history)
                                ⋮
┌─────────────────────────────────────────────────────────────────┐
│  [text input + attachments + agent picker]                      │   ← MessageInput, standalone, always rounded-xl
└─────────────────────────────────────────────────────────────────┘
```

- The header is **sticky** at the top of the chat panel. PR state is session metadata; losing it as you scroll history is annoying.
- Row 2 only renders when there is something to render (a PR exists, a `ready` snapshot is pending, or an error is active). When absent, the header is just row 1 — same as today's top bar.
- The card is a single bordered container; the two rows share that border instead of each having their own.

### All PR phases live in the header

Including `ready` (the post-turn "Create Pull Request" affordance with the file list and `+ins -del`). The single "Where is my PR?" answer is "top of the chat." The risk that the `ready` affordance feels disconnected from the just-finished turn is small — the user's gaze tracks the agent's output anyway, and the sticky header is always in their peripheral vision.

If we observe in practice that `ready` discoverability suffers, the mitigation is a brief inline status-bar nudge (`Ready to push — see top ↑`) emitted alongside `AgentStatusBar`. We'll add it if needed, not preemptively.

### Compact row-2 — no title, just status and actions

Row 2 drops the PR title entirely because row 1 already carries the canonical name (see "Name consolidation" below). The row reduces to:

`[PR icon] #42 · <phase status> · <branches> · <primary actions> · <auto-toggles in overflow>`

This stays single-line on desktop. On mobile, the action cluster stacks below per the existing pattern (commit `a1b44df27`).

Expand-on-attention: if there's a failure list (CI failed, merge conflict, auto-fix exhausted), the relevant detail expands inline under row 2. The base compact form is the default.

### Name consolidation

One stored name. Auto-upgraded once. Synced thereafter.

```
1. First user message
   session.title    = AI-generated short name      (today's behavior)
   session.titleAuto = true                        (new field)

2. PR creation
   if session.titleAuto:
       session.title := PR.title                   (overwrite with richer name)
       session.titleAuto stays true
   else:
       leave session.title alone                   (user already took ownership)

3. Manual rename (row 1 inline edit, any time)
   session.title     = new value
   session.titleAuto = false
   if session has an open PR on this branch:
        PATCH PR title on GitHub (best-effort)
        on failure: keep local rename, surface a toast, allow retry
```

Properties this gives us:

- **One name everywhere** — sidebar, top bar, share links, history — all the same string. No "which name is the real name?" question.
- **Quality upgrade where it should happen** — the lightweight first-message name is replaced by the richer PR title at PR creation, but only if the user hasn't already renamed (the `titleAuto` flag preserves user intent).
- **Symmetric rename** — renaming the session is renaming the PR. "Rename PR" stops being a separate workflow that lives outside ShipIt.
- **No redundancy in the header** — row 2 doesn't need to repeat the title.

The `titleAuto` flag is the only subtle bit. Dropping it and always overwriting at PR creation would silently undo a user rename in the small window between first message and PR creation; never overwriting forfeits the quality upgrade. One boolean solves both.

### Behavior on terminal PR states

- **Merged PR** — session name stays as the (already-upgraded) PR title. Renames after merge are local-only (no GitHub PATCH; the PR is closed).
- **Closed PR (not merged)** — same as merged. Local-only renames thereafter.
- **Session reused on a new branch** — the next PR (if created) starts a fresh `titleAuto` flow if the session name is still in auto state, otherwise leaves the user's name alone. No retroactive renaming.

## What changes

### Client

- **New `SessionHeader` component** that composes the existing `SessionTopBar` (row 1) and a stripped-down version of `PrLifecycleCard` (row 2) inside a single bordered container. Sticky position at the top of the chat panel.
- **`PrLifecycleCard` is refactored** to drop the PR title from its compact form and to render inline under row 1 instead of pinned above the input. The phase-rendering logic (`ReadyPhase`, `OpenPhase`, `TerminalPhase`, `ErrorPhase`) is reused.
- **`MessageInput`** drops the `hasPrCard` prop and the `rounded-b-xl` branch; it's always `rounded-xl`. The `hasPrCard` selector in `App.tsx` (line 157) is removed.
- **`SessionTopBar`** is folded into `SessionHeader` (its existing props and inline-rename behavior move with it). The standalone file is deleted once nothing imports it.
- **`App.tsx`** moves the `{wsSessionId && <PrLifecycleCard …/>}` block out of the bottom stack at line 1070 and into the new `SessionHeader` near line 1011. The bottom stack continues to host `AgentStatusBar`, `RebaseBanner`, `QueueIndicator`.
- **Sidebar PR badge** stays as-is (`PrStateBadge`); it already lives next to the session name in `SessionSidebar` and benefits from the same single-name model.

### Server

- **`session.titleAuto: boolean`** field added to the session record (default `true` for new sessions). Persisted in the existing session metadata JSON.
- **`generateSessionName()`** (in `session-namer.ts`) sets `titleAuto = true` when it writes the initial name.
- **`renameSession()`** (in `services/session.ts`) sets `titleAuto = false` on every manual rename, and — when the session has an open PR for the current branch — also calls a new `github-auth.ts` helper that PATCHes the PR title via the GitHub REST API.
- **`quickCreatePr()`** (in `services/github.ts`), after creating the PR, checks `session.titleAuto`. If true, writes `session.title := pr.title` and emits a session-update event so the sidebar refreshes.
- **`updatePrTitle(owner, repo, prNumber, title)`** added to `github-auth-prs.ts`. Best-effort: returns success/failure, never throws into the rename path.

### Tests

- `SessionHeader.test.tsx` — renders row 1 alone when no PR, renders both rows when PR exists, sticky positioning, click targeting (row 2 click opens detail tab, row 1 click starts inline rename).
- `PrLifecycleCard.test.tsx` — existing tests updated to reflect dropped title in compact mode.
- `MessageInput.test.tsx` — confirms standalone `rounded-xl` (no more `hasPrCard` branch).
- `session-rename.test.ts` (integration) — manual rename with open PR calls GitHub PATCH; rename with no PR doesn't; rename after merge is local-only; PR creation upgrades the name only when `titleAuto === true`.

## Migration

- Existing sessions in the field have no `titleAuto` field. Treat missing as `false` (conservative — don't retroactively overwrite names of sessions that already had a PR with a different title). New sessions get `true` from day one.
- The visual move (card from above input to top of chat) is a hard cutover. No flag; old layout deleted in the same PR. `hasPrCard` and the rounded-corner gymnastics go with it.

## Non-goals

- **Renaming closed/merged PRs.** Once a PR is no longer open, renames stay local. We're not building a "edit the title of a merged PR" feature.
- **Multi-PR sessions.** The 1:1 session-to-PR model from 064 holds. If we ever support multiple PRs per session, this design needs revisiting.
- **PR title editing inside the PR detail panel.** The detail panel continues to show the canonical GitHub title (read-only); renaming happens via row 1 of the header. Keeps one rename surface.
- **Sticky-header collapse on scroll.** The header doesn't shrink as you scroll. If it ever feels heavy, we can revisit.

## Related

- [064-pr-lifecycle-flow](../064-pr-lifecycle-flow/plan.md) — original inline PR card design. This plan supersedes the "pinned above input" placement decision in §4 of that doc.
- [133-pr-detail-panel](../133-pr-detail-panel/plan.md) — the detail panel that row-2 clicks open into. Continues to be the home for full PR detail (description, comments, reviews).
- [099-auto-pr-on-meaningful-turn](../099-auto-pr-on-meaningful-turn/plan.md) — the auto-create-PR flow that triggers step 2 of the name-upgrade ladder when enabled.
