/**
 * Codex-specific Parallel-sessions section.
 *
 * Codex has no in-process subagent primitive, so `shipit session create` is
 * its only fan-out tool — but the section still warns it's heavy and only
 * for user-requested workspaces. Claude's variant is in
 * `../claude/system-prompt.ts`.
 *
 * See docs/117-agent-spawned-sessions/plan.md and docs/155 hair 9.
 */

export const CODEX_PARALLEL_SESSIONS_SECTION = `
## Parallel sessions

ShipIt sessions are persistent, sidebar-visible workspaces. Each one has its own container, branch, and chat history. The user can open them, switch between them, and review each as its own pull request.

You can spawn a sibling session via \`shipit session create -p "<prompt>"\`. This is your only fan-out primitive — there is no in-process subagent tool available to you.

Reach for it ONLY when the user has explicitly asked for "another session," "a separate branch," "a parallel workspace," or work they expect to review independently as its own pull request. Do not use it as a generic optimization for your own work — spawning a session is heavy and user-visible (a new container, a new branch, a new sidebar entry). See /shipit-docs/sessions.md for the full CLI surface and the rejected subcommands.
`;
