---
issue: https://linear.app/shipit-ai/issue/SHI-268
description: Requirement IDs in per-feature requirements docs, forge-proof clarification receipts, and turn-start gating that blocks implementation while questions are open.
---

# 241 — Spec discipline: design

**Requirements:** [`requirements.md`](./requirements.md) — the source of truth for what this feature does, reviewable on its own. This doc explains how it is implemented.

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. Spec discipline makes invented requirements structurally visible: requirements carry stable IDs, unresolved gaps are explicit markers, human resolutions are recorded as orchestrator-owned receipts the agent cannot forge, and a deterministic validator gates implementation turns until the gaps are closed.

## Design

### Feature artifacts (241-REQ-001..004)

An opted-in feature keeps three files in its `docs/<NNN>-<slug>/` folder: `requirements.md` (requirements with qualified IDs, clarification markers, and the `## Clarifications` resolution log — separate from the design doc so a human can review requirements on their own and design edits can't silently alter them), `plan.md` (design, unchanged role), and `checklist.md` (implementation items, each citing the REQ IDs it satisfies). Linear keeps status and priority, as today.

### Validator (241-REQ-010..016)

One implementation, two entry points: a library in the orchestrator and a `shipit spec check` CLI shim in the session container. It does only what a parser can prove: markers present, IDs unique and well-formed, checklist↔requirement references resolve, `## Clarifications` entries cite real, unused receipt IDs. Ambiguity-word and EARS-form checks are warnings. Semantic judgment (contradictions, duplicate-in-different-words, test adequacy) is the reviewer's job, not the validator's.

### Resolution receipts (241-REQ-020..022)

The gate's authority is a receipt store owned by the orchestrator, persisted outside the session workspace. A receipt is minted only when a user answers a rendered question card, and records the question, options, chosen answer, answering message ID, and the `requirements.md` blob SHA at ask time. Sessions read receipts but cannot create them — the markdown `## Clarifications` log summarizes decisions; receipts *are* the decisions.

### Clarification flow (241-REQ-030..031)

Batched questions render through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147). On submit, the orchestrator mints receipts and delivers the answers as the agent's next turn; the agent writes the resulting requirements into `requirements.md` itself.

### Turn-start gating (241-REQ-040..043)

The gate consults the validator in the orchestrator's turn-dispatch path — the one seam every backend passes through, so gating is backend-neutral by construction. In `blocking` mode, a turn starting with blocking findings becomes a clarification turn: the findings are injected into the turn's instructions, and the validator re-runs post-turn. The gate is deliberately *not* write-proof — there is no per-file write enforcement; the constraint is instructions plus post-turn re-validation. Workspaces opt in via `.shipit/spec-discipline.json`; no file, no gating.

### Post-implementation review (241-REQ-050..051)

A fresh-context reviewer agent (the non-implementing backend when one is configured) gets the requirements, the branch diff, and the checklist, and reports advisory findings inline.

### Child projects (241-REQ-060..061)

The same validator, receipts, question flow, and gating operate on any workspace with the config file; ShipIt scaffolds the skeleton and a short rules block into the project's `CLAUDE.md`. No ShipIt-repo-specific code paths.

## Key files (planned)

- `src/server/orchestrator/spec-discipline/` — validator library, receipt store, `SpecGateService`
- `src/server/session/agent-shim/shipit-spec.ts` — `shipit spec check` CLI shim
- Turn-dispatch integration: `turn-executor.ts` (gate consult at turn start)
- `src/server/shipit-docs/spec-discipline.md` — agent-facing docs for child projects
