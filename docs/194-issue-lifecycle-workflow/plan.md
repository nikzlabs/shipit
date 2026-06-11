---
issue: https://linear.app/shipit-ai/issue/SHI-114
description: Automatic issue lifecycle — mark started when a session takes on an issue, mark completed when the finishing PR merges, with the agent deciding which PR finishes it via a Closes <pointer> line.
---

# Issue lifecycle workflow

## Goal

Close the loop between a ShipIt session and the issue it implements, so the
issue's status reflects reality **without the user babysitting it**:

- When a session starts working an issue → the issue moves to **started**.
- When the PR that finishes the issue **merges** → the issue moves to
  **completed**, with a summary comment.
- When a PR is only *part* of the work → nothing happens; the issue stays
  **started** until a later PR finishes it.

The agent decides which PR finishes the issue. ShipIt executes the mechanical
status transitions around that decision.

## Why this exists

Two concrete gaps in today's behavior:

1. **Issues never move to "in progress."** An agent can read an issue and open a
   PR for it, but nothing tells the tracker the work has started. A teammate
   looking at the board sees an untouched backlog item that's actually half-done.

2. **Auto-merge severs the agent from the issue.** When `AutoMergeManager` merges
   a PR, `onMergeDetectedCb` archives the session (`markMergedAndPruneExcess`) and
   **no agent turn ever runs again**. The work shipped, but the issue is still
   open with no record that it's done. The decision "is this issue finished?"
   cannot be made *after* merge, because there is no longer anybody in the loop —
   it has to be captured *before* merge, while an agent is still running.

This doc is the **workflow** layer. The underlying capability already exists:

- **docs/156** built the push trigger and the `IssueTrackerProvider` interface —
  which already declares `reportPrMerged(ref, pr)` — and seeds sessions with an
  `issueRef`. It captured the load-bearing insight: *the issue is the persistent
  thread across multiple PRs.* But it listed **issue status mutation as an
  explicit non-goal** ("side effects on third-party systems stay behind explicit
  user action").
- **docs/177** then made `shipit issue status` a first-class **brokered write**:
  the tracker token stays orchestrator-side, the mutation routes through ShipIt's
  `Tracker` adapter (not an MCP or `gh`), and each write surfaces a **do-then-
  surface provenance card with Undo**.

So setting status is already a supported, safe, tracker-neutral operation. What
156 deferred — *automatically* driving those transitions from session lifecycle —
is exactly what we now build, using 177's brokered write as the mechanism and
177's provenance card as the visibility/undo surface.

## Design

### Two transitions, two different sources of truth

The key structural decision: **started** and **completed** are driven by
different signals, and deliberately so.

| Transition | Trigger | Source of truth | Who decides |
|---|---|---|---|
| → **started** | Session takes on the issue | Session ↔ issue **linkage** | Deterministic (ShipIt) |
| → **completed** | Finishing PR merges | The merged PR **body** (`Closes <pointer>`) | Agent (per-PR) |

This split is what makes the multi-PR case fall out for free. The close decision
lives in the PR body — the exact artifact where the agent already declares what a
PR does — so "this PR finishes the issue" is a one-line, per-PR choice, not a
piece of session state the agent has to remember to flip.

### → started: deterministic, from linkage

A session becomes **issue-linked** through one of two paths. The moment linkage is
established, ShipIt sets the issue to `started` (brokered, idempotent — a no-op if
already started) and records the pointer as `issueRef` on the session.

- **Seed path (UI / tracker trigger).** When the session is created *from* an
  issue — the docs/156 push trigger, or a future "work on this issue" button /
  the docs/168 Issues tab — the `issueRef` is known at creation. This reuses the
  existing `headless-sessions.create({ issueRef })` seeding primitive. ShipIt
  marks `started` at session creation; no agent involvement.

- **Attach path (agent).** When a session was *not* seeded from an issue but the
  agent determines mid-session that it's implementing one (e.g. the user pasted a
  pointer in chat), the agent calls a new **`shipit issue attach <pointer>`**.
  This records `issueRef` on the session **and** marks `started` in one step. It
  is the explicit, discoverable counterpart to the seed path.

Marking `started` is low-risk and reversible (it's a soft signal, and 177 gives
every write an Undo card), so doing it deterministically — rather than hoping the
agent remembers — is the right call. This revisits docs/156's "behind explicit
user action" non-goal: seeding from a trigger/button *is* the explicit user
action; the attach call is the agent's explicit action. Neither is a silent
side-effect.

> **Why linkage need not precede turn 1.** An earlier framing worried that
> deterministic `started` requires the link before the first turn. It doesn't:
> `started` fires *when linkage is established*, from whichever path. Seed path
> establishes it at creation; attach path establishes it mid-session. There is no
> chicken/egg.

### → completed: agent-declared in the PR body, ShipIt-executed on merge

When the agent judges that a PR **fully resolves** the issue, it includes a
closing line in the PR body:

```
Closes SHI-43
```

The pointer is in the **tracker-neutral** form `shipit issue` already
understands (`SHI-43`, `owner/repo#42`, or a full issue URL). Synonyms
`Closes` / `Fixes` / `Resolves` are all accepted.

