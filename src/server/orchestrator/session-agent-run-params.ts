import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import type { AgentId, AgentRunParams, PermissionMode } from "../shared/types.js";
import type { CredentialStore } from "./credential-store.js";
import type { SessionManager } from "./sessions.js";
import { buildAgentSystemInstructions } from "./agent-instructions.js";
import {
  getPrepareRunParams,
  type PrepareRunParamsFn,
} from "./agent-run-params-prep.js";
import { serviceRoutingForSelection } from "./service-routing.js";

export interface BuildAgentRunParamsDeps {
  credentialStore: CredentialStore;
  githubAuthManager: { authenticated: boolean };
  sessionManager: SessionManager;
  readSystemPrompt: () => Promise<string | undefined>;
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
  let agentSessionId = args.agentSessionId;

  // Finish DB reads before the first await; shutdown can close the connection during it.
  const agentInstructionsEnabled = deps.credentialStore.getAgentSystemInstructionsEnabled();
  const mcpServers = Object.values(deps.credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled,
  );
  const replay = deps.sessionManager.consumeConversationReplay(sessionId);
  const sessionInfo = deps.sessionManager.get(sessionId);
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

  const userSystemPrompt = await deps.readSystemPrompt();

  const agentInstructions = agentInstructionsEnabled
    ? buildAgentSystemInstructions({ agentId, isOps, isSandbox })
    : undefined;
  let systemPrompt: string | undefined =
    [agentInstructions, userSystemPrompt].filter(Boolean).join("\n\n") || undefined;

  // Replay starts a fresh CLI conversation; resuming could restore deliberately excluded turns.
  if (replay) {
    agentSessionId = undefined;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${replay}` : replay;
  }

  const baseParams: AgentRunParams = {
    prompt,
    cwd: sessionDir,
    ...(agentSessionId !== undefined ? { sessionId: agentSessionId } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
    ...(serviceRouting !== undefined ? { serviceRouting } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(compact ? { compact: true } : {}),
  };
  const prepare = getPrepareRunParams(deps.runParamsPreps, agentId);
  return prepare(baseParams, {
    autoCreatePrActive: autoCreatePr,
    sandboxActive: isSandbox,
    guardDestructiveGitActive: guardDestructiveGit,
  });
}
