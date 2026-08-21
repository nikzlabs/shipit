/**
 * OpenCode-specific Parallel-sessions section (docs/268).
 *
 * OpenCode HAS an in-process subagent primitive (its `task` tool), so the
 * fragment follows Claude's two-primitive shape rather than Codex's
 * session-create-only one. Like both, it documents the brokered one-shot
 * `shipit agent run` (docs/144, docs/261) and warns that the raw
 * `claude`/`codex` CLIs are not authenticated inside the container.
 *
 * The prompt text lives in `system-prompt.md` next to this file (see
 * CLAUDE.md › "Prompts") — rendered once at module load, never per turn.
 */

import { loadPrompt } from "../../load-prompt.js";

export const OPENCODE_PARALLEL_SESSIONS_SECTION = loadPrompt(
  import.meta.url,
  "./system-prompt.md",
);
