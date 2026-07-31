---
issue: https://linear.app/shipit-ai/issue/SHI-268
description: Requirement IDs in feature docs, forge-proof clarification receipts, and turn-start gating that blocks implementation while questions are open.
---

# 241 — Spec discipline: requirements IDs, clarification receipts, turn-start gating

**Status:** draft — open clarification markers below block implementation (this doc opts into its own gate).

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. This feature makes invented requirements structurally visible: requirements carry stable IDs, unresolved gaps are explicit markers, human resolutions are recorded as orchestrator-owned receipts the agent cannot forge, and a deterministic validator gates implementation turns until the gaps are closed.

Requirements live as sections of the existing `docs/NNN-*/plan.md` (alongside `checklist.md` and the Linear issue); the discipline adds format, receipts, a validator, and gating on top of that structure rather than a new artifact hierarchy.

## Requirements

IDs are qualified by doc number (`241-REQ-nnn`), stable, and never reused; a dropped requirement is marked `[SUPERSEDED by 241-REQ-nnn]`, not deleted.

### Doc format (shared by ShipIt and child projects)

- **241-REQ-001:** WHERE a feature doc opts into spec discipline THE SYSTEM SHALL recognize `## Requirements`, `## Out of scope`, and `## Clarifications` sections in that doc's `plan.md`, with requirement IDs of the form `<NNN>-REQ-<nnn>`.
- **241-REQ-002:** IF two requirements in the repository carry the same qualified ID THEN THE SYSTEM SHALL report a blocking finding.
- **241-REQ-003:** WHEN the agent encounters an unspecified decision THE SYSTEM SHALL record it as an inline `[NEEDS CLARIFICATION: <question>]` marker in the feature's `plan.md`, at the point of ambiguity.
- **241-REQ-004:** WHEN a clarification is resolved THE SYSTEM SHALL replace the marker with a numbered requirement and a dated `## Clarifications` entry citing the receipt ID that resolved it (see 241-REQ-021).

### Validator — `shipit spec check`

One implementation, two entry points: a CLI shim (`shipit spec check`) and a library callable from the orchestrator.

- **241-REQ-010:** THE SYSTEM SHALL provide `shipit spec check --feature docs/<NNN>-<slug>` scoped to one feature, and `--all` scanning every opted-in doc.
- **241-REQ-011:** IF a scoped feature's `plan.md` contains a `[NEEDS CLARIFICATION]` marker THEN THE SYSTEM SHALL report a blocking finding with file path and line number.
- **241-REQ-012:** IF a checklist item cites a requirement ID that does not exist, or a requirement is cited by no checklist item, THEN THE SYSTEM SHALL report a blocking finding naming the ID.
- **241-REQ-013:** IF a `## Clarifications` entry cites a receipt ID that does not exist, or cites a receipt already cited by another entry, THEN THE SYSTEM SHALL report a blocking finding.
- **241-REQ-014:** THE SYSTEM SHALL report ambiguity-word findings (*should*, *may*, *appropriate*, *properly*, *reasonable*, *etc.*, *handle gracefully* inside requirement text) and EARS-conformance findings as warnings, not blockers.
- **241-REQ-015:** THE SYSTEM SHALL exit non-zero when any blocking finding exists in the scoped feature, zero otherwise, and SHALL emit findings as JSON under `--json`.
- **241-REQ-016:** THE SYSTEM SHALL treat `--all` as advisory: it reports findings across features and never blocks a turn.

### Resolution receipts

The gate's authority is a receipt store owned by the orchestrator, outside the session workspace. Markdown summarizes decisions; receipts *are* the decisions.

- **241-REQ-020:** WHEN a user answers a clarification question in chat THE SYSTEM SHALL persist a receipt recording feature dir, question text verbatim, options offered, chosen answer, the answering user message ID, the `plan.md` git blob SHA at ask time, and a timestamp.
- **241-REQ-021:** THE SYSTEM SHALL assign each receipt a unique ID and expose receipts read-only to the session (for the agent to cite in `## Clarifications`).
- **241-REQ-022:** IF a receipt-creation request originates from anything other than a user's answer to a rendered question card THEN THE SYSTEM SHALL reject it.

