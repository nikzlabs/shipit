import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import type { AgentId, AgentRunParams, PermissionMode } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { buildAgentSystemInstructions } from "./agent-instructions.js";
import type { SystemPromptScope } from "./global-system-prompt.js";
import {
  getPrepareRunParams,
  type PrepareRunParamsFn,
} from "./agent-run-params-prep.js";
import { serviceRoutingForSelection } from "./service-routing.js";
import { recordStatusCardSpawn } from "./session-status-spawn-record.js";
import { recordServiceMcpSpawn, type SessionServiceMcp } from "./service-mcp.js";
import { boundStoredReplay } from "./services/replay.js";

export interface BuildAgentRunParamsDeps {
  credentialStore: CredentialStore;
  githubAuthManager: { authenticated: boolean };
  sessionManager: SessionManager;
  readSystemPrompt: (scope: SystemPromptScope) => Promise<string | undefined>;
  getSelectedModel: () => string | undefined;
  getSelectedReasoning?: () => string | undefined;
  runParamsPreps?: Map<AgentId, PrepareRunParamsFn>;
}

export interface BuildAgentRunParamsArgs {
  turnRoute?: { kind: ProviderRouteKind; id: string };
  deps: BuildAgentRunParamsDeps;
  sessionId: string;
  agentId: AgentId;
  prompt: string;
  agentSessionId?: string;
  sessionDir: string;
  permissionMode?: PermissionMode;
  compact?: boolean;
  /** docs/327 — the session's declared MCP servers (`resolveServiceMcp`). */
  serviceMcp?: SessionServiceMcp | null;
}

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
    compact,
  } = args;
  const agentSessionId = args.agentSessionId;

  // Finish DB reads before the first await; shutdown can close the connection during it.
  const agentInstructionsEnabled = deps.credentialStore.getAgentSystemInstructionsEnabled();
  const serviceMcpServers = args.serviceMcp?.servers ?? [];
  const serviceMcpCandidates = args.serviceMcp?.candidates ?? [];
  const mcpServers = Object.values(deps.credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled,
  );
  const sessionInfo = deps.sessionManager.get(sessionId);
  // Read, not taken: a spawn that fails before the CLI reports its conversation keeps it
  // for the next spawn. A stored id is always resumed; a replay only starts a conversation.
  const storedReplay = agentSessionId === undefined ? sessionInfo?.conversationReplay : undefined;
  const replay = storedReplay ? boundStoredReplay(storedReplay) : undefined;
  const resumeAt = agentSessionId !== undefined ? sessionInfo?.agentResumeAt : undefined;
  // Prefer the session row: another viewer may have changed the connection's selection.
  const selectedModel = sessionInfo?.model ?? deps.getSelectedModel();
  const reasoningEffort = sessionInfo?.reasoningEffort ?? deps.getSelectedReasoning?.();
  const serviceRouting = sessionInfo
    ? serviceRoutingForSelection(
        agentId,
        sessionInfo.serviceId && sessionInfo.billingMode && sessionInfo.model
          ? {
              serviceId: sessionInfo.serviceId,
              billingMode: sessionInfo.billingMode,
              modelId: sessionInfo.model,
            }
          : undefined,
        args.turnRoute,
        deps.credentialStore,
      )
    : undefined;
  const sessionKind = sessionInfo?.kind;
  const isOps = sessionKind === "ops";
  const isSandbox = sessionKind === "sandbox";
  const guardDestructiveGit = Boolean(sessionInfo?.mergedHeadSha);
  // A sandbox has no bound repository or session branch for automatic PR enforcement.
  const autoCreatePr = !isSandbox
    && deps.credentialStore.getAutoCreatePr()
    && deps.githubAuthManager.authenticated;
  const sessionStatusCard = deps.credentialStore.getSessionStatusCard();
  // Only a spawning turn builds run params, so this is the value the process
  // about to start will hold until it is retired.
  recordStatusCardSpawn(sessionId, sessionStatusCard);
  recordServiceMcpSpawn(sessionId, serviceMcpServers);

  const userSystemPrompt = await deps.readSystemPrompt(isOps ? "ops" : "standard");

  const agentInstructions = agentInstructionsEnabled
    ? buildAgentSystemInstructions({ agentId, isOps, isSandbox, sessionStatusCard })
    : undefined;
  const systemPrompt: string | undefined =
    [agentInstructions, userSystemPrompt].filter(Boolean).join("\n\n") || undefined;

  // A compaction before a fork's first turn has nothing to compact, and the CLI reads
  // `/compact` only as the whole message: the replay goes alone and starts the conversation.
  const compactsNothing = compact === true && replay !== undefined;
  const baseParams: AgentRunParams = {
    // docs/007 req 8 — the first user message, which the CLI stores; a system prompt it does not.
    prompt: replay ? (compactsNothing ? replay : `${replay}\n\n${prompt}`) : prompt,
    cwd: sessionDir,
    ...(agentSessionId !== undefined ? { sessionId: agentSessionId } : {}),
    ...(resumeAt ? { resumeAt } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
    ...(serviceRouting !== undefined ? { serviceRouting } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(serviceMcpServers.length > 0 ? { serviceMcpServers } : {}),
    ...(serviceMcpCandidates.length > 0 ? { serviceMcpCandidates } : {}),
    ...(sessionStatusCard ? { sessionStatusCard: true } : {}),
    ...(compact && !compactsNothing ? { compact: true } : {}),
  };
  const prepare = getPrepareRunParams(deps.runParamsPreps, agentId);
  return prepare(baseParams, {
    autoCreatePrActive: autoCreatePr,
    sandboxActive: isSandbox,
    guardDestructiveGitActive: guardDestructiveGit,
  });
}
