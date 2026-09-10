import type { AgentId } from "../shared/types.js";
import { loadPrompt, fillPromptTokens } from "./load-prompt.js";
import { CLAUDE_PARALLEL_SESSIONS_SECTION } from "./agents/claude/system-prompt.js";
import { CODEX_PARALLEL_SESSIONS_SECTION } from "./agents/codex/system-prompt.js";
import { OPENCODE_PARALLEL_SESSIONS_SECTION } from "./agents/opencode/system-prompt.js";
import { GROK_PARALLEL_SESSIONS_SECTION } from "./agents/grok/system-prompt.js";

// Settings also uses this builder without app dependency injection.
const PARALLEL_SESSIONS_SECTIONS: ReadonlyMap<AgentId, string> = new Map([
  ["claude", CLAUDE_PARALLEL_SESSIONS_SECTION],
  ["codex", CODEX_PARALLEL_SESSIONS_SECTION],
  ["opencode", OPENCODE_PARALLEL_SESSIONS_SECTION],
  ["grok", GROK_PARALLEL_SESSIONS_SECTION],
]);

export interface AgentSystemInstructionOptions {
  agentId?: AgentId;
  isOps?: boolean;
  isSandbox?: boolean;
}

const SKELETON = loadPrompt(import.meta.url, "./prompts/skeleton.md");

const OPS_SECTION = loadPrompt(import.meta.url, "./prompts/ops-session.md");
const SANDBOX_SECTION = loadPrompt(import.meta.url, "./prompts/sandbox-session.md");
const GIT_WORKFLOW_STANDARD = loadPrompt(import.meta.url, "./prompts/git-workflow.md");
const GIT_WORKFLOW_SANDBOX = loadPrompt(import.meta.url, "./prompts/git-workflow-sandbox.md");
const GIT_WORKFLOW_OPS = loadPrompt(import.meta.url, "./prompts/git-workflow-ops.md");
const PULL_REQUESTS_STANDARD = loadPrompt(import.meta.url, "./prompts/pull-requests.md");
const PULL_REQUESTS_OPS = loadPrompt(import.meta.url, "./prompts/pull-requests-ops.md");
const PULL_REQUESTS_SANDBOX = loadPrompt(import.meta.url, "./prompts/pull-requests-sandbox.md");
const RELEASES = loadPrompt(import.meta.url, "./prompts/releases.md");
const NEW_PROJECT_BEST_PRACTICE = loadPrompt(import.meta.url, "./prompts/new-project-best-practice.md");
const LIVE_PREVIEW = loadPrompt(import.meta.url, "./prompts/live-preview.md");
const COMPOSE_SERVICES_OPS = loadPrompt(import.meta.url, "./prompts/compose-services-ops.md");
const CODEX_IMPLIED_ACTION = loadPrompt(
  import.meta.url,
  "./agents/codex/implied-action.md",
);
const IMPLIED_ACTION_SECTIONS: ReadonlyMap<AgentId, string> = new Map([
  ["codex", CODEX_IMPLIED_ACTION],
]);

type SessionMode = "std" | "ops" | "sandbox";

function sessionMode(isOps: boolean, isSandbox: boolean): SessionMode {
  if (isOps) return "ops";
  if (isSandbox) return "sandbox";
  return "std";
}

function renderInstructions(
  agentId: AgentId | undefined,
  mode: SessionMode,
): string {
  const isOps = mode === "ops";
  const isSandbox = mode === "sandbox";

  const parallelSessionsSection = agentId
    ? PARALLEL_SESSIONS_SECTIONS.get(agentId) ?? ""
    : "";

  return fillPromptTokens(SKELETON, {
    OPS_SECTION: isOps ? OPS_SECTION : isSandbox ? SANDBOX_SECTION : "",
    GIT_WORKFLOW: isOps ? GIT_WORKFLOW_OPS : isSandbox ? GIT_WORKFLOW_SANDBOX : GIT_WORKFLOW_STANDARD,
    LIVE_PREVIEW: isOps ? COMPOSE_SERVICES_OPS : isSandbox ? "" : LIVE_PREVIEW,
    PULL_REQUESTS: isOps ? PULL_REQUESTS_OPS : isSandbox ? PULL_REQUESTS_SANDBOX : PULL_REQUESTS_STANDARD,
    RELEASES: isOps || isSandbox ? "" : RELEASES,
    PARALLEL_SESSIONS: parallelSessionsSection,
    IMPLIED_ACTION: agentId ? IMPLIED_ACTION_SECTIONS.get(agentId) ?? "" : "",
    NEW_PROJECT_BEST_PRACTICE: isOps || isSandbox ? "" : NEW_PROJECT_BEST_PRACTICE,
  });
}

function variantKey(agentId: AgentId | undefined, mode: SessionMode): string {
  const idPart = agentId && PARALLEL_SESSIONS_SECTIONS.has(agentId) ? agentId : "";
  return `${idPart}|${mode}`;
}

// Precompute session-fixed variants to keep system prompts byte-stable across turns.
const PRECOMPUTED_INSTRUCTIONS: ReadonlyMap<string, string> = (() => {
  const agentIds: readonly (AgentId | undefined)[] = [
    undefined,
    ...PARALLEL_SESSIONS_SECTIONS.keys(),
  ];
  const modes: readonly SessionMode[] = ["std", "ops", "sandbox"];
  const map = new Map<string, string>();
  for (const id of agentIds) {
    for (const mode of modes) {
      map.set(variantKey(id, mode), renderInstructions(id, mode));
    }
  }
  return map;
})();

export function buildAgentSystemInstructions(
  options: AgentSystemInstructionOptions = {},
): string {
  return PRECOMPUTED_INSTRUCTIONS.get(
    variantKey(options.agentId, sessionMode(options.isOps ?? false, options.isSandbox ?? false)),
  )!;
}

export const AGENT_SYSTEM_INSTRUCTIONS = buildAgentSystemInstructions();
