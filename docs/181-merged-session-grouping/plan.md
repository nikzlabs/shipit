---
title: Sidebar "Recently merged" grouping reflects the current PR, not a frozen merge timestamp
description: Group merged sessions by their current PR state so a merged-and-idle session stops showing in Active after follow-up turns.
---

# Merged-session sidebar grouping (docs/181)

## Problem

Sessions whose **current** PR is merged on GitHub rendered in the main/**Active**
sidebar group instead of under **"Recently merged"**, even when idle for days with
no open PR. The user never deliberately reopened them.

### Root cause — `merged_at` was write-once, and grouping keyed on a timestamp race

`SessionManager.markMerged` stamped `merged_at` only on the **first** merge ever
detected on a branch (`... WHERE id = ? AND merged_at IS NULL`) and never updated
it. Sidebar grouping then derived "reopened" from a timestamp comparison:

```
reopenedAfterMerge(s) = last_used_at > merged_at        // OLD
isRecentlyMerged(s)   = merged_at != null && !reopenedAfterMerge(s)
```

`last_used_at` is bumped by **any** agent turn. So once a branch's first PR
merged, any later activity — merging a follow-up PR on the same branch, answering
a one-off question, spawning a child session, even a rebase — pushed
`last_used_at` permanently past the frozen `merged_at`. The session was then stuck
as "reopened" → Active forever, even though its current PR was merged and it was
idle. The heuristic also couldn't tell "user merged then kept building a
follow-up" (should be Active) from "user merged then asked one question" (should
be Recently merged): both bump `last_used_at`.

A compounding effect: spawned children are grouped by their **parent's** status,
so a cleanly-merged child was dragged into Active by its mis-flagged parent.
Fixing the parent fixes the child automatically.

## Fix — drive grouping from the current PR state

The PR poller already tracks the current PR state per session and persists it in
the `pr_status` column (`prState: "open" | "merged" | "closed"`). Grouping now
keys on that, not on the timestamp comparison:

```
reopenedAfterMerge(s) = merged_at != null && prState === "open"
isRecentlyMerged(s)   = merged_at != null && prState !== "open"
```

A merged session is "reopened" (→ Active) only when a **follow-up PR is OPEN** on
its branch; otherwise (current PR merged/closed, or no live PR) it stays demoted
to "Recently merged". This fixes all the reported cases:

- multi-PR session, first + later PR both merged, idle → Recently merged
- post-merge turn that opened no new PR (child spawn / one-off question) →
  Recently merged (its merged child rides along)
- a real follow-up PR is OPEN → stays Active

### `merged_at` is no longer write-once

`markMerged(id, mergedAt?)` now stamps `merged_at` on **every** merge detection
(the `IS NULL` guard is dropped when a timestamp is supplied). It uses GitHub's
authoritative `pr.merged_at` (threaded from `verifyMissingPr` →
`onMergeDetectedCb` → `markMergedAndPruneExcess` → `markMerged`) so the write is:

- **fresh** — the "Recently merged" ranking / per-repo view cap
  (`filterVisibleInSidebar`, sorted by `merged_at` desc) sorts by the most recent
  merge, so a multi-PR session isn't sunk past the cap by its first merge; and
- **idempotent** — re-detecting the same merge (e.g. when the poller re-verifies
  persisted merged sessions after an orchestrator restart) re-stamps the same
  instant rather than bumping every merged session to "now".

The merged-ranking sort now uses `parseTimestampMs` (UTC-normalized) instead of a
raw `Date.parse`, removing a latent timezone mis-order between the old
`datetime('now')` rows and ISO timestamps.

## Server / client mirror

The predicate exists on both sides and must stay in sync:

- **Server** (`sessions.ts`): `reopenedAfterMerge` reads `SessionInfo.prState`,
  parsed in `fromRow` from the persisted `pr_status` snapshot (fresh per
  `list()` call). Used by `filterVisibleInSidebar` for the per-repo merged view
  cap.
- **Client** (`SessionSidebar.tsx`): the `reopenedAfterMerge` / `isRecentlyMerged`
  mirror takes the current PR state from the **pr-store** (`statusBySession`,
  fed by the global SSE poller in real time), so a follow-up PR re-promotes a
  session to Active immediately and an idle merged session demotes correctly. An
  absent pr-store entry is treated as not-open → Recently merged (safe default).

## Known limitation

A session reopened with **un-merged commits ahead but no PR yet** shows under
"Recently merged" until its follow-up PR is opened (its current PR state is still
merged). This is transient — the agent opens a PR shortly after editing files —
and such a session is freshly worked, so it sorts to the top of its group and is
usually the current session. Detecting "branch advanced after the merge" would
need git data the pure listing predicate doesn't have.

## Key files

- `src/server/orchestrator/sessions.ts` — `reopenedAfterMerge` (prState-driven),
  `markMerged(id, mergedAt?)` (un-frozen + idempotent), `fromRow` (parses
  `prState`), `filterVisibleInSidebar` sort (UTC-normalized).
- `src/server/shared/types/domain-types.ts` — `SessionInfo.prState`.
- `src/server/orchestrator/pr-status-poller.ts` — `onMergeDetectedCb` forwards
  GitHub's `merged_at` from `verifyMissingPr`.
- `src/server/orchestrator/services/session.ts` — `markMergedAndPruneExcess`
  threads `mergedAt`.
- `src/server/orchestrator/app-lifecycle.ts` — wires `mergedAt` through the
  poller callback.
- `src/client/components/SessionSidebar.tsx` — client mirror reads the pr-store.
