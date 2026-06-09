---
description: A human-gated consent card that creates a Linear issue to track a design doc and closes the loop — the agent proposes, the user confirms, ShipIt creates the issue and hands the URL back so the agent writes the issue:/ frontmatter, no copy-paste.
---

# Tracking-issue creation card

## Goal

When the agent creates a design doc (`docs/NNN-*/plan.md`) that has **no `issue:`
pointer**, ShipIt should let the user create a Linear issue to track it **without
leaving the chat** and **without a manual copy-paste round-trip** — then
automatically cross-link the doc by writing the new issue URL into its frontmatter.

This closes the gap called out in `CLAUDE.md` (Docs structure → "Keep the tracker
in sync when you touch a design doc"). Today that rule describes a manual
round-trip, because issue *creation* is human-gated and the agent gets no signal
when an issue is created out-of-band:

> the agent proposes a Linear title/body in chat → the user creates the issue in
> Linear themselves → the user pastes the URL back → on *that* turn the agent writes
> the frontmatter.

The two weak points are (1) the user has to leave ShipIt to create the issue, and
(2) the agent only learns the URL because the user pastes it back. This feature
removes both: creation happens through an inline consent card, and the URL is
handed back to the agent programmatically.

## Why this stays human-gated

Issue creation is a **deliberate human action** across the codebase — `shipit issue
create` is rejected in the shim, and both `docs/164` (bug filing) and `docs/177`
(agent issue writes → "Out of scope: creating issues") route creation through a
**consent card**, never an unprompted agent call. This feature does **not** change
that posture:

- The agent never creates an issue directly. It **proposes** a draft (title/body)
  and the card is the gate. Identical consent model to `docs/164`.
- The `shipit issue create` shim subcommand stays **rejected**. Creation is a
  card-confirmed WS action, not a shell verb the agent can invoke at will.

So this is the `docs/164` consent pattern applied to a second destination (the
deployment's own Linear workspace, to track a design doc) — plus a loop-close step
that `docs/164` doesn't need.

## Design

Three pieces: a propose path (agent → card), a create path (confirm → Linear), and
a loop-close (created → agent writes frontmatter).

### 1. Propose — agent drafts, card gates

Mirroring `report_shipit_bug` (`docs/164`): the agent calls a new
`propose_tracking_issue` WS message with `{ docPath, title, body }` when it has
just written/updated a doc that has no `issue:` pointer. The handler emits a
**consent card** (`tracking_issue_card`) into the transcript. The tool proposes; it
does **not** create.

```
┌─ Create a Linear issue to track this doc ──────────────────┐
│ Doc:    docs/187-tracking-issue-card/plan.md               │
│ Team:   ShipIt (SHI)                          ← bound team │
│ Title:  [ Tracking-issue creation card                  ]  │
│ Body — editable:                                           │
│ ┌────────────────────────────────────────────────────────┐│
│ │ Tracks docs/187-tracking-issue-card/plan.md.           ││
│ │ <one-line description from the doc>                     ││
│ └────────────────────────────────────────────────────────┘│
│ Created in Linear as the workspace token · not per-user    │
│ Nothing is created until you click Create.                 │
│            [ Cancel ]              [ Create issue ]         │
└────────────────────────────────────────────────────────────┘
```

- **Editable title/body**, same WYSIWYG-consent principle as `docs/164`: what's in
  the box is what gets filed.
- **Team is fixed, not a picker.** The Linear adapter is already bound to a single
  team (`config.team` with `{ id, key, name }` in `trackers/linear/adapter.ts`), so
  the creation target is unambiguous — it's the same team the read/write path
  already uses. The card shows the team for transparency but doesn't ask the user
  to choose. If Linear isn't configured (no token/team binding,
  `isConfigured() === false`), the agent's `propose_tracking_issue` is refused with
  a "connect Linear in Settings first" message and no card is emitted.

### 2. Create — `Tracker.createIssue` (new), Linear-backed

On **Create**, a `submit_tracking_issue` WS message runs the creation server-side
through the tracker registry. This needs a **new method on the `Tracker`
interface**, because the only existing `createIssue` (`github-auth-issues.ts`,
`docs/164`) is GitHub-only and hard-wired to the `nicolasalt/shipit` upstream repo
— not reusable for an arbitrary Linear workspace.

```ts
interface Tracker {
  // …existing read (docs/175) + write (docs/177) methods…
  createIssue(input: { title: string; body: string }): Promise<TrackerIssue>;
}
```

- **Linear** (`trackers/linear/adapter.ts`): a `issueCreate` GraphQL mutation
  against `this.team.id`, returning the created issue's `identifier` + `url`. Reuses
  the existing `linearGraphql()` transport — same pattern as `addComment`/
  `updateIssue` from `docs/177`.
- **GitHub** adapter: `createIssue` throws `not-supported` for now. GitHub-issue
  creation for design docs is out of scope (the `docs/164` path already files
  GitHub issues, but only against the fixed upstream repo for bug reports; creating
  issues on the *session's* repo is a separate decision, deferred). The card is
  Linear-only, matching the `CLAUDE.md` rule ("create a **Linear** issue … unless
  it is connected to a GitHub issue").
- **Attribution caveat (inherited from `docs/177`).** The Linear token is a single
  deployment-wide PAT (`CredentialStore`), so the created issue is attributed to the
  PAT owner — the workspace, not the acting user. The card says so ("Created in
  Linear as the workspace token · not per-user"). This is a known limitation, not a
  bug; true per-user Linear attribution needs per-user Linear auth (out of scope,
  same as `docs/177`).

Brokering path is identical in shape to `docs/177` writes:

```
submit_tracking_issue (WS) → service createTrackingIssueForTracker()
  → TrackerRegistry.get('linear').createIssue({ title, body })
  → returns { identifier, url }
```

Token stays in `CredentialStore`, orchestrator-side; only the result returns toward
the session. (No `/agent-ops/issue/create` relay is added — the agent never calls
create; it's a card-confirmed orchestrator action, so it lives behind a WS handler,
not the shim.)

### 3. Loop-close — hand the URL back to the agent

This is the piece neither `docs/164` nor `docs/177` has. After the issue is created,
the doc still needs its `issue:` frontmatter written. We do **not** edit the file
server-side (the agent is the actor that owns workspace edits, and frontmatter
insertion is fiddly across the various doc shapes; a server edit would also need its
own commit path outside the post-turn auto-commit machinery). Instead we **start a
fresh agent turn** seeded with the result, reusing the same primitive the CI-fix
flow uses:

```ts
runner.dispatch({
  text: `The Linear issue ${identifier} was created at ${url} to track ${docPath}. ` +
        `Add it to that doc's frontmatter as \`issue: ${url}\` (full URL, no title slug), ` +
        `then stop.`,
  activity: "Cross-linking issue…",
});
```

`runner.dispatch` already "enqueues when busy, emits a `system_turn` event for WS
handler pickup when idle" (see `services/github-ci-fix.ts`), so the cross-link turn
slots in safely whether or not the session is mid-turn. The agent edits the
frontmatter, and the **existing post-turn flow** (`postTurnCommit` →
`scheduleAutoPush` → PR card) commits and pushes it — no new commit path. The card
transitions to its terminal "Created — SHI-NN" state.

This is the automation of step 3 of the manual round-trip: ShipIt "pastes the URL
back" on the user's behalf, as a system turn, instead of the user doing it by hand.

> **Decision to confirm:** loop-close as an agent turn (model writes the
> frontmatter) vs. a deterministic server-side frontmatter edit relayed to the
> worker. The plan picks the agent turn for principle-fit (agent is the actor) and
> commit-machinery reuse, at the cost of one model turn. See Open questions.

### Persistence & replay

The card is a side-channel artifact (it arrives via the `propose_tracking_issue`
relay, not the agent-event stream), so it follows the established card-persistence
pattern (`CLAUDE.md` "Chat transcript content MUST be persisted", the voice-note /
bug-report precedent):

- The proposing turn emits the card via `emitChatCard` (`chat-card-persistence.ts`),
  anchored by `afterGroupIndex`, so it interleaves at its true transcript position
  and survives reconnect **and** reload.
- A `PersistedMessage.trackingIssue` field (+ column + `toRow`/`fromRow` +
  `database.ts` migration) carries the payload + phase
  (`proposed` → `created` | `failed` | `canceled`).
- The `created`/`failed` transition patches the persisted record in place
  (`updateTrackingIssueCard`), like `updateBugReportCard`.
- `loadSessionHistory` seeds the client store from persisted cards; the live append
  and the store upsert are idempotent-by-id so reconnect-buffer replay and history
  replay never double-render or clobber a terminal state.

## Relationship to the `CLAUDE.md` rule

This feature **replaces the no-issue branch** of the Docs-structure rule once
shipped. Today that branch reads "propose in chat → manual round-trip." After this
lands, it becomes: the agent calls `propose_tracking_issue`, the user confirms the
card, and the cross-link is automatic. Updating that `CLAUDE.md` paragraph is a
checklist item gated on this feature merging — not done now, because the capability
doesn't exist yet and the instructions must match reality.

## Why not (rejected / deferred)

- **Unblock `shipit issue create` in the shim.** Rejected — it would let the agent
  create issues unprompted, breaking the human-gating invariant that `docs/164` and
  `docs/177` both rest on. Creation stays card-confirmed.
- **Server-side frontmatter edit instead of an agent turn.** Deferred (see Open
  questions). Deterministic and saves a turn, but the orchestrator editing workspace
  files sidesteps the agent-as-actor model and needs a bespoke commit path outside
  post-turn auto-commit.
- **GitHub-issue creation for design docs.** Deferred — the `CLAUDE.md` rule is
  Linear-only for the no-issue case, and creating issues on the session's own repo
  is a separate decision with its own attribution/permission questions.
- **A "Create tracking issue" button.** Shell-shaped affordance (`CLAUDE.md` §5).
  The agent proposes in chat; the card is the gate.

## Reconciliation with existing work

| Existing | Relationship |
|---|---|
| `docs/164` user bug filing | **Consent-card precedent, reused.** Same propose → confirm → create → persisted-card lifecycle. Different destination (workspace Linear vs. upstream GitHub) and adds a loop-close turn `164` doesn't need. |
| `docs/177` agent issue writes | **Interface sibling.** Adds `createIssue` to the `Tracker` interface alongside `addComment`/`updateIssue`/`setStatus`/`setAssignee`; same brokering shape and Linear-PAT attribution caveat. `177` explicitly left creation out of scope — this is where it lands, gated by a card. |
| `docs/170` tracker registry | **Extended.** Adds the create mutation to the Linear adapter and the `Tracker` interface in the same registry. |
| `services/github-ci-fix.ts` | **Loop-close precedent.** `runner.dispatch({ text, activity })` (enqueue-or-system-turn) is the mechanism for the cross-link turn. |

## Open questions

- **Loop-close mechanism:** agent turn (chosen here) vs. deterministic server-side
  frontmatter edit relayed to the worker file-write endpoint. The agent turn fits
  the principles and reuses post-turn commit; the server edit is cheaper and
  deterministic but needs its own commit path. Confirm before building.
- **Team selection when a deployment binds more than one Linear team.** The adapter
  is single-team today, so there's no ambiguity now; revisit only if multi-team
  binding is added.
- **Should the initial issue body seed from the doc automatically** (description +
  first paragraph) or stay a blank-ish draft the agent fills? Leaning auto-seed from
  the doc's `description` frontmatter + first section.

## Key files (anticipated)

- `src/server/orchestrator/trackers/tracker.ts` — add `createIssue` to the interface.
- `src/server/orchestrator/trackers/linear/adapter.ts` — `issueCreate` mutation against the bound team.
- `src/server/orchestrator/trackers/github/adapter.ts` — `createIssue` → not-supported.
- `src/server/orchestrator/services/issues.ts` — `createTrackingIssueForTracker()`.
- `src/server/orchestrator/ws-handlers/` — `propose_tracking_issue` (draft) and `submit_tracking_issue` (confirm + create + `runner.dispatch` loop-close) handlers.
- `src/server/shared/types/ws-server-messages.ts` / `ws-client-messages.ts` — `tracking_issue_card`, `tracking_issue_created`, `tracking_issue_failed`, `submit_tracking_issue`, `propose_tracking_issue`.
- `src/server/orchestrator/agent-instructions.ts` — teach the agent to call `propose_tracking_issue` for a no-issue doc (ShipIt-repo behavior is also in `CLAUDE.md`).
- `chat-card-persistence.ts`, `chat-history.ts`, `database.ts`, `session-data.ts` — persist + rehydrate the card; `PersistedMessage.trackingIssue` + migration.
- `src/client/components/TrackingIssueCard.tsx` (new) — the inline consent card.
- `src/server/orchestrator/integration_tests/tracking-issue-card.test.ts` (new) — propose → card persisted; create only after confirm; loop-close dispatches a turn; Linear-unconfigured path refuses.
- `CLAUDE.md` — update the Docs-structure no-issue branch once shipped (checklist-gated).
