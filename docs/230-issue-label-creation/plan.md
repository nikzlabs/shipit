---
issue: https://linear.app/shipit-ai/issue/SHI-232
description: Let the agent create tracker labels — `shipit issue label create` plus an opt-in `--create-missing-labels` on create/edit — as do-then-surface writes whose Undo deletes the label while it's still unused.
---

# Issue label creation

## Problem

`--label` on `shipit issue create`/`edit` resolves against the tracker's
**existing** labels and rejects unknown names (SHI-92) — deliberately, so a typo
can't spawn a stray label. But the rejection was a dead end: when the label
genuinely didn't exist (`shipit issue create --label t3code …` → `No Linear
label matches "t3code". Valid label options: …`) there was **no way to create
it from ShipIt**. The user had to open the Linear/GitHub UI, create the label
by hand, and re-run — a link-out on the happy path, which CLAUDE.md §1/§2
treats as a product failure. The agent is the actor; minting a label in the
workspace's own tracker is exactly the kind of low-stakes, reversible write
docs/187 already established for issue creation itself.

## Design

Two additions, both riding the existing docs/177 write stack (brokered through
the orchestrator — tracker tokens never enter the container — with a
do-then-surface provenance card and Undo):

### 1. `shipit issue label create`

```
shipit issue label create --name NAME [--color '#rrggbb'] [--description TEXT] [--tracker github|linear] [--json]
```

- Tracker-neutral; **defaults to Linear** (no pointer to infer from, same rule
  as `issue create`). `--tracker github` creates a repo label on the session's
  repo.
- `label` is a verb *group* (future label verbs can slot in) but only `create`
  exists — there is deliberately no `label delete`/`edit`; listing stays on the
  existing `shipit issue labels`.
- A same-name label already existing (case-insensitive) is a **409** — nothing
  is created, so re-runs can't fork casing variants.
- The shim validates `--color` (`#?rrggbb`) before the round-trip; adapters
  renormalize per tracker API (Linear wants `#rrggbb`, GitHub wants bare hex).

### 2. `--create-missing-labels` on `create`/`edit`

Opt-in flag: unknown `--label` names are created **before** the write applies
them. **Not** the default — without the flag unknown labels keep erroring, and
that error now names both escape hatches:

```
No Linear label matches "t3code".
Valid label options: …
To create a new label, run `shipit issue label create --name <name>` first, or re-run with --create-missing-labels.
```

Matching is case-insensitive against the tracker's existing set (the same
contract label *resolution* uses), so a casing difference never forks a
duplicate.

### Do-then-surface + undo

Label creation reuses the docs/177 `IssueWriteCard` stack with a new verb —
the docs/187 pattern of extending the card rather than minting a new card type:

- `IssueWriteVerb` += `"label"`; `IssueWriteUndo` += `{ kind: "label"; labelId;
  labelName }`. The card's `identifier` is the **label name**, `issueId`/`title`
  are empty, and the client renders it non-navigable (there is no issue to open
  inline).
- **Undo = delete the label if it's still unused.** The adapter checks usage
  first (Linear: `issueLabel.issues(first: 1)`; GitHub: `GET
  issues?labels=…&per_page=1`) and **refuses with an explanation** naming a
  carrier issue when the label is in use — surfaced as the card's undo error via
  the existing `handleUndoIssueWrite` failure path. An already-deleted label is
  an idempotent no-op.
- With `--create-missing-labels`, **each minted label gets its own card**
  (emitted before the main write's card, matching the order the writes
  happened), so a flag-driven creation is exactly as visible and reversible as
  an explicit one. Note the common case: undoing such a label right away will
  refuse, because the issue that was just created/edited already carries it —
  that's the honest answer, not a bug.
- Persistence, rehydration, WS undo, and idempotent replay are all inherited
  unchanged from docs/177/docs/187 (the card is stored as JSON; no migration).
  The standalone route shares the SHI-112 content-hash dedup window, so a
  crash/retry replay neither re-creates the label nor mints a second card.

### Brokering path (same shape as the other writes)

```
shipit issue label create → worker POST /agent-ops/issue/label/create
  (allowlisted, injects trusted SESSION_ID)
  → orchestrator POST /api/sessions/:id/issue/label/create
  → createLabelForTracker() service → Tracker.createLabel()
  → { ok, cardId, summary, label } back to the shim; card emitted + persisted
```

`Tracker` gains `createLabel()` / `deleteUnusedLabel()`, implemented by both
adapters:

- **Linear**: `issueLabelCreate` scoped to the bound team (`teamId`), so the
  new label appears in the same `issueLabels` set resolution matches against;
  undo via `issueLabelDelete` after the usage query.
- **GitHub**: `POST /repos/:o/:r/labels` (name doubles as the undo id — GitHub
  deletes labels by name); undo via `DELETE /labels/:name` after the usage
  check. **GitHub is fully supported** — the labels API made it cheap.

## Decisions

- **Opt-in, never auto-create.** The SHI-92 typo-protection stands; the flag
  and the standalone verb are deliberate acts.
- **Create-only surface.** Deleting/renaming labels is tracker gardening with
  blast radius across other issues; the only delete path is the Undo of a
  creation, gated on the label being unused.
- **Duplicate name → error, not idempotent success.** A 409 tells the agent the
  label already exists (just use it); silently succeeding would hide casing
  mismatches.
- **Reuse `IssueWriteCard` with a `label` verb** rather than a new card type —
  same call docs/187 made for `create`; persistence and client render are
  inherited with two small client-side additions (verb label/icon, no-open).

## Key files

- `src/server/orchestrator/trackers/tracker.ts` — `createLabel` / `deleteUnusedLabel` on the interface.
- `src/server/orchestrator/trackers/linear/adapter.ts` — `issueLabelCreate` / usage query + `issueLabelDelete`.
- `src/server/orchestrator/trackers/github/adapter.ts` — `POST`/`DELETE /labels` + usage check.
- `src/server/orchestrator/services/issues.ts` — `createLabelForTracker`, `createMissingLabels` helper, `LabelCreation`, undo `label` branch, label-hint on rejection.
- `src/server/orchestrator/api-routes-issues.ts` — `POST /api/sessions/:sessionId/issue/label/create`, `emitLabelCreationCard`, `createMissingLabels` on create/edit, `createdLabels` in the result.
- `src/server/session/agent-ops-routes.ts` — `/agent-ops/issue/label/create` relay.
- `src/server/session/agent-shim/shipit-issue.ts` — `handleIssueLabel` (+ `--create-missing-labels` on create/edit).
- `src/server/session/agent-shim/shipit.ts` — `label` dispatch, help + usage text.
- `src/server/shared/types/domain-types/issue.ts` — `IssueWriteVerb` `"label"`, `IssueWriteUndo` `{ kind: "label" }`.
- `src/client/components/IssueWriteCard.tsx` — verb label/icon; label cards are non-navigable.
- `src/server/shipit-docs/issues.md` — agent-facing docs (Creating labels).
- Tests: `trackers/{linear,github}/adapter.test.ts`, `services/issues.test.ts`, `agent-shim/shipit.test.ts`, `integration_tests/agent-issue-label-creation.test.ts` (+ shim-slice cases in `agent-issue-access.test.ts`).

## Related docs

- `docs/177-agent-issue-writes/` — the write stack + provenance card this extends (SHI-92 label resolution).
- `docs/187-agent-issue-creation/` — the "extend the card with a new verb" precedent and the do-then-surface rationale for creation-class writes.
- `docs/197-issue-label-filter-editor/` — the UI label surfaces built on the same `listLabels`.
