---
issue: https://linear.app/shipit-ai/issue/SHI-99
description: Let the agent create tracker issues directly via `shipit issue create`, surfaced as a do-then-surface provenance card with undo — the same model docs/177 uses for every other issue write. Closes the design-doc cross-link loop in one turn.
---

# Agent issue creation

## What this decides

The agent can **create** a tracker issue directly, the same way it already
comments on / edits / re-statuses / re-assigns one (docs/177): it runs the verb,
the write happens immediately, and an inline **do-then-surface provenance card**
records it with an **undo**. Creation is no longer gated behind a confirmation
card.

> Issue creation goes through the unified `shipit issue create` verb, brokered
> orchestrator-side like every other `shipit issue` write, and surfaced as an
> `IssueWriteCard` with undo = delete/cancel the created issue.

This **supersedes** the prior "creation stays human-gated" stance that docs/164
and docs/177 carried, and replaces the consent-card-plus-loop-close design this
doc previously held. The user decided that creating an issue in the workspace's
*own* configured tracker is a low-stakes write, indistinguishable in risk from the
other writes docs/177 already lets the agent make unprompted — so it gets the same
do-then-surface treatment, not a special gate.

### Why direct creation is fine here (and bug-filing still isn't)

The human-gating in docs/164 exists because that flow is **outbound to a public
repo, attributed to the user's real GitHub identity, and needs redaction** — a
genuinely irreversible, identity-bearing, external act. Creating a tracking issue
in the deployment's *own* Linear workspace is none of those things: it's internal,
attributed to the workspace PAT (not a public identity), and trivially reversible
(delete/cancel). It belongs with the docs/177 writes, not with bug-filing.

- **docs/164 (bug filing) is unchanged** — still a redacted, human-gated consent
  card, because it's outbound-to-public.
- **docs/177's "creation out of scope / human-gated" line is superseded** — creation
  joins the do-then-surface write family.

## Design

### The verb

Unblock `create` in the `shipit issue` shim and add it alongside the docs/177
writes:

```
shipit issue create --title T --body B | --body-file FILE [--tracker linear|github] [--json]
```

- Returns the new issue's `identifier` and `url` on stdout (and `--json` the raw
  object), **synchronously, in the same turn** — exactly like `shipit issue
  comment` returns its result. This is what makes the design-doc cross-link a
  one-turn operation (see below); no system-turn loop-close is needed anymore.
- **Tracker defaults to the deployment's bound tracker.** For the design-doc use
  case that's Linear (the adapter is bound to a single team, `config.team`), so
  `--tracker` is usually omitted. `--tracker github` creates on **this session's
  repo** (the same repo `shipit issue view owner/repo#N` reads from).
- If the chosen tracker isn't configured (`isConfigured() === false`), the verb
  fails with a "connect <tracker> in Settings first" message — no issue, no card.

### `Tracker.createIssue` (new interface method)

Add creation to the unified `Tracker` interface, next to docs/177's write methods:

```ts
interface Tracker {
  // …existing read (docs/175) + write (docs/177) methods…
  createIssue(input: { title: string; body: string }): Promise<TrackerIssue>;
}
```

- **Linear** (`trackers/linear/adapter.ts`): an `issueCreate` GraphQL mutation
  against `this.team.id`, returning the created issue's `identifier`, `id`, and
  `url`. Reuses the existing `linearGraphql()` transport — same shape as
  `addComment`/`issueUpdate`.
- **GitHub** (`trackers/github/adapter.ts`): `POST issues` on the session's repo
  via the adapter's injectable `fetchImpl` (the docs/177 testable-against-a-fake
  pattern), returning the new issue's number + url. (Distinct from the
  `github-auth-issues.ts` `createIssue`, which is hard-wired to the upstream repo
  for bug-filing and stays as-is.)

The only existing `createIssue` is the bug-filing one (GitHub-only, upstream-repo
hard-coded), so this is genuinely new on the tracker interface.

### Do-then-surface — extend the docs/177 `IssueWriteCard`

Creation reuses the docs/177 provenance-card stack rather than introducing a new
card type. The minimal extension:

- `IssueWriteVerb` gains `"create"` (currently `"comment" | "edit" | "status" |
  "assignee"`).
