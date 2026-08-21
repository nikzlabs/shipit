---
issue: planning#330
title: Reading PR comments through the gh shim
description: The agent can read review feedback left on its own PR without leaving ShipIt.
---

# 255 — Reading PR comments through the `gh` shim: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

Context: a reviewer left detailed findings on a pull request and the agent could
not read them through any supported tooling. `gh pr view <n> --json comments`
returned `{}`, and so did every other field name — including invented ones. The
only way through was fetching the public github.com page, which fails on private
repos and goes through an unauthenticated path.

1. The agent can read the conversation comments left on a pull request using the
   ShipIt `gh` shim, without leaving ShipIt and without fetching a public web
   page.

2. The agent can read inline code-review comments — the ones attached to a file
   and a line — including which file and line they are on and the surrounding
   diff context, so a finding can be acted on without guessing where it points.

3. The agent can read review-level summaries and each review's verdict:
   approved, changes requested, or commented.

4. Reading works on private repositories, using the same brokered
   authentication as the rest of the shim. The container still never sees the
   GitHub token, and nothing here can write to GitHub.

5. Asking for a `--json` field the shim does not support fails with an explicit
   error that names the fields it does support. It must never be possible to
   confuse "this field is not supported" with "there is no data" — that
   confusion is what hid the review feedback in the first place.

6. Requirement 5 holds for every shim subcommand that accepts `--json`, not just
   `gh pr view`.

7. Where the real `gh` CLI already has a name for one of these concepts, the
   shim uses the same name, so an agent's existing habits transfer.

8. An agent that reaches for the plain (non-`--json`) `gh pr view` first is told
   how much discussion the pull request has and how to read it, so it is never
   left thinking a discussed PR is a quiet one.

## Resolved questions

- 2026-08-06 — Should plain (non-`--json`) `gh pr view` print the comment bodies
  themselves, or only report how many there are and how to read them? Chosen:
  counts plus a pointer, with the full bodies behind `--comments`. Printing
  every body on every view would dump a long review into the agent's context on
  reads that didn't ask for it. Requirement 8 was reworded to name the counts.
- 2026-08-06 — With unsupported `--json` fields now failing loudly (req 5),
  should the shim also start supporting the common real-`gh` PR fields it
  currently lacks (`author`, `createdAt`, `updatedAt`, `labels`,
  `reviewDecision`, `mergedAt`, `headRefName`/`baseRefName`)? Chosen: add them,
  so the stricter error fires on genuinely unsupported names rather than on
  ordinary habits. Covered by requirement 7.
