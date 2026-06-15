/**
 * Built-in system instructions prepended to the agent's system prompt.
 * These help the agent understand the ShipIt environment it operates in.
 *
 * Visible and toggleable in Settings > Instructions for transparency.
 *
 * The output is intentionally static within a session. There are exactly two
 * axes — `agentId` (Parallel sessions wording) and `isOps` (docs/128 ops
 * overlay) — and both are fixed for a session's lifetime. Every combination is
 * rendered ONCE at module load into `PRECOMPUTED_INSTRUCTIONS`; the exported
 * `buildAgentSystemInstructions` is a pure lookup with no per-turn assembly, so
 * the Anthropic prompt cache stays warm across turns. Dynamic per-machine
 * context (cwd, git status, env, memory paths) is moved into the first user
 * message by the CLI's `--exclude-dynamic-system-prompt-sections` flag, not
 * added to this prompt.
 *
 * Prompt TEXT lives in `prompts/*.md` next to this file (the `{{TOKEN}}`
 * skeleton plus one fragment per `.md`); this module owns only the COMPOSITION
 * — which fragment fills each token for a given axis. See CLAUDE.md › "Prompts".
 */

import type { AgentId } from "../shared/types.js";
import { loadPrompt, fillPromptTokens } from "./load-prompt.js";
import { CLAUDE_PARALLEL_SESSIONS_SECTION } from "./agents/claude/system-prompt.js";
import { CODEX_PARALLEL_SESSIONS_SECTION } from "./agents/codex/system-prompt.js";

/**
 * Per-agent "Parallel sessions" prompt fragments, keyed so the builder
 * does a single Map lookup instead of an `agentId === "claude"`/`"codex"`
 * if-cascade (docs/155 hair 9). The fragments themselves live in each
 * agent's `agents/<id>/system-prompt.ts`; this map only collects them
 * for the dispatcher below. Backends without a fragment register no
 * entry and fall through to the empty string at the call site.
 *
 * Kept local (and not derived from `buildAgentRuntime`'s
 * `parallelSessionsSections`) because the fragments are static module
 * constants and `buildAgentSystemInstructions` is also called from the
 * Settings UI baseline path that has no app-DI context.
 */
const PARALLEL_SESSIONS_SECTIONS: ReadonlyMap<AgentId, string> = new Map([
  ["claude", CLAUDE_PARALLEL_SESSIONS_SECTION],
  ["codex", CODEX_PARALLEL_SESSIONS_SECTION],
]);

export interface AgentSystemInstructionOptions {
  /**
   * Identity of the agent the prompt is being assembled for. Drives the
   * per-agent "when to reach for `shipit session create`" guidance in the
   * Parallel sessions section: Claude gets a "Task-first" rule (since the
   * `Task` tool already covers in-turn fan-out), while Codex — which has no
   * in-process subagent primitive — is told `shipit session create` is its
   * only fan-out primitive but is still heavy and user-visible. Omit to skip
   * the Parallel sessions section entirely (the default rendering used by
   * the no-options test fixture).
   *
   * `agentId` is fixed for a session's lifetime, so making it the only
   * branching axis preserves prompt-cache stability within a session.
   *
   * See docs/117-agent-spawned-sessions/plan.md.
   */
  agentId?: AgentId;
  /**
   * docs/128 — true when this is a privileged ops session
   * (`session.kind === "ops"`). It is a *second* fixed-for-the-session
   * branching axis, exactly like `agentId`, so it doesn't break the
   * prompt-cache-stability contract (the string is still static within a
   * session). When set, the builder:
   *
   *   - splices in an "Ops session" block that names the read-only privilege
   *     surface (Docker via the proxy, journal mounts) and the
   *     `journalctl -D /var/log/journal` rule, so the agent knows what it is
   *     and stops treating a privileged host-debug box like an app workspace;
   *   - swaps the aggressive "always open a PR" guidance for a read-only
   *     variant — an ops session investigates, it doesn't ship features;
   *   - drops the "scaffold a new project" best-practice bullet, which is
   *     nonsense in a host-debugging context.
   *
   * The shared base (environment, terminal, service logs, browser, platform
   * docs) is unchanged — ops is an overlay, not a separate prompt. Defaults
   * to false so the non-ops rendering is byte-identical to today.
   */
  isOps?: boolean;
}

// ---------------------------------------------------------------------------
// Prompt text. The base skeleton (`prompts/skeleton.md`) carries `{{TOKEN}}`
// holes; each conditional fragment is its own `.md`. This module only chooses
// which fragment fills each hole per axis (see `renderInstructions`). Loaded
// once at module init — a missing/renamed file throws here, failing the boot
// loudly rather than crashing mid-turn. See CLAUDE.md › "Prompts".
// ---------------------------------------------------------------------------
const SKELETON = loadPrompt(import.meta.url, "./prompts/skeleton.md");

