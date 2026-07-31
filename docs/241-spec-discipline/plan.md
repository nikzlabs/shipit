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

A project turns the discipline on by committing `.shipit/spec-discipline.json` at the workspace root:

```json
{
  "enabled": true,
  "docsDir": "docs"
}
```

`enabled` is the whole switch: `false`, or no file at all, means everything in this doc is off. `docsDir` is optional (default `"docs"`) and names the folder containing feature folders, for projects that don't follow ShipIt's `docs/` convention. No other keys in v1.

### Feature artifacts (reqs 1–2, 9)

Within an opted-in project, a feature participates when its folder (`<docsDir>/<NNN>-<slug>/`) contains a `requirements.md`. The feature keeps three files there: `requirements.md` (plain-language requirements, plus unresolved questions listed under an `## Open questions` heading — that heading is what the validator reads, so no special marker syntax is needed), `plan.md` (design, unchanged role), and `checklist.md` (implementation items). Work tracking — status, priority, discussion — stays in the project's issue tracker when one is connected (Linear for ShipIt itself); these files don't duplicate it, and a project with no tracker just doesn't have that layer.

### Maintaining requirements.md (reqs 3–4)

The agent maintains `requirements.md` — v1 has no separate approval machinery. The agent writes the doc when prompted, adds entries under `## Open questions` when it hits gaps, and removes a question only when writing in the human's answer, together with a dated note of what was asked and what was chosen. Every change to the file is an ordinary git change, visible in the PR diff, so a question that disappears without an answer is caught by review of the history rather than blocked by a mechanism — the enforcement level requirement 5 specifies.

### Clarification flow (req 4)

Batched questions render through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147), with 2–4 options plus free-text per question. The user's answers arrive as the agent's next turn, and the agent updates `requirements.md` itself. The UI never writes workspace files.

### Validator and turn-start gating (reqs 5, 9–10)

The validator is a library in the orchestrator — the turn gate is its only consumer in v1, so there is no CLI. It reads the active feature's `requirements.md` and reports each entry under `## Open questions` as a blocking finding with file and line. Semantic judgment — contradictions, coverage, whether the code matches — is the reviewer's job, not the validator's.

The gate consults the validator in the orchestrator's turn-dispatch path — the one seam every backend passes through, so gating is backend-neutral by construction. When the session's active feature (selected per req 9) has blocking findings, the turn becomes a clarification turn: the findings are injected into the turn's instructions (resolve gaps, do not implement), and the validator re-runs post-turn with remaining findings surfaced in the session. There is no report-only mode (req 10). The gate is deliberately *not* write-proof — there is no per-file write enforcement; the constraint is instructions plus post-turn re-validation.

### Post-implementation review (req 6)

A fresh-context reviewer agent — never the implementing session's context, and the non-implementing backend when one is configured — gets the requirements, the branch diff against the base, and the checklist, and reports advisory findings inline.

### Child projects (req 7)

The same validator, question flow, and gating operate on any workspace with the config file. ShipIt scaffolds `.shipit/spec-discipline.json` and the docs skeleton from templates without overwriting existing files, and appends a short requirements-discipline rules block to the project's `CLAUDE.md` (creating it if absent, never duplicating it). No ShipIt-repo-specific code paths.

## Key files (planned)

- `src/server/orchestrator/spec-discipline/` — validator library, `SpecGateService`, config reader
- Turn-dispatch integration: `turn-executor.ts` (gate consult at turn start)
- `src/server/shipit-docs/spec-discipline.md` — agent-facing docs for child projects
