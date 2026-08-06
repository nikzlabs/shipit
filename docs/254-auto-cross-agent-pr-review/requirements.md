# Automatic cross-agent PR review — requirements

> Status: requirements draft. Open questions below are unanswered, so no
> implementation code has been written. See `CLAUDE.md` →
> *Every new feature is under requirements discipline*.

## Requirements

1. Every pull request opened from a ShipIt session is reviewed by an agent
   backend **different from the one that wrote the code** — a Claude-authored PR
   is reviewed by Codex, and vice versa.
2. The review happens **without the user asking for it**. The user does not have
   to type "review this with Codex" or press anything.

## Open questions

- **Scope.** Does this apply to every repository built inside ShipIt (a platform
  behaviour), or only to the ShipIt repository itself (a `CLAUDE.md` house rule)?
- **No second backend available.** When the user has only one agent provider
  signed in, or the Multi-agent sessions setting is off, what should happen —
  fall back to a fresh-context same-model reviewer, skip silently, or tell the
  user the PR went out unreviewed?
- **Does the review gate anything?** Is the review advisory (posted, PR opens
  regardless), or must the authoring agent address the findings before the PR is
  considered done?
- **Who acts on the findings?** Does the reviewer only report, with the authoring
  agent deciding what to fix, or should confirmed findings be fixed in the same
  turn before the PR is handed over?

## Resolved questions

_(none yet)_

## Non-requirements

- Nothing here asks for a new review *surface*. ShipIt already renders brokered
  cross-agent output in the consult card (`docs/220-cross-agent-review-surfacing`);
  this feature is about when the review is triggered, not how it is displayed.

## Context gathered while writing this

- `shipit agent run --agent <other>` is the existing, authenticated primitive for
  a different-model consult (`docs/144-cross-agent-review`,
  `src/server/shipit-docs/agent.md`). It is **not** a subagent, so the CLI's
  "don't spawn subagents unless asked" instruction does not apply to it.
- Cross-agent review already exists but is **user-triggered** — the natural
  language request is the trigger (`docs/203-plaintext-ai-review`,
  `docs/220-cross-agent-review-surfacing`). This feature would make it automatic
  on PR creation.
- `CLAUDE.md` already requires a fresh-context reviewer before calling a feature
  done, but scoped to checking code against `requirements.md`, not to every PR.
