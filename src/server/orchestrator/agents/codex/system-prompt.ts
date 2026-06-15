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
 * The prompt text lives in `system-prompt.md` next to this file (see
 * CLAUDE.md › "Prompts").
 *
 * See docs/117-agent-spawned-sessions/plan.md, docs/144-cross-agent-review/,
 * and docs/155 hair 9.
 */

import { loadPrompt } from "../../load-prompt.js";

export const CODEX_PARALLEL_SESSIONS_SECTION = loadPrompt(
  import.meta.url,
  "./system-prompt.md",
);
