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

### Two transitions, two different sources of truth — and **no session state**

The key structural decision: **started** and **completed** are driven by
different signals, and deliberately so. The second key decision: **ShipIt never
stores the issue on the session.** Each transition needs the pointer only at the
instant it acts, and at that instant the pointer is already in hand — so there is
no `issueRef` field, no metadata migration, and no session↔issue record to keep
in sync.

| Transition | Trigger | Source of truth | Who acts |
|---|---|---|---|
| → **started** | Session takes on the issue | The seed payload (creation) **or** the agent's own judgment | ShipIt one-shot (seeded) / agent (non-seeded) |
| → **completed** | Finishing PR merges | The merged PR **body** (`Closes <pointer>`) | ShipIt parses & brokers, agent decided per-PR |

This split is what makes the multi-PR case fall out for free. The close decision
lives in the PR body — the exact artifact where the agent already declares what a
PR does — so "this PR finishes the issue" is a one-line, per-PR choice, not a
piece of session state the agent has to remember to flip.

### → started: a one-shot at seed-time, otherwise the agent's own call

There is nothing to "link." The issue moves to `started` one of two ways, neither
of which persists anything:

- **Seed path (UI / tracker trigger) — deterministic.** When the session is
  created *from* an issue (the docs/156 push trigger, a future "work on this
  issue" button, or the docs/168 Issues tab), ShipIt already holds the pointer in
  the creation payload. It fires a single brokered `status started` right there at
  session creation and is done — the pointer is not stored, because nothing later
  needs it. Idempotent (a no-op if already started). No agent involvement.

- **Non-seeded — the agent's call.** A session that wasn't created from an issue
  gives ShipIt no pointer to act on, so there's nothing deterministic to do. When
  the agent determines it's implementing an issue (e.g. the user pasted a pointer
  in chat), it simply runs the **existing** `shipit issue status <pointer>
  started` (docs/177). No new subcommand, no session field — just the brokered
  write that already exists, on agent initiative.

Marking `started` is low-risk and reversible (it's a soft signal, and 177 gives
every write an Undo card). This revisits docs/156's "behind explicit user action"
non-goal: seeding from a trigger/button *is* the explicit user action; the agent's
`status started` is its explicit action. Neither is a silent side-effect, and
neither leaves ShipIt holding session-issue state.

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
3. For **every** pointer found, calls the brokered `status completed` + posts a
   summary comment via the `Tracker` adapter — the same brokered write as 177,
   surfacing the same provenance card. Multiple closing lines are all honored
   (one PR may legitimately finish several small issues).

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
  tell the agent to run `shipit issue status <pointer> started` when it begins
  implementing an issue that ShipIt didn't already mark (the non-seeded case), and
  document the convention that a `Closes <pointer>` line in a PR body closes the
  issue on merge — and that **omitting** it is how you signal "more PRs to come."
- **The PR-creation guidance** already tells the agent to write a structured PR
  body; we extend it: if this PR fully resolves a tracked issue, add a `Closes
  <pointer>` line; if it's partial, reference the issue without the closing
  keyword.

The prompt makes the agent *use* the workflow; the deterministic seed-time
`started` and the merge-time parse make the workflow *reliable* even when the
agent forgets — without ShipIt holding any session-issue state of its own.

## Key files (anticipated)

Note how short this is — no session-metadata changes, no new CLI verb.

- `src/server/orchestrator/pr-status-poller.ts` — `onMergeDetectedCb` path; where
  the merged PR body is parsed for closing pointers.
- `src/server/orchestrator/app-lifecycle.ts:756` — the existing merge callback
  wiring; the close-on-merge execution hangs off here, before/alongside
  `markMergedAndPruneExcess`.
- `src/server/orchestrator/services/issues.ts` + `trackers/tracker.ts` — brokered
  `status`/`comment` writes (docs/177), reused **as-is** for both transitions
  (seed-time `started`, merge-time `completed`). No new write surface.
- Session creation path (docs/156 trigger / docs/168 Issues tab / a "work on this
  issue" action) — fires the one-shot `status started` from the pointer in the
  creation payload. The pointer is consumed, not persisted.
- `src/server/orchestrator/agent-instructions.ts` +
  `src/server/shipit-docs/issues.md` — agent guidance: call `status started` when
  starting non-seeded issue work, and the `Closes <pointer>` PR-body convention.
- `docs/156-issue-to-session` — the `IssueTrackerProvider.reportPrMerged` hook and
  trigger flow this builds on.

## Decisions (resolved)

- **No session-stored linkage.** ShipIt does not keep an `issueRef` on the
  session. `started` is a one-shot at seed-time (or the agent's own `status`
  call); `completed` reads the PR body. Neither needs persisted state. *(This is
  the simplification that removed the metadata migration and the `attach`
  subcommand from an earlier draft.)*
- **`started` fires at session creation** for seeded sessions, not at first agent
  turn. If a seeded session is then abandoned, the issue is left `started` — an
  acceptable soft, Undo-able state.
- **Multiple `Closes` pointers → close all of them.** One PR may finish several
  small issues; each gets `completed` + a comment.
- **GitHub native double-close → accept it.** For a same-repo GitHub issue,
  GitHub's native keyword close and ShipIt's brokered close may both fire. It's a
  no-op duplicate and ShipIt still adds the comment + provenance card; we don't
  special-case it.
- **No reopen on revert (v1).** If a closing PR is later reverted, the issue is not
  reopened automatically; the user reopens manually. Revisit if it comes up.
