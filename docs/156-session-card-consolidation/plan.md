---
status: planned
priority: medium
description: Replace the session top bar with the PR lifecycle card, making the PR row the single piece of top chrome and absorbing session actions into its overflow menu.
---

# 156 — Session card consolidation

Today the chat panel has two pieces of "session chrome":

1. **`SessionTopBar`** at the top — session name (inline-editable), search, overflow menu (rename / download / archive / auto-merge toggle).
2. **`PrLifecycleCard`** pinned just above `MessageInput` — PR phase, CI status, merge button, auto-fix / auto-merge toggles, failure list.

This plan **removes `SessionTopBar` entirely** and promotes the PR lifecycle card to the top of the chat panel, where it becomes the single piece of top chrome. Session-management actions (rename, archive, download chat) move into its overflow menu. Search keeps a dedicated icon button next to the overflow. The session name lives only in the sidebar.

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

### Overflow menu absorbs session actions

`SessionTopBar`'s overflow contents (Rename, Download chat, Archive, Recover-rewind, auto-merge toggle) move into the PR row's overflow. So does the existing PR auto-fix / auto-merge toggle cluster. Approximate order:

```
[⋯]
├── Rename session…
├── Search conversation              (also: dedicated 🔍 button)
├── Download chat
├── Archive session
├── ─────────────
├── Auto-fix CI failures             (toggle, visible when a PR exists)
├── Auto-merge when CI passes        (toggle, visible when a PR exists)
└── Recover recent rewind            (when applicable)
```

The Recover-rewind item keeps its existing visibility condition.

### Session name lives only in the sidebar

- **Primary surface:** the session row in the sidebar (today's location). Inline-editable there.
- **Secondary surface:** browser tab title (today's behavior).
- **Removed from the top of the chat panel entirely.**

The "Rename session" overflow item in the new row is the keyboard/menu path; sidebar click-to-edit is the mouse path. On mobile the sidebar is collapsed by default, so renaming goes through the overflow menu.

We *considered* keeping the session name as small secondary text in the row's right cluster as a "where am I?" anchor. **Rejected** because it re-introduces the visual duplication the multi-PR section warns against (PR title and session name side-by-side), and the sidebar already serves the anchor role.

### Session ≠ PR — independent names, independent renames

(See "Why session ≠ PR" above for the rationale.)

- **Renaming the session** is a local-only action (no GitHub call). Lives in the sidebar inline rename and the row's overflow.
- **Renaming the PR** lives in the PR detail panel (PATCH to GitHub) and is out of scope for this plan to design; today it's not directly editable in-app. Adding it is a follow-up.
- **No `titleAuto` flag.** No auto-upgrade. The first-message-derived session name stays as-is unless the user renames; the AI-generated PR title (already generated by `quickCreatePr` for use in the PR body) lives only on GitHub.

## What changes

### Client

- **`SessionTopBar` is deleted** along with its tests. Its responsibilities move into the PR row's right cluster (`[🔍] [⋯]`) and overflow menu.
- **`PrLifecycleCard` is repositioned** to sit at the top of the chat panel, sticky. The phase-rendering logic (`ReadyPhase`, `OpenPhase`, `TerminalPhase`, `ErrorPhase`) is reused; the surrounding container changes (no more `rounded-t-xl border-b-0` / `mx-4` "tab into input" styling).
- **`PrLifecycleCard` always renders** when there's an active session, even pre-PR — collapsed to just the right cluster. This is what gives session actions a stable home.
- **PR row's overflow menu absorbs**: Rename session, Search conversation, Download chat, Archive, Recover recent rewind, plus existing auto-fix / auto-merge toggles.
- **`MessageInput`** drops the `hasPrCard` prop and the `rounded-b-xl` branch; it's always `rounded-xl`. The `hasPrCard` selector in `App.tsx` (line 157) is removed.
- **`App.tsx`** moves the `{wsSessionId && <PrLifecycleCard …/>}` block out of the bottom stack (line 1070) and to the top of the chat panel (replacing the `<SessionTopBar>` mount at line 1011). The bottom stack continues to host `AgentStatusBar`, `RebaseBanner`, `QueueIndicator`.
- **Sidebar** keeps inline rename for the session name (already supported). This becomes the primary mouse path for renaming.

### Server

- **No schema changes.** `session.title` keeps its current semantics — local, free-form, AI-generated initially from the first user message. No `titleAuto` field, no GitHub PATCH on rename.
- **No changes to `quickCreatePr`.** It continues to generate a rich PR title for the PR body; that title lives only on GitHub.

### Tests

- `PrLifecycleCard.test.tsx` — add tests for the "no PR, idle" state (renders right cluster only) and for the overflow menu absorbing session actions; remove tests that depended on the title appearing in row 2.
- `SessionTopBar.test.tsx` — deleted.
- `MessageInput.test.tsx` — confirm standalone `rounded-xl` (no more `hasPrCard` branch).
- No new server tests; no server behavior changes.

## Migration

- The visual move (PR card from above input to top of chat, top bar deleted) is a hard cutover. No flag; old layout deleted in the same PR. `hasPrCard` and the rounded-corner gymnastics go with it.
- No data migration — `session.title` semantics are unchanged.

## Non-goals

- **PR title editing inside ShipIt.** Out of scope for this plan. The PR detail panel continues to show the canonical GitHub title as today; an "Edit title" affordance there is a follow-up if we decide we want it.
- **Multiple-PR list view.** The row shows the most recent / active PR only. Historic PRs for the session are reachable via the PR detail panel; we're not building an in-row PR carousel.
- **Sticky-row collapse on scroll.** The row doesn't shrink further as you scroll. If it ever feels heavy, we can revisit.
- **Session name shown in the row.** Considered and rejected — see "Session name lives only in the sidebar."
- **Syncing session name and PR title.** Considered and rejected — see "Why session ≠ PR."

## Related

- [064-pr-lifecycle-flow](../064-pr-lifecycle-flow/plan.md) — original inline PR card design. This plan supersedes the "pinned above input" placement decision in §4 of that doc.
- [133-pr-detail-panel](../133-pr-detail-panel/plan.md) — the detail panel that row-2 clicks open into. Continues to be the home for full PR detail (description, comments, reviews).
- [099-auto-pr-on-meaningful-turn](../099-auto-pr-on-meaningful-turn/plan.md) — the auto-create-PR flow that triggers step 2 of the name-upgrade ladder when enabled.
