/**
 * Agent run-params assembly (docs/149).
 *
 * Turns "we want to run this prompt on this session" into the full
 * `AgentRunParams` payload the CLI adapter expects: system prompt, settings
 * path, model, MCP servers, autoCreatePr gate, permission mode. Lives
 * outside any turn-execution module so the user path
 * (`runAgentWithMessage`) and the system-turn path (`runDispatchedTurn`) build
 * the same shape — without this, agent-spawned sessions used to run with no
 * system prompt, no settings (so neither the branch-block PreToolUse hook
 * nor the Stop-hook PR enforcement applied), no MCP, and no model.
 */

import type { AgentId, AgentRunParams, PermissionMode } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { buildAgentSystemInstructions } from "./agent-instructions.js";
import {
  getPrepareRunParams,
  type PrepareRunParamsFn,
} from "./agent-run-params-prep.js";

export interface BuildAgentRunParamsDeps {
  credentialStore: CredentialStore;
  /** Only `.authenticated` is read — keeps tests' stub manager compatible. */
  githubAuthManager: { authenticated: boolean };
  sessionManager: SessionManager;
  /**
   * Returns the user-configured system prompt suffix (Settings > Instructions).
   * Plumbed in from the WS handler context on the user path and from a
   * settings reader on the system-turn path.
   */
  readSystemPrompt: () => Promise<string | undefined>;
  /**
   * Returns the model alias/id selected for this turn. WS path reads the
   * per-connection selection; the system-turn path uses the session's
   * persisted model (set at spawn time).
   */
  getSelectedModel: () => string | undefined;
  /**
   * Per-agent run-params prep hooks (docs/155 Phase 3). Each backend's hook
   * injects its own backend-specific fields — Claude's adds `settingsPath`
   * and `autoCreatePr`; others are identity today. Optional so test setups
   * without the map fall back to the identity hook. See
   * `agent-run-params-prep.ts`.
   */
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
}

export interface BuildAgentRunParamsArgs {
  deps: BuildAgentRunParamsDeps;
  sessionId: string;
  agentId: AgentId;
  prompt: string;
  /** For `--resume` — undefined kicks off a fresh agent session. */
  agentSessionId?: string;
  /** Container path the agent runs in (workspace dir). */
  sessionDir: string;
  permissionMode?: PermissionMode;
}

/**
 * Assemble the agent run params. Mirrors the inline assembly in
 * `runAgentWithMessage`, minus the prompt-text composition (file/image
 * context, slash-command ordering) — that stays in the WS handler because
 * it depends on `validatedFiles` / `images` which only exist on the user
 * path.
 */
export async function buildAgentRunParams(
  args: BuildAgentRunParamsArgs,
): Promise<AgentRunParams> {
  const {
    deps,
    sessionId,
    agentId,
    prompt,
    sessionDir,
    permissionMode,
  } = args;
  let agentSessionId = args.agentSessionId;

  // Consume the conversation replay SYNCHRONOUSLY before any await — it's a
  // session-mutating DB transaction (clears the replay column). If the
  // session's database closes between an earlier `await` (e.g. the
  // `readSystemPrompt` fs read below) and this call, better-sqlite3 throws
  // `The database connection is not open`. The fix is order: every DB read
  // the function needs lives ahead of the first `await`, so the params
  // build either runs to completion or never starts. See docs/149.
  const agentInstructionsEnabled = deps.credentialStore.getAgentSystemInstructionsEnabled();
  const mcpServers = Object.values(deps.credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled,
  );
  const autoCreatePr = deps.credentialStore.getAutoCreatePr()
    && deps.githubAuthManager.authenticated;
  const replay = deps.sessionManager.consumeConversationReplay(sessionId);
  const selectedModel = deps.getSelectedModel();

  const userSystemPrompt = await deps.readSystemPrompt();

  const agentInstructions = agentInstructionsEnabled
    ? buildAgentSystemInstructions({ agentId })
    : undefined;
  let systemPrompt: string | undefined =
    [agentInstructions, userSystemPrompt].filter(Boolean).join("\n\n") || undefined;

  // If the session was graduating from a warm slot and carried a one-shot
  // conversation replay, append it to the system prompt and clear the
  // resume id so the CLI doesn't try to attach to a non-existent session.
  if (replay) {
    agentSessionId = undefined;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${replay}` : replay;
  }

  // docs/155 Phase 3 — `settingsPath` and `autoCreatePr` used to be injected
  // here behind an `agentId === "claude"` branch. Both are documented on
  // `AgentRunParams` as Claude-only; non-Claude adapters ignored them. The
  // shared shape now stays agent-agnostic — the per-agent prep hook below
  // decides which backend-specific fields to add.
  const baseParams: AgentRunParams = {
    prompt,
    cwd: sessionDir,
    ...(agentSessionId !== undefined ? { sessionId: agentSessionId } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  };
  const prepare = getPrepareRunParams(deps.runParamsPreps, agentId);
  return prepare(baseParams, { autoCreatePrActive: autoCreatePr });
}
