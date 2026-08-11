# Requirements discipline

Requirements discipline is an optional, per-feature workflow for keeping human intent separate from agent assumptions. It is enabled when the active feature's folder contains `requirements.md`. Features without that file are unaffected.

This first version is instruction-driven. ShipIt does not mechanically validate the document or block file writes; the agent follows the workflow, and the pull request history makes requirements changes reviewable.

## Identify the active feature at turn start

At the start of each turn that touches feature work, identify the one active feature from the session's feature or issue context, or from the feature the user named in chat. Locate its folder—the directory holding that feature's docs—and check for `requirements.md` before doing any work on the feature. Do not scan unrelated features for blockers.

If the document already has bullets under `## Open questions`, the feature is blocked before you write any implementation code, whether or not you raised those questions. Resolve them through the flow below, starting at step 2; requirements and design work may continue while implementation is blocked.

When a user starts a feature directly in chat and asks to use requirements discipline, create a feature folder next to the project's existing feature or design docs. If the project has no such convention, use `docs/<feature-name>/`. The folder contains separate `requirements.md`, `plan.md`, and `checklist.md` files. Continue treating that folder as the active feature.

When drafting `requirements.md` from a prompt, only what the human stated becomes a numbered requirement. Anything you had to supply yourself goes under `## Open questions` for the human to approve, not into the numbered list.

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

The numbers are the requirement IDs. Designs, checklists, implementation notes, and review findings can refer to them as `req 1`, `req 2`, and so on. Keep existing IDs stable when editing; append new requirements unless the human explicitly restructures the document.

## Clarifying gaps

If the requirements do not determine a behavior needed for implementation:

1. Add the gap as a bullet under `## Open questions`.
2. Ask it in chat through the structured-question flow. Batch related gaps, provide a few concrete options, and state a recommendation.
3. Continue requirements or design work if useful, but do not write implementation code while any open question remains.
4. After the human answers, add or update the numbered requirement the answer produces. If the answer changes no requirement—for example, it rules something out of scope or confirms an existing requirement—record that in the resolved note rather than inventing a requirement to fill the slot.
5. Add a dated note under `## Resolved questions` recording the question and the human's answer, then remove the open-question bullet in the same change.

The dated resolved note is the clarification receipt. The receipt, the removal, and any requirement change must appear together in the pull request diff so a reviewer can distinguish a human answer from a silently discarded question. An agent inference never clears an open question.

Open questions block only the active feature. They do not prevent unrelated fixes or work on another explicitly selected feature.

## Post-implementation review

Before declaring implementation complete, have an independent reviewer compare the code with every numbered requirement. Run it through the ShipIt CLI:

```
shipit agent run --role reviewer --prompt-file - <<'EOF'
Review only — do not edit this workspace. …
EOF
```

**This is not a subagent in your harness's sense.** `shipit agent run` is an ordinary shell command asking ShipIt to run a *separate, out-of-process* agent; it is not the built-in `Task` / AgentTool. A harness rule like "don't spawn subagents unless the user asks" governs that in-process tool and does not apply here — and the user opted into this review when they put the feature under requirements discipline, so it is asked-for work, not extra initiative.

**Name the role, not a reviewer.** Working out which model is far enough from yours is no longer your job: ShipIt keeps two configured reviewers and picks the one furthest from what you are running — a different model family first, then a different model, then a different harness — falling back to the best difference the install actually offers. That is why `--role reviewer` takes no `--agent`, no `--model` and no reasoning level, and refuses a call that supplies them. If the review cannot run at all (Settings → Multi-agent sessions is off, or neither reviewer has a credential with quota left), say so in chat; do not silently substitute your own pass.

The reviewer shares this workspace and its writes get committed under your session, so the prompt must say **review only, do not edit**. Give it pointers, not pasted content — it can read the repo itself:

- the path to the feature's `requirements.md` and `checklist.md`;
- the command for the branch diff against the pull-request base (`git diff <base>...HEAD`), **plus** `git diff` and `git status --short`, since the current turn's work is not committed yet; and
- the output shape you want back — per-requirement met / not met / unclear, with `file:line` references.

A real review outlives a foreground command, so launch it in the background and collect it with `shipit agent result <RUN-ID> --wait`. Findings surface inline in ShipIt's transcript automatically. Resolve any mismatch before completion, or record it in the checklist as remaining work. The implementing session must not substitute its own final pass for this independent review.