// docs/128 — ops overlay, spliced in right after Environment.
const OPS_SECTION = loadPrompt(import.meta.url, "./prompts/ops-session.md");
// Pull requests: full action-oriented guidance vs the read-only ops variant.
const PULL_REQUESTS_STANDARD = loadPrompt(import.meta.url, "./prompts/pull-requests.md");
const PULL_REQUESTS_OPS = loadPrompt(import.meta.url, "./prompts/pull-requests-ops.md");
// docs/171 — release guidance, dropped for ops sessions.
const RELEASES = loadPrompt(import.meta.url, "./prompts/releases.md");
// docs/128 — the "scaffold a new project" best-practice bullet, dropped for ops.
const NEW_PROJECT_BEST_PRACTICE = loadPrompt(import.meta.url, "./prompts/new-project-best-practice.md");
// docs/128 — standard preview guidance vs the ops compose-services clarification.
const LIVE_PREVIEW = loadPrompt(import.meta.url, "./prompts/live-preview.md");
const COMPOSE_SERVICES_OPS = loadPrompt(import.meta.url, "./prompts/compose-services-ops.md");

/**
 * Assemble one variant of the agent system instructions. The only axes are
 * `agentId` (Parallel sessions wording) and `isOps` (docs/128 ops overlay) —
 * both fixed for a session's lifetime. This function does the section
 * composition, but it is NEVER called per-turn: every `(agentId, isOps)`
 * combination is rendered ONCE at module load into `PRECOMPUTED_INSTRUCTIONS`
 * below, and the public `buildAgentSystemInstructions` is a pure lookup. That
 * keeps the per-turn path free of any conditionals — each session always
 * reads the exact same frozen constant — which is what the Anthropic prompt
 * cache needs.
 */
function renderInstructions(
  agentId: AgentId | undefined,
  isOps: boolean,
): string {
  // Per-agent "when to reach for `shipit session create`" guidance. The
  // section is only emitted when an `agentId` is supplied — the no-options
  // rendering used by the Settings UI baseline and the no-options test
  // fixture skips it. Per-agent wording lives in
  // `agents/<id>/system-prompt.ts`; see docs/117 and docs/155 hair 9.
  const parallelSessionsSection = agentId
    ? PARALLEL_SESSIONS_SECTIONS.get(agentId) ?? ""
    : "";

  return fillPromptTokens(SKELETON, {
    OPS_SECTION: isOps ? OPS_SECTION : "",
    LIVE_PREVIEW: isOps ? COMPOSE_SERVICES_OPS : LIVE_PREVIEW,
    PULL_REQUESTS: isOps ? PULL_REQUESTS_OPS : PULL_REQUESTS_STANDARD,
    RELEASES: isOps ? "" : RELEASES,
    PARALLEL_SESSIONS: parallelSessionsSection,
    NEW_PROJECT_BEST_PRACTICE: isOps ? "" : NEW_PROJECT_BEST_PRACTICE,
  });
}

/**
 * Variant cache key. The rendered string depends only on which Parallel
 * sessions fragment applies and whether the ops overlay is on. An `agentId`
 * with no registered fragment renders identically to "no agent", so it maps to
 * the same empty-fragment key — that keeps the precomputed set finite and
 * complete (one entry per registered agent + the no-agent baseline, times the
 * two ops states).
 */
function variantKey(agentId: AgentId | undefined, isOps: boolean): string {
  const idPart = agentId && PARALLEL_SESSIONS_SECTIONS.has(agentId) ? agentId : "";
  return `${idPart}|${isOps ? "ops" : "std"}`;
}

/**
 * Every variant rendered ONCE at module load and frozen. Keyed by
 * `variantKey`. Built from the no-agent baseline plus each registered Parallel
 * sessions agent, each in both ops and non-ops form. Because `agentId` and
 * `isOps` are both fixed for a session's lifetime, a session reads exactly one
 * of these constants for its entire life — the per-turn path never re-assembles
 * a prompt, so the string handed to the CLI is byte-stable across turns and the
 * Anthropic prompt cache stays warm.
 */
const PRECOMPUTED_INSTRUCTIONS: ReadonlyMap<string, string> = (() => {
  const agentIds: readonly (AgentId | undefined)[] = [
    undefined,
    ...PARALLEL_SESSIONS_SECTIONS.keys(),
  ];
  const map = new Map<string, string>();
  for (const id of agentIds) {
    for (const isOps of [false, true]) {
      map.set(variantKey(id, isOps), renderInstructions(id, isOps));
    }
  }
  return map;
})();

/**
 * Return the prebuilt agent system instructions for this session. Pure lookup —
 * no string assembly, no conditionals affecting the returned content — so every
 * turn of a given session gets the identical frozen string. The conditional
 * axes (`agentId`, `isOps`) are both fixed for a session's lifetime; the actual
 * composition happened once at module load (see `renderInstructions` /
 * `PRECOMPUTED_INSTRUCTIONS`).
 */
export function buildAgentSystemInstructions(
  options: AgentSystemInstructionOptions = {},
): string {
  return PRECOMPUTED_INSTRUCTIONS.get(
    variantKey(options.agentId, options.isOps ?? false),
  )!;
}

/**
 * Cached rendering of the agent system instructions with no agentId. Used by
 * the Settings UI baseline. The per-turn rendering in agent-execution.ts
 * passes the session's actual `agentId` so the running agent sees the
 * matching Parallel sessions section.
 */
export const AGENT_SYSTEM_INSTRUCTIONS = buildAgentSystemInstructions();
