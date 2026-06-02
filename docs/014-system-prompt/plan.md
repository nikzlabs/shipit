# Project-Level System Prompt

Users can define a persistent system prompt sent to Claude with every message, encoding project conventions and style guidelines.

## Storage

Stored at `/workspace/.shipit/system-prompt.md`. If the file doesn't exist, no system prompt is sent (Claude CLI uses its default behavior, still picking up any top-level `CLAUDE.md`).

## How it works

1. **Before each Claude spawn**: Server reads `/workspace/.shipit/system-prompt.md`. If non-empty, passes as `--system-prompt` argument to Claude CLI.
2. **Writing**: `set_system_prompt` validates (string type, max 50KB), trims whitespace, creates `.shipit` directory if needed, writes file. Empty/whitespace-only content deletes the file.
3. **UI**: Gear icon in header opens `SystemPromptEditor` modal. Icon is blue when prompt is set, gray when empty. Textarea with character count, save/cancel, Escape to close, Ctrl+Enter to save.

## Key files

- `src/server/claude.ts` — `run()` accepts optional `systemPrompt`, passes `--system-prompt` to CLI
- `src/server/index.ts` — `readSystemPrompt()` helper, `get_system_prompt`/`set_system_prompt` handlers
- `src/server/types.ts` — System prompt WS messages
- `src/client/components/SystemPromptEditor.tsx` — Modal editor
- `src/client/App.tsx` — State management, gear icon
