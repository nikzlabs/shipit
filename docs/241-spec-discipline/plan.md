---
issue: https://linear.app/shipit-ai/issue/SHI-268
description: Human-owned requirements docs per feature, forge-proof clarification receipts, and turn-start gating that blocks implementation while questions are open.
---

# 241 — Spec discipline: design

**Requirements:** [`requirements.md`](./requirements.md) — plain-language, human-approved; the source of truth for what this feature does. This doc explains how it is implemented. Numbers like (req 3) refer to entries there.

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. Spec discipline makes that structurally visible: requirements live in a human-owned document, unresolved gaps are explicit open questions, human answers are recorded as orchestrator-owned receipts the agent cannot forge, and a validator gates implementation turns until the questions are closed.

## Design

### Feature artifacts (reqs 1–2)

An opted-in feature keeps three files in its `docs/<NNN>-<slug>/` folder: `requirements.md` (plain-language requirements and open questions — no formal notation; the format constraint is that the validator can find open questions, so they are written as `[NEEDS CLARIFICATION: <question>]` markers), `plan.md` (design, unchanged role), and `checklist.md` (implementation items). Linear keeps status and priority, as today.

### Validator (req 5)

One implementation, two entry points: a library in the orchestrator and a `shipit spec check` CLI shim in the session container (`--feature docs/<NNN>-<slug>` scoped to one feature; `--json` for machine consumption; non-zero exit iff the scoped feature has blocking findings). It checks only what a parser can prove: open-question markers present (blocking, with file and line), and resolution entries citing real, unused receipt IDs (blocking when they don't). Semantic judgment — contradictions, coverage, whether the code matches — is the reviewer's job, not the validator's.

### Resolution receipts (reqs 3, 5)

The gate's authority is a receipt store owned by the orchestrator, persisted outside the session workspace. A receipt is minted only when a user answers a rendered question card, and records the feature dir, question text, options offered, chosen answer, answering user message ID, the `requirements.md` git blob SHA at ask time, and a timestamp. Sessions read receipts (to cite them when writing the resolution into `requirements.md`) but cannot create them — any receipt-creation request not originating from a user's answer to a question card is rejected. The markdown resolution log summarizes decisions; receipts *are* the decisions. This is also how requirement provenance survives: a receipt records exactly what was asked, what was offered, and what the human chose.

### Clarification flow (req 4)

Batched questions render through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147), with 2–4 options plus free-text per question. On submit, the orchestrator mints one receipt per answered question and delivers the answers as the agent's next turn; the agent updates `requirements.md` itself — replacing each answered marker with the agreed requirement and a dated resolution entry citing the receipt. The UI never writes workspace files.

### Turn-start gating (reqs 5, 8–10)

The gate consults the validator in the orchestrator's turn-dispatch path — the one seam every backend passes through, so gating is backend-neutral by construction. When the session's active feature (selected per req 9) has blocking findings, the turn becomes a clarification turn: the findings are injected into the turn's instructions (resolve gaps, do not implement), and the validator re-runs post-turn with remaining findings surfaced in the session. There is no report-only mode (req 10). The gate is deliberately *not* write-proof — there is no per-file write enforcement; the constraint is instructions plus post-turn re-validation. Projects opt in via `.shipit/spec-discipline.json` (req 8); no file, no gating.

### Post-implementation review (req 6)

A fresh-context reviewer agent — never the implementing session's context, and the non-implementing backend when one is configured — gets the requirements, the branch diff against the base, and the checklist, and reports advisory findings inline.

### Child projects (req 7)

The same validator, receipts, question flow, and gating operate on any workspace with the config file. ShipIt scaffolds `.shipit/spec-discipline.json` and the docs skeleton from templates without overwriting existing files, and appends a short requirements-discipline rules block to the project's `CLAUDE.md` (creating it if absent, never duplicating it). No ShipIt-repo-specific code paths.

## Key files (planned)

- `src/server/orchestrator/spec-discipline/` — validator library, receipt store, `SpecGateService`
- `src/server/session/agent-shim/shipit-spec.ts` — `shipit spec check` CLI shim
- Turn-dispatch integration: `turn-executor.ts` (gate consult at turn start)
- `src/server/shipit-docs/spec-discipline.md` — agent-facing docs for child projects
