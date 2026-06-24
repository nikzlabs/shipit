---
issue: https://linear.app/shipit-ai/issue/SHI-209
title: Hide repository from the sidebar
description: Declutter the sidebar by hiding a repo (a pure visibility flag) without removing its sessions, containers, or history.
---

# Hide repository from the sidebar

## Problem

The only way to get a repo out of the sidebar was **Remove** (`DELETE /api/repos/:url`),
which is the heavy "reclaim disk" action: it archives every session, destroys the
warm session, and frees working copies + containers. Users who just want to
*declutter* a long repo list — without losing sessions or paying a re-clone to get
the repo back — had no lighter option.

## Design

**Hide is a pure visibility flag.** A `hidden` boolean on the repo record. Hiding a
repo drops it (and its sessions) from the sidebar and touches **nothing else** —
sessions, containers, working copies, and history all survive. Idle containers reap
on their own normal schedule. Hiding is instant and perfectly reversible, which is
what keeps it cleanly distinct from Remove.

| | Hide (docs/222) | Remove (docs/059) |
|---|---|---|
| Leaves the sidebar | ✓ | ✓ |
| Sessions | untouched, reappear on unhide | archived |
| Containers / working copies | untouched | freed |
| Reversible | instantly | re-add re-clones |
| Confirmation dialog | no (nothing destroyed) | yes (deleted-vs-kept) |

### Three touchpoints

1. **Hide entry** — a "Hide from sidebar" item in the repo `OverflowMenu`
   (`SessionGroup.tsx`), between Project Settings and Remove, with an `EyeSlash`
   icon and **normal** styling (the destructive red is reserved for Remove). It acts
   inline — no confirmation — because nothing is destroyed.

2. **Sidebar reveal** — a collapsible **"Hidden · N"** footer at the bottom of the
   repo list (`SessionSidebar.tsx`). Collapsed by default (unobtrusive), it expands
   to list each hidden repo with a hover **Show** action. Only renders when N > 0.

3. **Add-flow detection** — re-adding an existing repo through the Add dialog clears
   the hidden flag server-side (`RepoStore.add`), so a hidden repo brought back via
   the normal Add flow just reappears. The dialog matches a search result against
   already-added-but-hidden repos (by `parseRepoLabel`) and relabels the row
   "Already added · hidden" with a **Show** affordance.

### Why a hidden repo's sessions also disappear

A hidden repo's sessions live under its sidebar group, so they leave with it. They
stay reachable via "All Sessions" (same as Remove) and return in full on unhide.
`SessionSidebar` filters hidden repos' sessions out of the grouping input so they
don't resurface in the "orphan" bucket (which catches any session whose `remoteUrl`
isn't a known/visible repo).

## Key files

- `src/server/shared/database.ts` — migration: `ALTER TABLE repos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`.
- `src/server/shared/types/domain-types/session.ts` — `RepoInfo.hidden?: boolean`.
- `src/server/orchestrator/repo-store.ts` — `setHidden(url, hidden)`; `add()` clears `hidden` on re-add (unhide-on-readd).
- `src/server/orchestrator/services/repos.ts` — `setRepoHidden()` (404 when unknown).
- `src/server/orchestrator/api-routes-session-repos.ts` — `PATCH /api/repos/:url` `{ hidden }`, broadcasts `repo_list`.
- `src/client/stores/repo-store.ts` — `setRepoHidden()` (optimistic, reverts on failure); `hiddenReposCollapsed` + toggle.
- `src/client/utils/local-storage.ts` — persisted Hidden-section collapse state (defaults collapsed).
- `src/client/components/SessionSidebar/SessionGroup.tsx` — "Hide from sidebar" menu item.
- `src/client/components/SessionSidebar/SessionSidebar.tsx` — visible/hidden split, session filtering, the "Hidden · N" section.
- `src/client/components/AddRepoDialog.tsx` — hidden-match detection + "Show" label.

## Tests

- `repo-store.test.ts` — default-visible, `setHidden` flip, 404 on unknown, unhide-on-readd, persistence, per-repo isolation.
- `integration_tests/repos.test.ts` — `PATCH` hide/show, sessions survive a hide, re-add unhides, 400 on bad body, 404 on unknown.

## Visual reference

[mockup.html](./mockup.html) — the dropdown entry, the "Hidden · N" reveal, and the Add-flow detection.