### Clarification flow — reuse the existing question card

- **241-REQ-030:** WHEN the agent asks batched clarification questions THE SYSTEM SHALL render them through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147), with 2–4 options plus free-text per question.
- **241-REQ-031:** WHEN the user submits answers THE SYSTEM SHALL mint one receipt per answered question (241-REQ-020) and deliver the answers to the agent as the next turn; the agent updates `plan.md` itself.

### Turn-start gating

- **241-REQ-040:** WHERE a session has an active feature and the workspace mode is `blocking`, WHEN a turn starts THE SYSTEM SHALL run the validator scoped to that feature before spawning any backend, and IF blocking findings exist THEN THE SYSTEM SHALL inject the findings into the turn's instructions designating it a clarification turn (resolve gaps, do not implement).
- **241-REQ-041:** WHERE the workspace mode is `advisory` THE SYSTEM SHALL surface findings without designating the turn.
- **241-REQ-042:** WHEN a gated turn ends THE SYSTEM SHALL re-run the validator and surface remaining blocking findings in the session.
- **241-REQ-043:** THE SYSTEM SHALL read mode and paths from `.shipit/spec-discipline.json` in the workspace, and SHALL treat a workspace without that file as opted out entirely.

Gating is backend-neutral by construction: it runs in the orchestrator's turn-dispatch path, which every backend passes through. It is deliberately *not* write-proof — a designated clarification turn constrains the agent through instructions plus post-turn re-validation; there is no per-file write enforcement.

### Post-implementation review

- **241-REQ-050:** WHEN a user requests a spec review of a feature THE SYSTEM SHALL invoke a fresh-context reviewer agent — never the implementing session's context — with the feature's requirements, the branch diff against the base, and the checklist, and SHALL surface its findings inline as advisory.
- **241-REQ-051:** WHERE a second agent backend is configured THE SYSTEM SHALL run the reviewer on the non-implementing backend.

### Child projects (Level 2)

- **241-REQ-060:** WHEN a user initializes spec discipline in a child-project workspace THE SYSTEM SHALL create `.shipit/spec-discipline.json` and the docs skeleton from templates without overwriting any existing file, and SHALL append a short requirements-discipline rules block to the workspace `CLAUDE.md` (creating it if absent) without duplicating an existing block.
- **241-REQ-061:** THE SYSTEM SHALL run the same validator, receipts, question flow, and gating against a child project's workspace with no code path specific to the ShipIt repo.

## Clarifications

Open questions, marked per the discipline itself. These block implementation until answered.

- [NEEDS CLARIFICATION: How is a session's active feature selected — inferred from the issue/doc the session was launched from, set explicitly by the user in chat, or a default in `.shipit/spec-discipline.json`? Recommended: inferred at launch with an explicit chat override, since sessions already launch from issues.]
- [NEEDS CLARIFICATION: What is the default mode for a newly opted-in workspace — `blocking` or `advisory`? Recommended: `blocking`, since gating is scoped to the active feature and a stale sibling doc cannot deadlock unrelated work.]
- [NEEDS CLARIFICATION: Do `--all` advisory findings run anywhere automatically (CI job, post-turn summary), or only on demand? Recommended: on demand plus a CI job that never fails the build.]

## Key files (planned)

- `src/server/orchestrator/spec-discipline/` — validator library, receipt store, `SpecGateService`
- `src/server/session/agent-shim/shipit-spec.ts` — `shipit spec check` CLI shim
- Turn-dispatch integration: `turn-executor.ts` (gate consult at turn start)
- `src/server/shipit-docs/spec-discipline.md` — agent-facing docs for child projects
