# System Prompt

Users can define a persistent system prompt appended to the agent's instructions
on every turn, encoding project conventions and style guidelines.

It is a **global** setting, not a per-project one: one prompt applies to every
session. The original design (and this doc's earlier text) described it as
project-level; that is no longer what the code does.

## Storage

Stored at `<appWorkspaceDir>/.shipit/system-prompt.md` — `appWorkspaceDir` is the
**orchestrator's own workspace root** (`/workspace` in production, the directory
holding `sessions/`), never a session's git clone. Nothing ShipIt generates is
written into a clone's `.shipit/` (`no-clone-writes.test.ts` enforces this).

If the file is missing or blank, no user prompt is appended.

## How it works

1. **Reading**: `readGlobalSystemPrompt(appWorkspaceDir)` returns the trimmed
   content, or `undefined` when the file is missing, unreadable, or blank.
2. **Composing**: `session-agent-run-params.ts` joins ShipIt's own
   `buildAgentSystemInstructions()` output and the user's prompt with a blank
   line, and passes the result as the run's `systemPrompt`.
3. **Delivering**: `ClaudeProcess.run()` writes that text to a temp file and
   passes `--append-system-prompt-file` (plus
   `--exclude-dynamic-system-prompt-sections`). It deliberately does **not** use
   `--system-prompt`: appending preserves the CLI's default preamble, which
   keeps the cross-user prompt cache warm.
4. **Writing**: `writeGlobalSystemPrompt(appWorkspaceDir, content)` trims and
   writes the file; blank content deletes it, so clearing the box means "no
   prompt" rather than "an empty prompt". `saveGlobalSettings()` validates the
   50,000-character maximum before calling it.
5. **UI**: the Instructions tab of the Settings modal. Textarea with a character
   count against the 50,000 limit and a Save button. `getGlobalSettings()`
   returns the current content as `settings.systemPrompt`; the client saves via
   `PUT /api/settings` with a `systemPrompt` body field.

The WebSocket `get_system_prompt` / `set_system_prompt` handlers this doc used to
name were removed — read and write both go through the global-settings HTTP
route now.

## Key files

- `src/server/orchestrator/global-system-prompt.ts` — `globalSystemPromptPath()`,
  `readGlobalSystemPrompt()`, `writeGlobalSystemPrompt()`
- `src/server/orchestrator/services/settings.ts` — `getGlobalSettings()` exposes
  `systemPrompt`; `saveGlobalSettings()` validates and persists it
- `src/server/orchestrator/api-routes-bootstrap.ts` — `PUT /api/settings`
- `src/server/orchestrator/session-agent-run-params.ts` — joins the agent
  instructions and the user prompt into the run's `systemPrompt`
- `src/server/session/agents/claude/process.ts` — passes
  `--append-system-prompt-file` to the Claude CLI
- `src/client/components/Settings/tabs/InstructionsTab.tsx` — the editor
- `src/client/stores/settings-store.ts` — `systemPromptContent`,
  `saveInstructions()`
