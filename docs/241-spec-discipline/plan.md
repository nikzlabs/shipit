---
issue: https://linear.app/shipit-ai/issue/SHI-268
description: Human-owned requirements docs per feature, agent-asked open questions, and turn-start gating that blocks implementation while questions are open.
---

# 241 — Spec discipline: design

**Requirements:** [`requirements.md`](./requirements.md) — plain-language, human-approved; the source of truth for what this feature does. This doc explains how it is implemented. Numbers like (req 3) refer to entries there.

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. Spec discipline makes that structurally visible: requirements live in a human-owned document, unresolved gaps are explicit open questions, human answers are written back into the document, and a validator gates implementation turns until the questions are closed.

## Design

### Opting in (reqs 7–8)

A project turns the discipline on with a `spec-discipline` section in its existing `shipit.yaml` (no separate config file):

```yaml
spec-discipline:
  enabled: true
  docs-dir: docs
```

`enabled` is the whole switch: `false`, or no `spec-discipline` section at all, means everything in this doc is off. `docs-dir` is optional (default `docs`) and names the folder containing feature folders, for projects that don't follow ShipIt's `docs/` convention. No other keys in v1.

### Feature artifacts (reqs 1–2, 9)

Within an opted-in project, a feature participates when its folder (`<docsDir>/<NNN>-<slug>/`) contains a `requirements.md`. The feature keeps three files there: `requirements.md` (plain-language requirements, plus unresolved questions listed under an `## Open questions` heading — that heading is what the validator reads, so no special marker syntax is needed), `plan.md` (design, unchanged role), and `checklist.md` (implementation items). Work tracking — status, priority, discussion — stays in the project's issue tracker when one is connected (Linear for ShipIt itself); these files don't duplicate it, and a project with no tracker just doesn't have that layer.

### Maintaining requirements.md (reqs 3–4)

The agent maintains `requirements.md` — v1 has no separate approval machinery. The agent writes the doc when prompted, adds entries under `## Open questions` when it hits gaps, and removes a question only when writing in the human's answer, together with a dated note of what was asked and what was chosen. Every change to the file is an ordinary git change, visible in the PR diff, so a question that disappears without an answer is caught by review of the history rather than blocked by a mechanism — the enforcement level requirement 5 specifies.

### Clarification flow (req 4)

Batched questions render through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147), with 2–4 options plus free-text per question. The user's answers arrive as the agent's next turn, and the agent updates `requirements.md` itself. The UI never writes workspace files.

### Validator and turn-start gating (reqs 5, 9–10)

The validator is a library in the orchestrator — the turn gate is its only consumer in v1, so there is no CLI. It reads the active feature's `requirements.md` and reports each entry under `## Open questions` as a blocking finding with file and line. Semantic judgment — contradictions, coverage, whether the code matches — is the reviewer's job, not the validator's.

The gate consults the validator in the orchestrator's turn-dispatch path — the one seam every backend passes through, so gating is backend-neutral by construction. When the session's active feature (selected per req 9) has blocking findings, the turn becomes a clarification turn: the findings are injected into the turn's instructions (resolve gaps, do not implement), and the validator re-runs post-turn with remaining findings surfaced in the session. There is no report-only mode (req 10).

The gate does not distinguish design work from implementation by inspecting what the agent does — it can't, and doesn't try. It reads only document state: while the active feature has open questions, every turn is a clarification turn, and working on the feature's design is exactly what a clarification turn is for — writing requirements, editing the plan, asking questions are all in bounds; only implementation is not. Code written despite the designation isn't mechanically blocked (the gate is deliberately *not* write-proof — there is no per-file write enforcement): it lands in a PR diff against a feature whose questions were visibly still open, which review catches.

### Post-implementation review (req 6)

The machinery for this already exists: `shipit agent run` performs a one-shot, fresh-context consult of the other configured backend (docs/144), and same-backend subagents are fresh-context too. v1 adds only the review convention on top: the reviewer gets the feature's requirements, the branch diff against the base, and the checklist — never the implementing session's context — and its findings surface inline as advisory.

### Child projects (req 7)

The same validator, question flow, and gating operate on any workspace whose `shipit.yaml` enables the section. Nothing is added to a project unless the human asks (req 8 — opt-in is explicit, never forced): when the human asks to turn the discipline on, the agent adds the `spec-discipline` section to `shipit.yaml` (creating the file if absent) and creates the feature-folder skeleton, without overwriting anything that exists. The discipline's agent rules are injected at the ShipIt level — a fragment included in the session's agent instructions when the workspace enables the discipline, plus the platform doc at `/shipit-docs/spec-discipline.md` — rather than written into each project's `CLAUDE.md`, so the rules stay current with ShipIt instead of drifting per project. No ShipIt-repo-specific code paths.

## Key files (planned)

- `src/server/orchestrator/spec-discipline/` — validator library, `SpecGateService`
- `src/server/shared/session-config.ts` — extend the `shipit.yaml` schema with the `spec-discipline` section
- Turn-dispatch integration: `turn-executor.ts` (gate consult at turn start)
- `src/server/shipit-docs/spec-discipline.md` — agent-facing docs for child projects
