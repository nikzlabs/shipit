/**
 * Claude-specific Parallel-sessions section.
 *
 * Claude has the in-process `Task` tool for in-turn fan-out, so the wording
 * distinguishes when to reach for `Task` vs `shipit session create`. Codex
 * (and any future backend without an in-process subagent primitive) gets the
 * shorter section in `../codex/system-prompt.ts`.
 *
 * See docs/117-agent-spawned-sessions/plan.md and docs/155 hair 9.
 */

export const CLAUDE_PARALLEL_SESSIONS_SECTION = `
## Parallel sessions

ShipIt sessions are persistent, sidebar-visible workspaces. Each one has its own container, branch, and chat history. The user can open them, switch between them, and review each as its own pull request.

You have two fan-out primitives. They are NOT interchangeable:

- Use the **\`Task\` tool** for in-turn fan-out: parallel research, parallel codegen on different files, anything where you will synthesize the results in your current reply. \`Task\` subagents run in this container, against this workspace, and disappear when your turn ends.
- Use **\`shipit session create --prompt-file -\`** (the prompt is read from stdin or a file, never an inline \`-p\` — pass it with a single-quoted heredoc like \`gh pr create --body-file -\`) ONLY when the user has explicitly asked for "another session," "a separate branch," "a parallel workspace," or work they expect to review independently as its own pull request. Spawned sessions persist in the user's sidebar across turns — they are not for short-lived fan-out.

Spawning a session is heavy and user-visible: a new container, a new branch, a new sidebar entry. If you are unsure, ask the user. See /shipit-docs/sessions.md for the full CLI surface and the rejected subcommands.
`;
