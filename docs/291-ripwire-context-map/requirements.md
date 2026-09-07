---
issue: planning#520
title: ripwire as a context map for session agents
description: Criteria a repo-mapping tool must satisfy before ShipIt bakes it into the session-worker image
---

# ripwire as a context map for session agents

Evaluation of [ripwire](https://github.com/redhat-et/ripwire) — a static-analysis
CLI and MCP server that gives an agent a ranked symbol map of a repository before
the agent reads any file.

These requirements are adoption criteria. They say what a context-map tool must do
for ShipIt, not how ripwire does it. The design and the measurements are in
[plan.md](plan.md).

1. An agent must be able to find the symbols relevant to a task without reading
   whole files first, and the answer must cost less than the grep-and-read pass it
   replaces.
2. Every file path, line number and symbol name the tool reports must be correct.
   An agent acts on these directly, so a wrong location is worse than no answer.
3. The tool must work on TypeScript, because that is what ShipIt is written in and
   what most session repositories contain.
4. Adoption must not change which tools the agent uses. The host `Bash`, `Edit`,
   `Write` and `Read` tools must stay in place, with their names unchanged.
5. Adoption must not write files into the user's repository clone.
6. A pinned version must satisfy the repository dependency policy in `CLAUDE.md`:
   an exact version, and at least 7 days since publication.
7. What ShipIt adds to the agent's always-on skill catalogue must stay small,
   because every skill description costs context in every session.
8. A feature that is not reliable on ShipIt's own codebase must not be put in
   front of the agent, even when the same feature works elsewhere.

## Open questions

- Which version do we pin — v0.3.8 (published 2026-08-13, satisfies requirement 6)
  or v0.4.0 (published 2026-09-07, needs a waiver)?

## Resolved questions

- 2026-09-07 — Do we adopt the vendor's 19 bundled skills? No. ShipIt already
  discloses about 25 skills, and doubling that catalogue costs context in every
  session. This is requirement 7.
- 2026-09-07 — Do we replace the agent's tool surface, as LemonCrow's runtime mode
  does? No. The user's prior evaluation (planning#332) rejected that shape, and the
  blockers it found are still true today. This is requirement 4, and the check that
  confirmed it is in [plan.md](plan.md).
