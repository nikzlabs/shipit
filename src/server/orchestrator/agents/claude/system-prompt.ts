/**
 * Claude-specific Parallel-sessions section.
 *
 * Claude has the in-process `Task` tool for in-turn fan-out, so the wording
 * distinguishes when to reach for `Task` vs `shipit session create`. Codex
 * (and any future backend without an in-process subagent primitive) gets the
 * shorter section in `../codex/system-prompt.ts`.
 *
 * Both variants also document the brokered one-shot `shipit agent run`
 * (docs/144) in its two shapes (docs/261): `--role reviewer`, where the agent
 * names the role and ShipIt names the reviewer, and the fully explicit spawn
 * that names all five parameters. Both warn that the raw `codex`/`claude` CLI is
 * NOT authenticated inside the container (per-agent credential isolation), so a
 * second opinion must go through the brokered shim, never the bare CLI.
 *
 * The prompt text lives in `system-prompt.md` next to this file (see
 * CLAUDE.md › "Prompts").
 *
 * See docs/117-agent-spawned-sessions/plan.md, docs/144-cross-agent-review/,
 * docs/261-configurable-reviewer/, and docs/155 hair 9.
 */

import { loadPrompt } from "../../load-prompt.js";

export const CLAUDE_PARALLEL_SESSIONS_SECTION = loadPrompt(
  import.meta.url,
  "./system-prompt.md",
);
