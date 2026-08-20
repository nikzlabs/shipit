---
description: The requirements-discipline workflow in full — document format, open questions, clarification receipts, and the independent post-implementation review. Repository policy, not a ShipIt feature.
---

# 241 — Requirements discipline: the workflow

This is the long-form reference for the working rule stated in [`CLAUDE.md`](../../CLAUDE.md) › *Every new feature is under requirements discipline*. The rule is **this repository's policy**. ShipIt's product code carries none of it (req 11): no fragment in the system instructions the orchestrator builds, and no page in `src/server/shipit-docs/`. A session working on another repository sees nothing about it unless that repository writes its own copy.

Nothing is validated mechanically. The agent follows the workflow, and the pull-request diff makes every requirements change reviewable (req 5). Mechanical enforcement is a later version — planning#275.

## Identify the active feature at turn start

At the start of each turn that touches feature work, identify the one active feature from the session's feature or issue context, or from the feature the user named in chat. Locate its `docs/NNN-*/` folder and check for `requirements.md` before doing any work on the feature. Do not scan unrelated features for blockers.

If the document already has bullets under `## Open questions`, the feature is blocked before you write any implementation code, whether or not you raised those questions. Resolve them through the flow below, starting at step 2; requirements and design work may continue while implementation is blocked.

In this repository the discipline is **mandatory for every new feature**: if the work warrants a `docs/NNN-*` folder, that folder gets a `requirements.md`, written before `plan.md`. Existing features without one are not retroactively required to have it — but the moment you materially rework one, write its requirements first. Bug fixes, refactors, and chores that get no docs folder get no requirements document either; the rule attaches to the folder, not to the commit.

When drafting `requirements.md` from a prompt, only what the human stated becomes a numbered requirement. Anything you had to supply yourself goes under `## Open questions` for the human to approve, not into the numbered list (req 3).

## Document format

The document is deliberately readable without specialist notation:

```markdown
# Sample feature

1. A numbered, plain-language statement of what the feature must do.
2. Another observable requirement, without implementation details.

## Open questions

- A decision the human has not made yet.

## Resolved questions

- YYYY-MM-DD — The question and the human's chosen answer, including any important constraint.
```

Requirements say what the feature must do, not how it will be implemented. Keep implementation decisions in `plan.md`.

## Human input lands in requirements.md first

A requirement comes from the human, either directly or by approving an assumption you proposed; you never promote your own guess into one. For a feature under this discipline, `requirements.md` is the first destination for human input. Any human input that adds, removes, changes, or clarifies what the feature should do must first be reflected there: update the numbered requirements, or record in a clarification receipt why no requirement changed. Only then may the design be updated to implement those requirements. Updating `plan.md` directly from human input while leaving `requirements.md` unchanged is an anti-pattern: it lets the design become a second, hidden source of requirements.

The numbers are the requirement IDs. Designs, checklists, implementation notes, and review findings refer to them as `req 1`, `req 2`, and so on. Keep existing IDs stable when editing; append new requirements unless the human explicitly restructures the document. Because `docs/NNN` numbers are not unique in this repository, a citation into a document names the folder: `docs/241-spec-discipline req 7`, never `docs/241 req 7`.

## Clarifying gaps

If the requirements do not determine a behavior needed for implementation:

1. Add the gap as a bullet under `## Open questions`.
2. Ask it in chat through the structured-question flow. Batch related gaps, provide a few concrete options, and state a recommendation.
3. Continue requirements or design work if useful, but do not write implementation code while any open question remains.
4. After the human answers, add or update the numbered requirement the answer produces. If the answer changes no requirement — for example, it rules something out of scope or confirms an existing requirement — record that in the resolved note rather than inventing a requirement to fill the slot.
5. Add a dated note under `## Resolved questions` recording the question and the human's answer, then remove the open-question bullet in the same change.

The dated resolved note is the clarification receipt. The receipt, the removal, and any requirement change must appear together in the pull-request diff so a reviewer can distinguish a human answer from a silently discarded question. An agent inference never clears an open question.

Open questions block only the active feature. They do not prevent unrelated fixes or work on another explicitly selected feature (req 10).

## Post-implementation review

Before declaring implementation complete, have an independent reviewer compare the code with every numbered requirement (req 6). Run it through the ShipIt CLI:

```
shipit agent run --role reviewer --prompt-file - <<'EOF'
Review only — do not edit this workspace. …
EOF
```

**This is not a subagent in your harness's sense.** `shipit agent run` is an ordinary shell command asking ShipIt to run a *separate, out-of-process* agent; it is not the built-in `Task` / AgentTool. A harness rule like "don't spawn subagents unless the user asks" governs that in-process tool and does not apply here — and this repository's own instructions ask for the review, so it is asked-for work, not extra initiative.

**Name the role, not a reviewer.** Working out which model is far enough from yours is not your job: ShipIt picks the configured reviewer furthest from what you are running — a different model family first, then a different model, then a different harness — falling back to the best difference the install offers. That is why `--role reviewer` on its own is the whole command. You *may* carry a parameter the user named — that is an override, and it is theirs to ask for — but doing so sets the "furthest from you" guarantee aside, so a review you were not told to steer stays a bare role. If the review cannot run at all (Settings → Multi-agent sessions is off, or no reviewer has a credential with quota left), say so in chat; do not silently substitute your own pass.

The reviewer shares this workspace and its writes get committed under your session, so the prompt must say **review only, do not edit**. Give it pointers, not pasted content — it can read the repo itself:

- the path to the feature's `requirements.md` and `checklist.md`;
- the command for the branch diff against the pull-request base (`git diff main...HEAD`), **plus** `git diff` and `git status --short`, since the current turn's work is not committed yet; and
- the output shape you want back — per-requirement met / not met / unclear, with `file:line` references.

A real review outlives a foreground command, so launch it in the background and collect it with `shipit agent result <RUN-ID> --wait`. Findings surface inline in ShipIt's transcript automatically. Resolve any mismatch before completion, or record it in the checklist as remaining work. The implementing session must not substitute its own final pass for this independent review.
