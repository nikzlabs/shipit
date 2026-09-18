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
   **Not met.** Measured against real agents on six tasks, ripwire costs 83.5% of
   the baseline, saves about 5% on the median task, and costs *more* on three of the
   six. The first half of the requirement holds; the cost half does not. See
   [plan.md](plan.md).
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

These are the questions gating adoption of *either* tool. Questions 2 and 3 were
raised by `docs/294-lemoncrow-mcp-spike/` and are held here so all three sit in one
place; that doc points here rather than restating them, because two copies of a
question drift.

Both citations below were re-verified at source before being adopted, rather than
inherited.

1. **Which ripwire version do we pin, if the not-adopt verdict is overridden?**
   v0.3.8 (published 2026-08-13, satisfies requirement 6) or v0.4.0 (published
   2026-09-07, needs a waiver)? Measurement made this moot rather than answering it,
   so it stays open rather than being closed by inference.

2. **Is advertisement filtering enough, or does ShipIt need real per-server tool
   authorization?** LemonCrow can be reduced to a retrieval-only *advertised* surface
   today with no ShipIt change. But a hidden tool still executes when called by name,
   and ShipIt grants an enabled server its whole `mcp__<name>__*` namespace
   (`session/agents/claude/process.ts:448`, and again at `:887`), while the branch
   guard only matches the literal `Bash` — twice over, at
   `agent-hooks/managed-settings.json:50` and `block-branch-ops.mjs:70`. So the guard
   stays bypassable by a model that knows the tool name.

   This is **not LemonCrow-specific and not hypothetical**: it governs every user MCP
   server and is live today with nothing adopted. Whether ShipIt accepts that or gains
   a real authorization boundary is a product and security judgement. See
   [plan.md](plan.md) § "A ShipIt gap this evaluation surfaced".

3. **What does "must not change an existing session" require?** Enabled MCP servers
   are read from the account-wide credential store when a turn's run parameters are
   built (`orchestrator/session-agent-run-params.ts:111`), not snapshotted at session
   creation — so an existing session picks up a newly enabled server on its next turn.
   An "off by default" requirement therefore cannot be met by the existing settings
   surface alone. Whether it means per-session opt-in, or only "off until someone
   turns it on", is the human's call.

## Resolved questions

- 2026-09-07 — Do we adopt the vendor's 19 bundled skills? No. ShipIt already
  discloses about 25 skills, and doubling that catalogue costs context in every
  session. This is requirement 7.
- 2026-09-07 — Do we replace the agent's tool surface, as LemonCrow's runtime mode
  does? No. The user's prior evaluation (planning#332) rejected that shape, and the
  blockers it found are still true today. This is requirement 4, and the check that
  confirmed it is in [plan.md](plan.md).
