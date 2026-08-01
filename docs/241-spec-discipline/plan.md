---
issue: https://linear.app/shipit-ai/issue/SHI-268
description: A prompt-only requirements workflow — human-owned requirements docs per feature, agent-asked open questions, and no implementation while questions are open.
---

# 241 — Spec discipline: design

**Requirements:** [`requirements.md`](./requirements.md) — plain-language, human-approved; the source of truth for what this feature does. This doc explains how it is implemented. Numbers like (req 3) refer to entries there.

## Intent

Coding agents fail at requirements more often than at code: they hit an unspecified detail, pick a plausible answer, write it into the code, and never surface it. Spec discipline makes that visible: requirements live in a human-owned document, unresolved gaps are explicit open questions, human answers are written back into the document, and the agent does not implement a feature while its questions are open.

This version is entirely a workflow the agent follows from instructions ShipIt provides. There is no validator, no gate, no configuration, and no new session state — the only thing built is the instructions themselves and the platform doc describing them. Mechanical enforcement is a later version (see requirements.md → Later versions).

## Design

### The rules fragment

The whole feature is a short instruction fragment plus a platform doc:

- **`src/server/orchestrator/prompts/spec-discipline.md`** — the workflow rules, composed into the agent's system instructions like every other prompt fragment (see CLAUDE.md → Prompts). It is static text included for every session, in both the Claude and Codex variants, so it renders once at module load and the precomputed-instructions cache contract is unaffected.
- **`src/server/shipit-docs/spec-discipline.md`** — the agent-facing reference the fragment points at, baked into the session-worker image at `/shipit-docs/`, describing the document format and the workflow in full.

The fragment stays short (the reason it can be always-on): what a requirements document is, when a feature is under the discipline, the four rules below, and a pointer to the platform doc for the rest.

### The workflow the fragment specifies

**A feature is under the discipline when its folder contains `requirements.md`** (reqs 7–8). No configuration, no repo-wide scan: the agent is working on one feature (req 9), and either that feature's folder has the file or it doesn't. Features and projects without one are unaffected, so the fragment is inert by default.

**Writing the document** (reqs 1–3). Plain language, numbered statements, no formal notation — it says what the feature must do, not how. It is a separate file from `plan.md` (req 2) so the design can be edited without touching it. When the agent drafts it from a prompt, what the human stated becomes a requirement; anything the agent had to supply itself goes under `## Open questions` instead — that split is what keeps agent guesses out of the requirements (req 3).

**Asking** (req 4). Gaps are added as bullets under `## Open questions` in `requirements.md` *and* asked in chat through the existing structured-question flow (Claude's native question tool; the Codex bridge, docs/147) — batched, each with a few concrete options and a recommendation. Existing machinery; nothing new is built for this.

**Not implementing while questions are open** (reqs 5, 10). With questions open, the agent works on the requirements and the design and does not write implementation code. A question is removed only when the human's answer is written in, together with a dated note under `## Resolved questions`. Both the removal and the resulting requirement land in the same pull request diff, so a skipped question is visible to review — which is the enforcement in this version (req 5). Only the feature being worked on is affected (req 10).

**Reviewing afterwards** (req 6). The agent asks a fresh-context reviewer to check the built code against the requirements: `shipit agent run` for a different backend (docs/144), or a subagent when only one backend is configured — both already exist and are already fresh-context. The reviewer gets the feature's requirements, the branch diff against the PR base, and the checklist; its findings surface inline in the transcript. The reviewer shares the workspace, so "review, don't edit" is instruction-level here too.

## Key files (planned)

- `src/server/orchestrator/prompts/spec-discipline.md` — the rules fragment
- `src/server/orchestrator/agent-instructions.ts` — compose the fragment into the instruction skeleton
- `src/server/shipit-docs/spec-discipline.md` — agent-facing platform doc
- `docs/241-spec-discipline/` — this feature's own documents, doubling as the worked example
