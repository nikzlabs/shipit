---
issue: planning#532
title: Broken-workspace sessions stay visible
description: Persist the durability block the disk janitor already computes, exempt it from the sidebar cap, and raise it as an attention reason.
---

# Broken-workspace sessions stay visible

Implements [requirements.md](./requirements.md).

## The incident

Session `f77e4992` ("Build a 3D mob model with animations via concept art",
`nicolasalt/reward-tag`, PR #143 merged 2026-08-28) left its checkout stuck
mid-rebase. `ensureCheckoutDurable` classified it `blocked-by-dirty` with
`rebaseInProgress: true`, so the disk janitor could not evict it and logged
`evict blocked for f77e4992…` **116 times in under 18 hours**. The user saw none
of it for 15 days: the session was not in the sidebar, and was reachable only
through a `/session/<id>` URL an ops investigation produced.

Two independent things hid it.

1. **The per-repo cap.** `filterVisibleInSidebar` keeps only
   `MAX_MERGED_SESSIONS_PER_REPO` (5) resolved sessions per repository. The repo
   had 26; the 28 August one ranked about 20th and was dropped inside
   `SessionManager.list()`, before the client saw it. (`listAll()` has no such
   filter, which is why the ops CLI could see what the UI could not.)
2. **The "Needs you" view could not have helped.** It takes the sidebar's
   visible sessions as its input (docs/260-attention-sidebar-view), so the cap
   removed the session from it too — and `computeAttentionReason` had no input
   about workspace health at all.

## Design

`ensureCheckoutDurable` already computes the right answer on every janitor tick;
nothing persisted it and nothing reached the client. So the whole change is one
persisted field plus the two reads of it.

### The signal — `SessionInfo.workspaceBlock`

```ts
workspaceBlock?: WorkspaceBlockKind;  // secret | conflict | no-repository | unreadable | unknown
```

One optional string, because `SessionInfo` rides every `session_list` broadcast.
A "stuck since" timestamp was considered and cut: nothing renders it, and a
field no consumer reads is mechanism nobody would miss.

`WorkspaceBlockKind` is the same name set as `EvictBlockReason["kind"]` without
its server-only payloads (`SecretFinding[]`, `UnreadableWorkspace`), which the
client must not import. The direction that matters is enforced by a type error
rather than a comment: the janitor assigns `reason.kind` straight into
`setWorkspaceBlock`, so a **new evict reason** cannot ship without a name here,
and the client's reason table is a `Record<WorkspaceBlockKind, string>`, so a
new name cannot ship without a sentence (req 2). The two unions are not proven
*equal* — a name added here alone would compile — which is the weaker, and
sufficient, guarantee.

`SessionManager.setWorkspaceBlock(id, kind | null)` returns **whether the stored
value changed**. That is what makes a session stuck for weeks silent: the
janitor re-evaluates it every pass, and only a real change broadcasts.

### Who writes it

**The disk janitor, and only the disk janitor** (`tier-escalation.ts`). It is
the one place that already runs `ensureCheckoutDurable` against an idle session
and already knows the answer.

- `blockedEvict(…, reason)` records `reason.kind`.
- `blockedEvict(…)` with **no** reason clears it. A `blocked-by-push` refusal
  (detached HEAD, a push that failed) means the tree itself committed fine: that
  is offline/auth/remote trouble, not a workspace the user must repair, and
  marking it would flag every session during a network outage.
- The durable path clears it immediately before eviction proceeds, and the
  eviction itself clears it again after `setDiskTier("evicted")`. Both are
  needed: an evicted session is excluded from every later pass, so a marker left
  on one is permanent — and the missing/empty-workspace paths reach the wipe
  without ever running the git check.

**The post-turn commit does not set it**, deliberately. A conflicted tree
mid-turn is ordinary — the agent rebases constantly — and a marker raised there
would be noise. It only *clears* (below).

`onSessionsChanged` is a new optional dep, wired in `startup-monitors.ts` to
`sseBroadcast("session_list", …)`. Without it the marker would only reach the
sidebar on the next unrelated broadcast; with it the session appears while the
user is looking at the list.

### How it clears (req 6)

A permanently sticky marker would be worse than today's silence, so there are
three clearing paths and no user-facing dismiss action.

1. **The janitor**, on any later pass where the checkout turns out durable. This
   is the idle case, and it is self-healing: the session stays at `light` past
   its evict threshold, so every pass re-asks.
2. **`postTurnCommit`**, which is the "user opened the session and fixed it"
   case the janitor cannot see: a session with an attached viewer never descends
   the tier ladder. Two conditions, because the auto-commit result alone is NOT
   evidence of a repair — it reports a clean tree without looking at
   `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD`, and a clean tree holding
   unfinished sequencer state is exactly the shape `ensureCheckoutDurable` still
   refuses (and exactly the incident's shape). So:
   - the auto-commit held nothing back — no secret findings, no conflicted
     paths, no rebase reported, no unreadable path. `unreadable: { kind:
     "omitted" }` counts as still-broken here, unlike the adjacent secret-block
     clear: the eviction check refuses a tree it could not read in full;
   - **and** `isRebaseInProgress()` / `isMergeOrSequencerInProgress()` both say
     no — the same two questions the janitor asks. These run only when there is
     a marker to withdraw, so the ordinary turn pays nothing for them.

   `runPostInterruptCommit` reaches the same code, and is a real clearing path:
   an agent that aborts the rebase and is then interrupted never reaches the
   ordinary post-turn commit. It carries the broadcaster too.

3. **`restoreSessionWorkspace`**, which replaces a wiped checkout with a fresh
   clone. A fresh clone cannot be the broken checkout the marker described.

Every clear broadcasts only on an actual change, via the same
`setWorkspaceBlock` return value.

**Two accepted limits, stated plainly.**

A `hot` session is not evaluated by the janitor, so a freshly broken checkout is
not marked until the session goes idle (24h to `light`, then its evict
threshold). That is acceptable for a first cut — the incident is about a session
nobody has touched for weeks, and a session the user is actively in is one they
can already see.

And a repair made entirely outside an agent turn, in a session the janitor will
not descend (pinned, or holding a preview reservation), keeps its marker until
one of those changes. Adding a health re-check that runs independently of
eviction eligibility would be a second evaluator of the same question, which
req 2's "one mechanism" is meant to avoid; the existing paths cover every way
the incident is actually repaired.

### How it surfaces

`filterVisibleInSidebar` gains `|| !!s.workspaceBlock` beside the existing
`pinnedAt` exemption, following the docs/110-pinned-sessions precedent (req 1).
Archived rows are still excluded — archiving is the user's own decision.

`computeAttentionReason` gains `workspaceBlockKind`, placed:

- **below `muted`** (req 5) — a mute is the user's own "not mine to look at now",
  and docs/277-session-mute silences every reason at once;
- **below `awaitingPermission`** — a blocked permission prompt is the more
  immediate block, and it resolves in one click;
- **above the `isAgentRunning || hasBackgroundTasks` short-circuit** (req 4) and
  above `resolved`, because neither premise holds here. That short-circuit means
  "the session will speak again on its own"; no turn finishes a stuck rebase by
  ending. And `resolved` means "there is nothing left to do", which a merged
  session with an uncommittable checkout contradicts — the incident session had
  been merged for weeks.

The reason string names the cause ("Workspace has an unresolved merge or
rebase"), so the row tooltip says what is wrong without a new card.

## Deferred

The user's natural repair, `git rebase --abort`, failed on the incident session
with a complaint about uncommitted files; the exact text is unknown (the ops
session is read-only and cannot enter another session's container). So the
surfaced state carries **no click-to-repair action** yet — guessing at a fix
without the error would be worse than the marker plus the existing
`formatEvictBlockedNotice` chat notice, which already explains the block and
what to do. A repair affordance is tracked as planning#533.

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/domain-types/session.ts` | `SessionWorkspaceBlock`, `WorkspaceBlockKind`, `SessionInfo.workspaceBlock` |
| `src/server/shared/database.ts` | `sessions.workspace_block` column |
| `src/server/orchestrator/sessions.ts` | `SessionRow.workspace_block`; `fromRow`; `setWorkspaceBlock`; the `filterVisibleInSidebar` exemption |
| `src/server/orchestrator/tier-escalation.ts` | `recordWorkspaceBlock`; set in `blockedEvict`, clear on the durable path; `onSessionsChanged` dep |
| `src/server/orchestrator/startup-monitors.ts` | wires `onSessionsChanged` to `sseBroadcast("session_list", …)` |
| `src/server/orchestrator/ws-handlers/post-turn.ts` | `clearWorkspaceBlockIfRepaired` — the auto-commit result plus the janitor's own two sequencer questions; optional `sseBroadcast` on the ctx |
| `src/server/orchestrator/services/post-interrupt-commit.ts` | carries `sseBroadcast` so the interrupt path publishes its clear |
| `src/server/orchestrator/services/session.ts` | `restoreSessionWorkspace` clears the marker on a fresh clone |
| `src/client/hooks/useAttentionInfo.ts` | `WORKSPACE_BLOCK_REASON`; `workspaceBlockKind` input and its placement |
| `src/client/hooks/useAttentionSessions.ts`, `useAttentionNotifications.ts`, `SessionSidebar/SessionItem.tsx` | pass `session.workspaceBlock?.kind` through |