- `IssueWriteUndo` gains `{ kind: "create"; issueId: string }` — the undo snapshot
  for a create is just the new issue's tracker-internal id.
- **Undo = cancel the creation.** Reverse-write per tracker: Linear → move the issue
  to its `canceled` state (or archive); GitHub → close as `not_planned`. (We cancel
  rather than hard-delete: Linear's API archives, and GitHub issues can't be
  deleted via the REST API, so "cancel/close" is the portable, honest reverse —
  the card says "Canceled SHI-28", not "Deleted".)
- `summary` = `"created SHI-28"`; `attribution` = `"workspace"` for Linear (the
  deployment PAT), `"user"` for GitHub (the acting user's token) — same caveat
  wording docs/177 already encodes.

Everything else is inherited unchanged: `emitChatCard` persistence, the
`PersistedMessage` issue-write field + migration, `updateIssueWriteCard` for the
undo lifecycle, `issue-write-store` rehydration, idempotent-by-`cardId` replay, and
the `TrackingIssueCard`→ no, the existing `IssueWriteCard` client component (just a
new verb label).

### Brokering path (same shape as docs/177 writes)

```
shipit issue create → worker POST /agent-ops/issue/create (allowlisted, injects
  trusted SESSION_ID) → orchestrator POST /api/sessions/:id/issue/create
  → createIssueForTracker() service → TrackerRegistry.get(tracker).createIssue()
  → returns { identifier, url }; emits + persists the IssueWriteCard (verb: create)
```

The Linear/GitHub token stays in `CredentialStore`, orchestrator-side; only the
created issue's identifier/url returns toward the container. Unlike the other
writes, `createIssue` captures **no prior-state snapshot** (there's nothing to
snapshot) — the undo target is the new issue's own id.

### Design-doc cross-link — now one turn

Because `shipit issue create` returns the URL synchronously, the `CLAUDE.md`
design-doc rule's no-issue branch collapses to a single turn with **no round-trip
and no system-turn loop-close**:

1. Agent writes/updates a `docs/NNN-*` doc with no `issue:` pointer.
2. Agent runs `shipit issue create --title "<doc title>" --body-file - <<'EOF' … EOF`
   (defaults to the bound Linear team).
3. Agent reads the returned URL from stdout and writes it into the doc's `issue:`
   frontmatter (full URL, no slug).
4. The provenance card surfaces "created SHI-NN" with undo; post-turn auto-commit
   carries the frontmatter edit.

This is the whole reason the earlier consent-card + `runner.dispatch` loop-close
design is no longer needed: a synchronous brokered create makes the agent the
actor end-to-end within one turn.

## Doc & prompt updates

- **`src/server/shipit-docs/issues.md`** — remove "Create issues … is rejected" from
  "What you can't do"; document `shipit issue create` under "Writing
  (do-then-surface)" with the do-then-surface + undo note and the attribution
  caveat. This file ships to **every** repo's container, so it documents the
  capability generically (not the ShipIt-design-doc convention).
- **`CLAUDE.md`** (this repo only) — rewrite the Docs-structure no-issue branch from
  the manual round-trip to: "create the Linear issue directly with `shipit issue
  create` and write the returned URL into the doc's `issue:` frontmatter in the same
  turn." The comment-on-attached-issue branch is unchanged.
- **`src/server/orchestrator/agent-instructions.ts`** — no consent-card prompt needed;
  the verb is self-describing via `issues.md`.

## Rejected / superseded

- **Consent card + `runner.dispatch` loop-close** (this doc's previous design) —
  superseded. Direct synchronous creation removes the need for both a confirmation
  gate and a follow-up system turn.
- **Keeping `shipit issue create` rejected** — reversed by user decision; creation
  joins the do-then-surface write family.
- **Hard-delete on undo** — not portable (GitHub can't delete via REST; Linear
  archives). Undo cancels/closes instead, and the card says so.
- **A new card type for creation** — unnecessary; the docs/177 `IssueWriteCard`
  extends cleanly with a `create` verb.

## Reconciliation with existing work

| Existing | Relationship |
|---|---|
| `docs/177` agent issue writes | **Directly extended.** `createIssue` joins the `Tracker` interface and the `IssueWriteCard`/undo stack; same brokering, same persistence, same Linear-PAT attribution caveat. The only addition is the `create` verb + cancel-on-undo. |
| `docs/175` agent issue reads | Foundation — `parseIssueRef`, the `/agent-ops/issue/*` relay shape, session-scoped routes. |
| `docs/170` tracker registry | **Extended** with the create mutation in the Linear adapter (and GitHub). |
| `docs/164` user bug filing | **Unchanged and distinct.** Bug-filing stays a redacted, human-gated, outbound-to-public consent card. This is internal-tracker creation, do-then-surface. The two no longer share the "all creation is human-gated" premise — that premise is narrowed to the bug-filing case it was really about. |

## Resolved decisions

- **Undo cancels (not archive).** Linear → `canceled` state, GitHub → close as
  `not_planned`. Visible, honest ("Canceled SHI-28"), and symmetric across
  trackers. Implemented via `tracker.setStatus(card.issueId, "canceled")` in the
  `create` undo branch. **Fallback:** a Linear team may have no `canceled`-type
  state, in which case `setStatus("canceled")` throws `TrackerResolutionError`;
  the undo branch then retries with `completed` so the created issue is closed
  rather than stranded with a dead Undo. (GitHub always resolves `canceled`, so
  the fallback only fires for Linear.)
- **`create` defaults to Linear.** There's no pointer to infer a tracker from, and
  Linear is the workspace-wide tracker and the design-doc convention. `--tracker
  github` files on the session's repo instead. An unconfigured tracker fails with a
  "connect it in Settings" message rather than silently filing elsewhere.
- **The returned Linear URL is slug-free, enforced server-side.** Linear's API
  appends a title-derived slug to issue URLs (`…/issue/SHI-28/redesign-the-auth-flow`).
  The adapter's `stripLinearUrlSlug` normalizes every `TrackerIssue.url` to the
  canonical `…/issue/SHI-28` form, so the URL the agent receives (and writes into a
  doc's `issue:` frontmatter, per step 3 of the cross-link flow) never leaks the
  issue title and matches the pointer shape `parseIssueRef` treats as canonical.
  This is a single chokepoint in `toTrackerIssue`, so it also covers `view`/`edit`/
  the Issues tab — not just `create`. Stripping is safe: Linear resolves the
  slug-free URL and redirects to the full one.

## Status — implemented

Shipped in this PR. The `create` verb extends the docs/177 `IssueWriteCard` (new
`IssueWriteVerb` member + `{ kind: "create" }` undo), so persistence, rehydration,
and the client card are inherited with no migration. Coverage: Linear/GitHub
adapter `createIssue`, the `createIssueForTracker` service + `create` undo branch,
the shim `create` verb (defaults to Linear, requires `--title`), and the
shim→relay→route slice asserting create is no longer gated.

## Key files

- `src/server/orchestrator/trackers/tracker.ts` — `createIssue` on the interface.
- `src/server/orchestrator/trackers/linear/adapter.ts` — `issueCreate` mutation against the bound team.
- `src/server/orchestrator/trackers/github/adapter.ts` — `createIssue` (POST issues) on the session repo.
- `src/server/orchestrator/services/issues.ts` — `createIssueForTracker()`; `undoIssueWrite` `create` branch (cancel).
- `src/server/orchestrator/api-routes-issues.ts` — session-scoped `POST /issue/create` route (card `issueId` falls back to the created issue's id).
- `src/server/session/agent-ops-routes.ts` — `POST /agent-ops/issue/create` relay.
- `src/server/session/agent-shim/shipit.ts` — `shipit issue create` verb; `create`/`new` removed from `REJECTED_ISSUE_SUBCOMMANDS`.
- `src/server/shared/types/domain-types.ts` — `IssueWriteVerb += "create"`, `IssueWriteUndo += { kind: "create" }`.
- Persistence/client (`chat-history.ts`, `issue-write-store.ts`, `IssueWriteCard.tsx`) — **inherited unchanged**: the card persists as JSON and renders `Agent {summary}` generically, so the new verb needs no migration or component change.
- `src/server/shipit-docs/issues.md` — documents `shipit issue create`; drops the "can't create" line.
- `CLAUDE.md` — design-doc no-issue branch now creates + cross-links directly.
- Tests: `shipit.test.ts` (create defaults/validation), Linear/GitHub adapter create, `issues.test.ts` (create + undo-cancel), `agent-issue-access.test.ts` (gate-removed slice).
