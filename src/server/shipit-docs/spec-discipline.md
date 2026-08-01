# Requirements discipline

Requirements discipline is an optional, per-feature workflow for keeping human intent separate from agent assumptions. It is enabled when the active feature's folder contains `requirements.md`. Features without that file are unaffected.

This first version is instruction-driven. ShipIt does not mechanically validate the document or block file writes; the agent follows the workflow, and the pull request history makes requirements changes reviewable.

## Identify the active feature at turn start

At the start of work, identify the one active feature from the session's feature or issue context, or from the feature the user named in chat. Locate its folder and check for `requirements.md` before writing implementation code. Do not scan unrelated features for blockers.

When a user starts a feature directly in chat and asks to use requirements discipline, create a feature folder containing separate `requirements.md`, `plan.md`, and `checklist.md` files. Continue treating that folder as the active feature.

## Document format

The document is deliberately readable without specialist notation:

```markdown
# Feature name: requirements

1. A numbered, plain-language statement of what the feature must do.
2. Another observable requirement, without implementation details.

## Open questions

- A decision the human has not made yet.

## Resolved questions

- YYYY-MM-DD — The question and the human's chosen answer, including any important constraint.
```

Requirements say what the feature must do, not how it will be implemented. Keep implementation decisions in `plan.md`. A requirement comes from the human, either directly or by approving an assumption the agent proposed. The agent must not promote its own guess into a requirement.

Use stable numbered statements as requirement IDs. Designs, checklists, implementation notes, and review findings can refer to them as `req 1`, `req 2`, and so on. Preserve existing numbers when editing; append new requirements unless the human explicitly restructures the document.

## Clarifying gaps

If the requirements do not determine a behavior needed for implementation:

1. Add the gap as a bullet under `## Open questions`.
2. Ask it in chat through the structured-question flow. Batch related gaps, provide a few concrete options, and state a recommendation.
3. Continue requirements or design work if useful, but do not write implementation code while any open question remains.
4. After the human answers, add or update the resulting numbered requirement.
5. Add a dated note under `## Resolved questions` recording the question and the human's answer, then remove the open-question bullet in the same change.

The dated resolved note is the clarification receipt. The requirement, receipt, and removal must appear together in the pull request diff so a reviewer can distinguish a human answer from a silently discarded question. An agent inference never clears an open question.

Open questions block only the active feature. They do not prevent unrelated fixes or work on another explicitly selected feature.

## Post-implementation review

Before declaring implementation complete, ask a fresh-context reviewer to compare the code with every numbered requirement. Prefer `shipit agent run` when a different configured backend is available; otherwise use a fresh subagent. Instruct the reviewer to review only and not edit the workspace.

Give the reviewer:

- the full `requirements.md`;
- the branch diff against the pull request base; and
- the feature's `checklist.md`.

Surface the findings in ShipIt's transcript. Resolve any mismatch before completion, or record a genuine remaining item in the checklist. The implementing session must not substitute its own final pass for this independent review.
