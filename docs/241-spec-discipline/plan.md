---
issue: planning#270
description: A requirements workflow carried by this repository's own agent instructions — human-owned requirements docs per feature, agent-asked open questions, and no implementation while questions are open.
---

# 241 — Spec discipline: design

**Requirements:** [`requirements.md`](./requirements.md) — plain-language, human-approved; the source of truth for what this feature does. This doc explains how it is implemented. Numbers like (req 3) refer to entries there.

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. Spec discipline makes that visible: requirements live in a human-owned document, unresolved gaps are explicit open questions, human answers are written back into the document, and the agent does not implement a feature while its questions are open.

This is entirely a workflow the agent follows from instructions. There is no validator, no gate, no configuration, and no session state — the only thing written is the instructions themselves. Mechanical enforcement is a later version (see requirements.md → Later versions).

## Design

### Where the rules live

The whole feature is prose in **this repository**, and deliberately nowhere in the product (req 11):

- **`CLAUDE.md` › *Every new feature is under requirements discipline*** — the always-on rules: the turn-start check, the five ordered steps, and the pointer below. `CLAUDE.md` is symlinked as `AGENTS.md`, so both backends read it.
- **`docs/241-spec-discipline/workflow.md`** — the long-form reference: document format, the open-question flow and its clarification receipt, and the brief for the independent review.

**The first version put both in ShipIt's product surface** — a `prompts/spec-discipline.md` fragment composed into every system-instruction variant, and a `shipit-docs/spec-discipline.md` page baked into the session-worker image — which handed the workflow to every repository ShipIt runs on, whether or not it wanted one. Deleting them, and the tests that existed only to pin them, is the whole of the 2026-08-20 change; nothing replaced them, because a removal that leaves machinery behind has not removed anything. What ShipIt still provides is the *mechanism* the discipline uses and would provide anyway: the structured-question flow, and `shipit agent run --role reviewer`.

A project that wants the discipline writes it into its own agent instructions; this folder is the copy to start from.

### The workflow the fragment specifies

**A feature is under the discipline when its folder contains `requirements.md`** (req 8). No configuration, no repo-wide scan: the agent is working on one feature (req 9), and either that feature's folder has the file or it doesn't. Features without one are unaffected — though in this repository every *new* feature must have one (req 7 + CLAUDE.md).

**Writing the document** (reqs 1–3). Plain language, numbered statements, no formal notation — it says what the feature must do, not how. It is a separate file from `plan.md` (req 2) so the design can be edited without touching it. When the agent drafts it from a prompt, what the human stated becomes a requirement; anything the agent had to supply itself goes under `## Open questions` instead — that split is what keeps agent guesses out of the requirements (req 3).

**Asking** (req 4). Gaps are added as bullets under `## Open questions` in `requirements.md` *and* asked in chat through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147) — batched, each with a few concrete options and a recommendation. Existing machinery; nothing new is built for this.

**Not implementing while questions are open** (reqs 5, 10). With questions open, the agent works on the requirements and the design and does not write implementation code. A question is removed only when the human's answer is written in, together with a dated note under `## Resolved questions`. Both the removal and the resulting requirement land in the same pull request diff, so a skipped question is visible to review — which is the enforcement in this version (req 5). Only the feature being worked on is affected (req 10).

**Reviewing afterwards** (req 6). The agent asks an independent reviewer to check the built code against the requirements, via `shipit agent run` (docs/144) — preferably a different backend, the same one for fresh context when only one is configured. The reviewer gets pointers to the feature's requirements and checklist and the commands for the branch diff against the PR base (plus the uncommitted working tree); its findings surface inline in the transcript. The reviewer shares the workspace, so "review, don't edit" is instruction-level here too.

The instructions name `shipit agent run` as *the* mechanism and say explicitly that it is not a `Task`/AgentTool subagent. Both documents originally said "fresh-context reviewer … or a subagent", which collided with the Claude CLI's baked-in "don't call the AgentTool unless the user requested it": the agent read the review step as something it was forbidden to do and skipped it. A brokered out-of-process run is not what that rule governs, and putting a feature under the discipline *is* the user asking — so the instructions state both, rather than leaving the agent to reconcile them.

## Key files

- `CLAUDE.md` — the always-on rules (symlinked as `AGENTS.md`, so both backends read them)
- `docs/241-spec-discipline/workflow.md` — the long-form workflow reference
- `docs/241-spec-discipline/` — this feature's own documents, doubling as the worked example
