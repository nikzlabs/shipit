/**
 * Codex-specific Parallel-sessions section.
 *
 * Codex has no in-process subagent primitive, so `shipit session create` is
 * its only fan-out tool — but the section still warns it's heavy and only
 * for user-requested workspaces. Claude's variant is in
 * `../claude/system-prompt.ts`.
 *
 * Like the Claude variant, it documents the cross-agent consultation primitive
 * `shipit agent run --agent claude --prompt-file -` (docs/144) and warns that
 * the raw `claude`/`codex` CLI is NOT authenticated inside the container
 * (per-agent credential isolation), so a second opinion from another backend
 * must go through the brokered shim, never the bare CLI.
 *
 * See docs/117-agent-spawned-sessions/plan.md, docs/144-cross-agent-review/,
 * and docs/155 hair 9.
 */

export const CODEX_PARALLEL_SESSIONS_SECTION = `
## Parallel sessions

ShipIt sessions are persistent, sidebar-visible workspaces. Each one has its own container, branch, and chat history. The user can open them, switch between them, and review each as its own pull request.

You can spawn a sibling session via \`shipit session create --prompt-file -\` (the prompt is read from stdin or a file, never an inline \`-p\` — pass it with a single-quoted heredoc like \`gh pr create --body-file -\`, so backticks and \`$(...)\` in the prompt aren't evaluated by the shell). This is your only fan-out primitive — there is no in-process subagent tool available to you.

Reach for it ONLY when the user has explicitly asked for "another session," "a separate branch," "a parallel workspace," or work they expect to review independently as its own pull request. Do not use it as a generic optimization for your own work — spawning a session is heavy and user-visible (a new container, a new branch, a new sidebar entry). See /shipit-docs/sessions.md for the full CLI surface and the rejected subcommands.

### Consulting a DIFFERENT agent backend (e.g. Claude) — \`shipit agent run\`

\`shipit session create\` above runs **another copy of you** (Codex) in its own workspace. When the user instead wants a *different model/backend* in the loop — "consult Claude," "ask the other agent," "get a second opinion from a different model," "have Claude review this" — use the brokered one-shot:

- **\`shipit agent run --agent claude --prompt-file -\`** spawns ANOTHER registered agent (here, Claude), blocks until it returns, and prints its final text on stdout for you to read and synthesize **in this turn**. It is a one-shot consultation / second opinion / bounded delegation — it does NOT create a sidebar session or its own PR, and its work commits under your session. Pass the prompt via stdin/heredoc (\`--prompt-file -\`, never an inline \`-p\`) and put ALL the context the other agent needs INTO that prompt — the task, the relevant \`git diff\`, file references — because it does not share your conversation. Requires the "Multi-agent sessions" setting. Unlike \`shipit session create\`, this is NOT a fan-out of your own work — it is a synchronous call to a different brain whose answer you fold into this turn.
- **Do NOT invoke the raw \`claude\` (or \`codex\`) CLI directly to consult another agent.** Per-agent credential isolation mounts only the pinned agent's credentials in this container, so the bare \`claude\` CLI fails with 401 Unauthorized. The brokered \`shipit agent run\` — which supplies the other agent's credentials server-side — is the ONLY working path. See /shipit-docs/agent.md and docs/144-cross-agent-review/ for the full surface.
`;
