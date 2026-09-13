---
issue: planning#545
title: System prompt — Your Instructions and the ops block
description: The user's own instruction blocks, how the standard and ops scopes are stored, and which one a turn uses.
---

# System Prompt

Users can define a persistent system prompt appended to the agent's instructions
on every turn, encoding project conventions and style guidelines. Implements
[`requirements.md`](requirements.md).

It is a **global** setting, not a per-project one: one prompt applies to every
session. The original design (and this doc's earlier text) described it as
project-level; that is no longer what the code does.

## Two scopes: standard and ops

There are two blocks, and a turn uses exactly one of them (req 6). A session
whose `kind` is `ops` uses the **ops** block; every other session — including a
sandbox — uses the **standard** block (req 7).

The split exists because ShipIt gives an ops session internal instructions of
its own (`prompts/ops-session.md`: read-only host debugging, no scaffolding, no
PR flow), and the standard block is where a user writes ordinary project
conventions that contradict them (req 4).

Replacement is total. An ops session never sees the standard block, and an empty
ops block means an ops session gets **no** user instructions rather than falling
back (req 6) — so the interference the split exists to remove is gone before the
user writes anything.

## Storage

Two files under `<appWorkspaceDir>/.shipit/`, selected by `SystemPromptScope`:

| Scope | File |
|---|---|
| `standard` | `system-prompt.md` |
| `ops` | `system-prompt-ops.md` |

`appWorkspaceDir` is the **orchestrator's own workspace root** (`/workspace` in
production, the directory holding `sessions/`), never a session's git clone.
Nothing ShipIt generates is written into a clone's `.shipit/`
(`no-clone-writes.test.ts` enforces this).

If a file is missing or blank, that scope contributes no user prompt.

## How it works

1. **Reading**: `readGlobalSystemPrompt(appWorkspaceDir, scope)` returns the
   trimmed content, or `undefined` when the file is missing, unreadable, or
   blank. `scope` defaults to `standard`.
2. **Choosing the scope**: `session-agent-run-params.ts` already derives `isOps`
   from the session row (`sessionInfo.kind`), and passes
   `isOps ? "ops" : "standard"` to the reader. The scope is therefore decided
   per turn from persisted session state, not from the connection.
3. **Composing**: the same file joins ShipIt's own
   `buildAgentSystemInstructions()` output and the chosen user block with a
   blank line, and passes the result as the run's `systemPrompt`.
4. **Delivering**: `ClaudeProcess.run()` writes that text to a temp file and
   passes `--append-system-prompt-file` (plus
   `--exclude-dynamic-system-prompt-sections`). It deliberately does **not** use
   `--system-prompt`: appending preserves the CLI's default preamble, which
   keeps the cross-user prompt cache warm.
5. **Writing**: `writeGlobalSystemPrompt(appWorkspaceDir, content, scope)` trims
   and writes the file; blank content deletes it, so clearing a box means "no
   prompt" rather than "an empty prompt". `saveGlobalSettings()` validates
   **both** blocks against the 50,000-character maximum before writing either,
   so one over-long box cannot leave the other half of the tab persisted.
6. **UI**: the Instructions tab of the Settings modal, which holds both boxes —
   "Your Instructions" and "Ops Session Instructions" — each with its own
   character count against the 50,000 limit, under one Save button that is
   disabled when *either* box is over. `getGlobalSettings()` returns the two as
   `settings.systemPrompt` and `settings.systemPromptOps`; the client saves both
   in one `PUT /api/settings`.

The WebSocket `get_system_prompt` / `set_system_prompt` handlers this doc used to
name were removed — read and write both go through the global-settings HTTP
route now.

## Key files

- `src/server/orchestrator/global-system-prompt.ts` — `SystemPromptScope`, the
  scope-to-file map, `globalSystemPromptPath()`, `readGlobalSystemPrompt()`,
  `writeGlobalSystemPrompt()`
- `src/server/orchestrator/services/settings.ts` — `getGlobalSettings()` exposes
  `systemPrompt` and `systemPromptOps`; `validatedSystemPrompt()` checks each
  before `saveGlobalSettings()` writes any
- `src/server/orchestrator/api-routes-bootstrap.ts` — `PUT /api/settings`
- `src/server/orchestrator/session-agent-run-params.ts` — picks the scope from
  the session kind, then joins the agent instructions and the user prompt into
  the run's `systemPrompt`
- `src/server/session/agents/claude/process.ts` — passes
  `--append-system-prompt-file` to the Claude CLI
- `src/client/components/Settings/tabs/InstructionsTab.tsx` — both editors
- `src/client/stores/settings-store.ts` — `systemPromptContent`,
  `systemPromptOpsContent`, `saveInstructions()`

## Tests

- `src/server/orchestrator/global-system-prompt.test.ts` — the two scopes round
  trip to separate files and neither reads the other's text.
- `src/server/orchestrator/integration_tests/system-prompt.test.ts` — an ops
  session gets the ops block; an ops session with an empty ops block gets no
  user instructions even when the standard block is set; a standard session is
  unaffected by an ops block.
- `src/client/components/Settings.test.tsx` — the tab saves the two boxes as
  separate values, and an over-long ops block disables Save.
