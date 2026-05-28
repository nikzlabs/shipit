---
status: in-progress
priority: medium
description: Replace the session top bar with the PR lifecycle card and move session-management actions (rename, archive) into a hover-reveal overflow on each sidebar row.
---

# 156 — Session card consolidation

Today the chat panel has two pieces of "session chrome":

1. **`SessionTopBar`** at the top — session name (inline-editable), search, overflow menu (rename / download / archive / auto-merge toggle).
2. **`PrLifecycleCard`** pinned just above `MessageInput` — PR phase, CI status, merge button, auto-fix / auto-merge toggles, failure list.

This plan **removes `SessionTopBar` entirely** and promotes the PR lifecycle card to the top of the chat panel, where it becomes the single piece of top chrome. **Session-management actions move to the sidebar** (a hover-revealed three-dots menu on each session row), not to the new top bar — actions belong where the affected surface lives, and the session name lives in the sidebar. The new top bar's right cluster is `[🔍 Search] [⋯ Overflow]`; its overflow holds only conversation-scoped and PR-scoped items.

The session name and the PR title are kept as **two independent strings** — see the "Why session ≠ PR" section below.

## Why

Two concrete problems with today's layout:

### 1. The PR card sits directly above the message input

That puts the most destructive button on the entire screen — **"Squash & merge"** — one row above where the user is typing. The author of this plan has clicked the merge button instead of the send button on multiple occasions. The merge is irreversible; "send" is not. The two affordances should not be neighbors.

### 2. The pinned card forces accidental complexity at the input boundary

`MessageInput` currently switches between `rounded-xl` and `rounded-b-xl` based on a `hasPrCard` prop, and `PrLifecycleCard` uses `rounded-t-xl border-b-0` to fake a shared border with the input. This works but bleeds card state into the input component, and breaks down in the quick-session case where the input is rendered standalone. See `App.tsx:1074` and `PrLifecycleCard.tsx:643`.

### 3. Session name and PR title are conflated in the chrome, but they're two different things

Today the session top bar and the PR card both show a name-like string. They visually look like duplicates, but in fact they describe different things — see the next section.

## Why session ≠ PR

The session name and the PR title are **two independent strings** and this plan keeps them that way. They're not redundant; they describe different things:

- **Session name = user intent.** What the user is working on. Persistent. Survives multiple PRs. Reflects how the user organizes their sidebar. Often manually set (or auto-named from the first message, then accepted).
- **PR title = deliverable.** What this specific patch ships. Scoped to the diff. Regenerated for each PR. Lives on GitHub; visible to reviewers.

The multi-PR case proves they should stay separate. A real workflow:

```
User: "Add stop-hook PR enforcement"           ← session name captures the intent
   → PR #42: "Wire stop-hook into post-turn flow for claude-adapter"
   → merged

User: "now do the same for codex-adapter and ship it"
   → PR #43: "Mirror stop-hook wiring into codex-adapter"
```

The session keeps its name across both PRs — same intent, different deliverables. Any syncing logic that renamed the session to match PR #42, then either left a stale name or tried to sync again on #43, would actively get in the way.

