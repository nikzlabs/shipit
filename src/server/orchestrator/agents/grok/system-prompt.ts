/**
 * Grok-specific Parallel-sessions section (docs/274).
 *
 * Grok Build HAS an in-process subagent primitive (its `spawn_subagent` tool),
 * so the fragment follows Claude's and OpenCode's two-primitive shape rather
 * than Codex's session-create-only one. Like all three, it documents the
 * brokered one-shot `shipit agent run` (docs/144, docs/261) and warns that the
 * other CLIs are not authenticated inside the container.
 *
 * It carries one paragraph the others do not, and it is a fact about this CLI
 * rather than a style choice: Grok does not stream a subagent's internal steps
 * in headless mode (verified — `parent_tool_use_id` was null on every event of
 * every capture, including turns that ran `spawn_subagent`), so only the
 * spawn's return value ever reaches the transcript. An agent that assumes its
 * subagent's reasoning is visible will under-report.
 *
 * The prompt text lives in `system-prompt.md` next to this file (see
 * CLAUDE.md › "Prompts") — rendered once at module load, never per turn.
 */

import { loadPrompt } from "../../load-prompt.js";

export const GROK_PARALLEL_SESSIONS_SECTION = loadPrompt(
  import.meta.url,
  "./system-prompt.md",
);
