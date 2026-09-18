# Native goal command (CLI-backed)

Plan: [plan.md](plan.md). Tracked in planning#31.

1. While a Codex session has a goal, the chat always shows it — including a goal the model created itself with its `create_goal` tool.
2. The user can clear the goal from chat with `/goal clear`.
3. The user can set a goal with `/goal <objective>`, see it with `/goal` or `/goal status`, pause it with `/goal pause`, and resume it with `/goal resume`.
4. A `/goal` command on a goal-capable agent is handled by ShipIt and is never sent to the agent as a prompt.
5. The `/` menu offers `/goal` only when the active agent supports goals; Claude, OpenCode and Grok sessions do not offer it.
6. The goal shown is correct after an orchestrator restart, a page reload, and a session switch.
7. Codex goal mode is on only when ShipIt can show and control it.
8. How Codex's own goal-continuation loop fits ShipIt ending the Codex process at each turn's end is decided and recorded in this feature's docs. Automatic continuation across turns may be a follow-up.

## Open questions

- None.

## Resolved questions

- 2026-09-12 — Req 5's list of agents that do not offer `/goal` was a statement
  of what had a goal surface in 2026-09, not a requirement that they never
  would. Claude Code and Grok both turned out to have one; they are added in
  [docs/297](../297-goal-on-claude/requirements.md) and its Grok sibling. The
  requirement itself is unchanged: the menu offers `/goal` only where the active
  agent supports it.
- 2026-09-11 — Must Codex continue a goal by itself between user turns in this change? The Ops spawn brief (from a production incident: a model-created goal the user could not see or clear) set the minimum: the goal must be visible and clearable; auto-continuation across turns can be a follow-up if it is large. It delegated the decision to the implementing session. Recorded as req 8; the decision is in plan.md "Continuation".