A previous iteration of this plan proposed a `titleAuto` flag and a "promote PR title to session name on creation" upgrade. That model is **rejected** for the multi-PR case above (the upgrade-once semantics don't survive a second PR), and because even the single-PR case has users whose intent legitimately differs from the deliverable. Two strings, two rename surfaces, both staying local to their natural home.

## Design

### Layout: the PR card *is* the top chrome

```
┌──────────────────────────────────────────────────────────────────────┐
│ [PR] #42 · ✓ 5/5 · main ← shipit/abc · [Merge ▾]      [🔍]    [⋯]   │   ← single top row; adapts to phase
└──────────────────────────────────────────────────────────────────────┘
                                  ⋮
                              (chat history)
                                  ⋮
┌──────────────────────────────────────────────────────────────────────┐
│ [text input + attachments + agent picker]                            │   ← MessageInput, standalone, always rounded-xl
└──────────────────────────────────────────────────────────────────────┘
```

- **Sticky** at the top of the chat panel — PR state is session-level info that should survive scrolling.
- **Always present**, even when there's no PR, so that session actions (rename, archive, etc.) have a home.
- **Adapts to PR phase:**

  ```
  No PR, idle:    [                                                   ] [🔍] [⋯]
  ready phase:    [3 files · +42 -12 · Create Pull Request           ] [🔍] [⋯]
  creating:       [⏳ Creating pull request…                           ] [🔍] [⋯]
  open:           [PR] #42 · ✓ 5/5 · main ← shipit/abc · [Merge ▾]    [🔍] [⋯]
  open + failing: [PR] #42 · ✗ 3/5 · [Fix CI]                          [🔍] [⋯]
                   ↳ lint: Process completed with exit code 1
                   ↳ test: 3 tests failed
  merged:         [✓ #42 merged into main]                            [🔍] [⋯]
  closed:         [#42 closed]                                        [🔍] [⋯]
  error:          [⚠ Could not create PR: …] [Retry]                  [🔍] [⋯]
  ```

- **Compact-first.** The row is single-line on desktop. Failure lists expand below the row when there's something requiring attention; idle phases shrink to almost nothing.
- **Right cluster: `[🔍 Search] [⋯ Overflow]`.** Search is frequent enough to warrant a dedicated icon; everything else lives in the overflow.

### Multi-PR per session

The session is the persistent thing; PRs come and go through the same row:

```
PR #42 created → row shows PR #42
PR #42 merged → row shows "✓ merged" briefly, then collapses to "no PR" / "ready" depending on uncommitted state
Agent does follow-up → PR #43 created → row shows PR #43
```

The session name is unaffected throughout. There is no "PR list" view inside the row — only the active/most-recent PR. Historic PRs for the session are reachable via the PR detail panel (out of scope for this plan).

### Action placement: actions live where the affected surface lives

The session name lives in the sidebar; the PR/conversation lives in the top bar. Each surface owns its own actions:

**Sidebar row overflow (new):** Rename, Archive, Restore (archived rows).
**Top bar right cluster:** dedicated `[🔍 Search]` icon + `[⋯ Overflow]`.
**Top bar overflow:** Download chat, Recover recent rewind, **Auto-fix CI failures**, **Auto-merge when CI passes**.

Both `Auto-fix` and `Auto-merge` are reachable whenever the session has a GitHub remote — they're stored preferences, not actions, and pre-enabling them before a PR exists is a real workflow ("I'm going to ship this; merge it when CI's green"). They don't require a PR or a CI state to toggle, but they do require a remote (without one there will never be a PR for the preferences to act on). The one preserved precondition is `currentSession.remoteUrl`, matching today's `SessionTopBar` gate at `App.tsx:1014`. See "Auto-fix / Auto-merge availability" below for the consolidation and the latent-bug fix that comes with it.

Why split this way:

- **Rename in the top bar would be detached** — you'd open an overflow on the top bar, type a new name, and nothing in the top bar visibly changes (the new name appears in the *sidebar*). Putting rename in the sidebar row means the action and the affected text are co-located.
- **Today's one-tap archive button on every sidebar row is too easy to misclick** (`SessionSidebar.tsx:234-246`). Moving archive behind a hover-revealed overflow adds a deliberate step.
- **Inline rename is a Linear-style flourish we don't need here.** Sessions are renamed rarely; the extra menu step is fine.

### Sidebar row overflow menu (replaces today's one-tap archive button)

Each session row gets a three-dots button on the right of the row. Behavior:

```
On hover (desktop):     [⋯] fades in next to the row's existing controls.
On touch (mobile):      [⋯] is always visible (no hover affordance).
On the active row:      [⋯] is always visible regardless of hover, since the
                        active row is the most likely action target.
On archived rows:       Menu contains "Restore"; the existing inline
                        Restore button (ArrowCounterClockwise) is replaced
                        by the same menu for consistency.

Menu contents (non-archived row):
[⋯]
├── Rename
├── Archive
└── (Other session-management actions added here over time)

Menu contents (archived row):
[⋯]
└── Restore
```

The today's `<PhArchiveIcon>` and restore buttons on the row are removed — both subsume into the menu.

Rename opens an inline rename in the row (existing `SessionTopBar` inline-edit pattern moves here). Archive triggers the existing `archiveSession` flow.

### Auto-fix / Auto-merge availability — consolidate and unbreak pre-PR

Today, auto-merge is rendered in **four** places and auto-fix in **two**, with inconsistent gating:

| Toggle | Location | Visibility today |
|---|---|---|
| Auto-merge | `SessionTopBar.tsx:109` | Any session with `remoteUrl` (pre-PR OK) |
| Auto-merge | `PrLifecycleCard.ReadyPhase` (`:365`) | When `ready` snapshot is present |
| Auto-merge | `PrLifecycleCard.OpenPhase` (`:456`) | When PR is open and CI isn't failed |
| Auto-merge | `pr-detail/PrStatusSection.tsx:102` | PR detail panel |
| Auto-fix | `PrLifecycleCard.OpenPhase` (`:461`) | PR open AND CI is failed |
| Auto-fix | `pr-detail/PrStatusSection.tsx:103` | PR detail panel, CI failed |

Two problems:

1. **Auto-fix is unreachable pre-PR today.** The client only renders it when `isCiFailed` is true. The user cannot pre-enable "fix CI for me" before the PR exists. The server supports it (`PrStatusPoller.setAutoFixEnabled` stores per-session state regardless of PR existence); the client just never asks.
2. **Auto-merge is duplicated across three top-of-screen surfaces** (top bar + ready overflow + open overflow), with subtly different gating.

The consolidation:

- **Single top-bar overflow** is the canonical place for both toggles. The three top-of-screen instances (locations 1, 2, 3 in the table) collapse into one. They render whenever the active session has a GitHub remote (`currentSession.remoteUrl`) — no gating on PR existence, no gating on CI state, no `ready` snapshot requirement. The `remoteUrl` precondition is the one meaningful gate that survives the consolidation: without a remote there can never be a PR, and both server-side flows (`PrStatusPoller.setAutoFixEnabled` triggering on CI failure; `services/github.ts:toggleAutoMerge` calling GitHub's GraphQL mutation) depend on a PR. Sessions on a local-only repo show no toggles, matching today's behavior for Auto-merge.
  - State persists in `PrStatusPoller` (server-side) as it does today. When a PR is later created, the stored preferences take effect: `autoMerge` calls into GitHub's auto-merge GraphQL mutation on PR creation; `autoFix` triggers the next time CI fails.
- **`PrLifecycleCard` no longer renders these toggles in its phase overflows.** The `ReadyPhase` overflow and the `OpenPhase` overflow lose their `AutoMergeToggle` / `AutoFixToggle` blocks. The phase-specific overflows can be deleted entirely if nothing else lives in them post-consolidation.
- **PR detail panel keeps its copy** (`PrStatusSection.tsx`). It's a separate contextual surface — when the user has drilled into PR detail, sending them back up to the top-bar overflow to flip a toggle is wrong friction. Both surfaces read/write the same `pr-store` state, so they stay in sync. Considered: also remove the detail-panel toggles to enforce "one place." Rejected — the detail panel is a distinct, opt-in surface; the duplication concern doesn't apply because both surfaces aren't visible simultaneously.

**Latent bug fix piggybacked.** Wiring auto-fix into the always-visible top-bar overflow incidentally fixes the "can't pre-enable auto-fix" gap. The server-side wiring (`setAutoFixEnabled` + the poller's failure-detection loop) already handles the pre-PR case; only the missing client affordance prevented users from reaching it.

### Session name lives only in the sidebar

- **Primary surface:** the session row in the sidebar (today's location). Edited via the sidebar row's `[⋯] → Rename`.
- **Secondary surface:** browser tab title (today's behavior).
- **Removed from the top of the chat panel entirely.**

We *considered* keeping the session name as small secondary text in the top bar's right cluster as a "where am I?" anchor. **Rejected** because it re-introduces the visual duplication the multi-PR section warns against (PR title and session name side-by-side), and the sidebar already serves the anchor role.

### Session ≠ PR — independent names, independent renames

(See "Why session ≠ PR" above for the rationale.)

- **Renaming the session** is a local-only action (no GitHub call). Lives in the sidebar inline rename and the row's overflow.
- **Renaming the PR** lives in the PR detail panel (PATCH to GitHub) and is out of scope for this plan to design; today it's not directly editable in-app. Adding it is a follow-up.
- **No `titleAuto` flag.** No auto-upgrade. The first-message-derived session name stays as-is unless the user renames; the AI-generated PR title (already generated by `quickCreatePr` for use in the PR body) lives only on GitHub.

## What changes

### Client — top bar

- **`SessionTopBar` is deleted** along with its tests. Search and overflow move to the PR row's right cluster; rename and archive move to the sidebar row overflow (see below).
- **`PrLifecycleCard` is repositioned** to sit at the top of the chat panel, sticky. The phase-rendering logic (`ReadyPhase`, `OpenPhase`, `TerminalPhase`, `ErrorPhase`) is reused; the surrounding container changes (no more `rounded-t-xl border-b-0` / `mx-4` "tab into input" styling).
- **`PrLifecycleCard` always renders** when there's an active session, even pre-PR — collapsed to just the right cluster. This gives Search, Download chat, and Recover-rewind a stable home regardless of PR state.
- **PR row's overflow menu contents:** Download chat, Recover recent rewind, **Auto-fix CI failures** (whenever `currentSession.remoteUrl` is set), **Auto-merge when CI passes** (whenever `currentSession.remoteUrl` is set). Search is the dedicated `[🔍]` icon next to the overflow, not a menu item. Local-only sessions (no remote) show neither toggle, matching today's `SessionTopBar` behavior at `App.tsx:1014`.
- **`PrLifecycleCard` phase overflows lose their toggle blocks.** Remove the `AutoMergeToggle` from `ReadyPhase` overflow at `:365` and the `AutoMergeToggle` + `AutoFixToggle` from `OpenPhase` overflow at `:454-463`. Those phase-specific overflows can be removed entirely if nothing else lives in them.
- **PR detail panel keeps its toggles** (`pr-detail/PrStatusSection.tsx`). Considered and rejected: removing them in favor of "one canonical place" — the detail panel is a distinct contextual surface that's not visible at the same time as the top bar overflow, so the duplication concern doesn't apply; both surfaces share `pr-store` state.
- **`MessageInput`** drops the `hasPrCard` prop and the `rounded-b-xl` branch; it's always `rounded-xl`. The `hasPrCard` selector in `App.tsx` (line 157) is removed.
- **`App.tsx`** moves the `{wsSessionId && <PrLifecycleCard …/>}` block out of the bottom stack (line 1070) and to the top of the chat panel (replacing the `<SessionTopBar>` mount at line 1011). The bottom stack continues to host `AgentStatusBar`, `RebaseBanner`, `QueueIndicator`.

### Client — sidebar row overflow

- **The inline archive button** (`SessionSidebar.tsx:234-246`, the `<PhArchiveIcon>` wrapped in a `WithTooltip`) is **removed**. Same for the inline restore button on archived rows (`SessionSidebar.tsx:225-232`-ish).
- **New three-dots overflow button** on each session row, on the right.
  - Hover-revealed on desktop; always visible on touch and on the currently-active row.
  - Reuses the existing `OverflowMenu` primitive (used today by `SessionTopBar`).
- **Menu contents (non-archived):** Rename, Archive.
- **Menu contents (archived):** Restore.
- **Rename** opens an inline rename inside the row. The inline-rename input behavior moves over from `SessionTopBar` (focus-on-mount, Enter to submit, Esc to cancel, blur to submit, `editResolvedRef` guard against double-resolution).

### Server

- **No schema changes.** `session.title` keeps its current semantics — local, free-form, AI-generated initially from the first user message. No `titleAuto` field, no GitHub PATCH on rename.
- **No changes to `quickCreatePr`.** It continues to generate a rich PR title for the PR body; that title lives only on GitHub.

### Tests

- `PrLifecycleCard.test.tsx` — add tests for the "no PR, idle" state (renders right cluster only) and for the overflow menu's reduced contents; assert `AutoFixToggle` and `AutoMergeToggle` render in the overflow whenever the session has a `remoteUrl`, regardless of PR existence or CI state, and conversely that neither renders for a local-only session (no `remoteUrl`); remove tests that depended on the title appearing in row 2 or on the phase overflows owning the toggles.
- `SessionSidebar.test.tsx` — new tests covering: overflow hidden by default on inactive rows, visible on hover, always visible on active row, always visible on touch (simulate `(pointer: coarse)`); menu items for active vs archived rows; inline-rename submit / cancel.
- `SessionTopBar.test.tsx` — deleted.
- `MessageInput.test.tsx` — confirm standalone `rounded-xl` (no more `hasPrCard` branch).
- `pr-ci-fix.test.ts` (integration) — extend existing coverage: enabling auto-fix pre-PR persists across PR creation and triggers on first CI failure (today this path exists on the server but is unreachable from the client; new test confirms it via the API).
- No new server tests for the placement change itself — no server behavior changes there.

## Migration

- The visual move (PR card from above input to top of chat, top bar deleted) is a hard cutover. No flag; old layout deleted in the same PR. `hasPrCard` and the rounded-corner gymnastics go with it.
- No data migration — `session.title` semantics are unchanged.

## Non-goals

- **PR title editing inside ShipIt.** Out of scope for this plan. The PR detail panel continues to show the canonical GitHub title as today; an "Edit title" affordance there is a follow-up if we decide we want it.
- **Multiple-PR list view.** The row shows the most recent / active PR only. Historic PRs for the session are reachable via the PR detail panel; we're not building an in-row PR carousel.
- **Sticky-row collapse on scroll.** The row doesn't shrink further as you scroll. If it ever feels heavy, we can revisit.
- **Session name shown in the row.** Considered and rejected — see "Session name lives only in the sidebar."
- **Syncing session name and PR title.** Considered and rejected — see "Why session ≠ PR."
- **Right-click context menu on sidebar rows.** Standard sidebar pattern but redundant with the always-discoverable `[⋯]` button. Worth doing as a small follow-up for power users, not blocking this plan.
- **Undo-toast on archive.** Even behind a hover-revealed menu, an accidental archive is annoying. An "Archived. Undo." toast (or alternatively a confirm dialog) is the right next step, but it's orthogonal to placement — it should apply regardless of where the archive action lives. Tracked as a follow-up rather than coupled to this plan.

## Related

- [064-pr-lifecycle-flow](../064-pr-lifecycle-flow/plan.md) — original inline PR card design. This plan supersedes the "pinned above input" placement decision in §4 of that doc.
- [133-pr-detail-panel](../133-pr-detail-panel/plan.md) — the detail panel that row-2 clicks open into. Continues to be the home for full PR detail (description, comments, reviews).
- [099-auto-pr-on-meaningful-turn](../099-auto-pr-on-meaningful-turn/plan.md) — the auto-create-PR flow that triggers step 2 of the name-upgrade ladder when enabled.