On merge detection (`pr-status-poller.ts` → `onMergeDetectedCb`), ShipIt:

1. Fetches the merged PR body (already available on the merge path).
2. Parses it for `Closes/Fixes/Resolves <pointer>` lines.
3. For each pointer, calls the brokered `status completed` + posts a summary
   comment via the `Tracker` adapter — the same brokered write as 177, surfacing
   the same provenance card.

If the PR body has **no** closing line, nothing happens — the issue stays
`started`. That is the multi-PR case: intermediate PRs simply don't carry
`Closes`, so a merge of PR 1-of-3 leaves the issue open; the agent adds `Closes`
only to the PR that finishes the work.

If the PR is **closed unmerged**, no transition fires (we only act on
`merged_at`).

#### Why ShipIt parses it, not GitHub's native keyword closing

GitHub *does* natively close a same-repo issue from `Closes #N` on merge to the
default branch — but we deliberately do **not** rely on that:

- **Tracker-neutrality.** Native closing only works for same-repo GitHub issues.
  Linear (and cross-repo GitHub) get nothing. Parsing the body ourselves and
  routing through the `Tracker` interface gives one uniform behavior across
  trackers — the whole point of `shipit issue` (docs/177 §1).
- **Containment + provenance.** The brokered path keeps the tracker token
  orchestrator-side (docs/172/177) and produces the do-then-surface card with
  Undo. A native close is invisible inside ShipIt and bypasses the provenance
  envelope.
- **The summary comment.** We want a "resolved by PR #N" comment on the issue,
  not just a state flip. That's a brokered write regardless.

For a same-repo GitHub issue, GitHub's native close and ShipIt's brokered close
may both fire — that's harmless (closing a closed issue is a no-op) and ShipIt's
comment + card still add the value. We don't depend on the native behavior; it's
just a benign duplicate.

### Where this respects the multi-PR thread

docs/156's insight was that the **issue** is the cross-PR coordination log. This
design leans into it:

- Every merged PR can `reportPrMerged` a progress comment on the issue (156's
  existing hook), regardless of whether it closes.
- Only the PR carrying `Closes` flips the status.

So a feature shipping as refactor → feature → cleanup PRs leaves a readable trail
on the issue, and the issue closes exactly once, when the agent says it's done.

## Agent-facing guidance (the prompt half)

Two small additions, since the agent is half the system:

- **`shipit-docs/issues.md` + the system prompt (`agent-instructions.ts`):**
  document `shipit issue attach <pointer>` and the convention that a `Closes
  <pointer>` line in a PR body closes the issue on merge — and that **omitting**
  it is how you signal "more PRs to come."
- **The PR-creation guidance** already tells the agent to write a structured PR
  body; we extend it: if this PR fully resolves a tracked issue, add a `Closes
  <pointer>` line; if it's partial, reference the issue without the closing
  keyword.

The prompt makes the agent *use* the workflow; the deterministic `started` and
the merge-time parse make the workflow *reliable* even when the agent forgets.

## Key files (anticipated)

- `src/server/orchestrator/pr-status-poller.ts` — `onMergeDetectedCb` path; where
  the merged PR body is parsed for closing pointers.
- `src/server/orchestrator/app-lifecycle.ts:756` — the existing merge callback
  wiring; the close-on-merge execution hangs off here, before/alongside
  `markMergedAndPruneExcess`.
- `src/server/orchestrator/services/issues.ts` + `trackers/tracker.ts` — brokered
  `status`/`comment` writes (docs/177) reused for the completion transition.
- `src/server/session/agent-shim/shipit.ts` + `api-routes-issues.ts` +
  `services/issues.ts` — the new `attach` subcommand (records `issueRef` + marks
  started).
- `src/server/orchestrator/sessions.ts` + `shared/types/domain-types.ts` —
  `issueRef` field on session metadata (today there is none).
- `src/server/orchestrator/agent-instructions.ts` +
  `src/server/shipit-docs/issues.md` — agent guidance for `attach` and the
  `Closes <pointer>` convention.
- `docs/156-issue-to-session` — `headless-sessions.create({ issueRef })` seeding
  primitive and the `IssueTrackerProvider.reportPrMerged` hook this builds on.

## Open questions

- **Pointer parsing precedence.** If a PR body lists multiple `Closes` pointers,
  close all of them — assume that's intentional (one PR finishing several small
  issues). Confirm.
- **Native GitHub double-close.** Accept the benign duplicate (above), or instruct
  the agent to use the tracker-neutral pointer form (`owner/repo#42`) rather than
  bare `#42` so GitHub's native parser doesn't also fire? Leaning: accept the
  duplicate, it's a no-op.
- **`started` on seed but no work done.** A session seeded from an issue that the
  user then abandons will have marked the issue `started`. Acceptable (started is
  soft and Undo-able), or should `started` wait for the first agent turn rather
  than session creation?
- **Reopen on revert.** Out of scope for v1; if a closing PR is later reverted, the
  issue is not reopened automatically.
