import { ensureManagedOpenCodeData } from "../shared/opencode-account.js";
import { perSessionCredentialsDir } from "./session-credentials-scaffold.js";
import { revokeOpenCodeAccount } from "./openai-account-delivery.js";
import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import path from "node:path";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { CredentialStore } from "./credential-store.js";
import type { ServiceManager } from "./service-manager.js";
import type { AgentId, SessionInfo } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  ensureLocalWorkspaceTrust,
  ensureSessionAgentUserConfig,
  ensureSessionAccountCredentials,
  provisionAgentCredentials,
  provisionRepoMemory,
  readSessionAccountMarker,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
  syncMemoryBack,
  repushAgentToken,
  repushProviderAccountToken,
  writeSessionResidentRoute,
} from "./session-credentials.js";
import {
  startTokenWriteBackWatch,
  stopTokenWriteBackWatch,
} from "./session-token-publisher.js";
import {
  clearAgentHomeCredentialLinks,
  isLocalRuntime,
  linkAgentHomeToCredentials,
} from "./local-agent-credentials.js";
import { repoUrlToHash } from "./git-utils.js";
import { agentHome, codexHome } from "../shared/agent-home.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import { accountServiceForHarness, providerAccountCredentialRoot } from "./provider-account-manager.js";
import { routeFromSelection } from "./provider-route-preflight.js";
import {
  markCredentialRouteUsed,
  firstEligibleSelectionForHarness,
  selectRouteForSelection,
} from "./service-routing.js";
import type { ModelSelection } from "../shared/catalogue/index.js";
import { ensureCodexHomeInitialized } from "./agents/codex/home-init.js";
import { ensureLocalAgentOpsHost } from "./local-agent-ops.js";
import { refreshExpiredMcpOAuthTokens } from "./services/mcp-oauth.js";
import { collectAccountAgentEnv, collectServiceCredentialEnv } from "./secret-resolver.js";
import {
  credentialStorageEnvNames,
  getService,
  loginIntegrationForService,
  nativeServiceForHarness,
} from "../shared/catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "../shared/types/domain-types/credential-route.js";
import { buildConversationReplay } from "./services/replay.js";
import { getErrorMessage } from "./validation.js";

export const MCP_OAUTH_REFRESH_TIMEOUT_MS = 8_000;
export const PUSH_AGENT_SECRETS_TIMEOUT_MS = 12_000;
export const ENSURE_TOKEN_FRESH_TIMEOUT_MS = 30_000;

const TIMEOUT = Symbol("env-prep-timeout");

// A timeout lets the turn proceed but does not cancel the underlying work.
async function withFailOpenTimeout(
  label: string,
  start: () => Promise<unknown>,
  ms: number,
): Promise<void> {
  const began = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const work = (async (): Promise<unknown> => {
    try {
      await start();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(getErrorMessage(err));
    }
  })();
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (result === TIMEOUT) {
      console.warn(`[env-prep] ${label} timed out after ${ms}ms — continuing without it (fail-open)`);
    } else if (result instanceof Error) {
      console.warn(`[env-prep] ${label} failed after ${Date.now() - began}ms:`, getErrorMessage(result));
    } else {
      console.log(`[env-prep] ${label} completed in ${Date.now() - began}ms`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SessionAgentEnvDeps {
  credentialsDir: string;
  credentialStore: CredentialStore;
  sessionManager: SessionManager;
  providerAccountManager?: ProviderAccountManager;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  chatHistoryManager?: Pick<ChatHistoryManager, "load" | "replaceInProgress" | "append">;
}

// Run-parameter construction consumes this replay in the same turn.
function armConversationReplay(deps: SessionAgentEnvDeps, sessionId: string): void {
  const chatHistory = deps.chatHistoryManager;
  if (!chatHistory) return;
  try {
    const messages = chatHistory.load(sessionId);
    const replay = buildConversationReplay(messages);
    if (!replay) return;
    deps.sessionManager.setConversationReplay(sessionId, replay);
    console.log(
      `[credentials] armed visible-history replay for ${sessionId} (${messages.length} messages) — the new agent conversation continues the transcript instead of starting empty`,
    );
  } catch (err) {
    console.warn("[credentials] failed to arm conversation replay:", getErrorMessage(err));
  }
}

// Worker pushes replace the tracked set, so include Compose and account values together.
export function selectAgentEnvForPush(input: {
  serviceManager: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  credentialStore: AccountAgentEnvSource;
}): Record<string, string> {
  if (input.serviceManager) {
    return withServiceCredentialsReconciled(
      input.serviceManager.getSecretsSnapshot(),
      input.credentialStore,
    );
  }
  return {
    ...input.credentialStore.getAllAgentEnv(),
    ...collectAccountAgentEnv(input.credentialStore),
  };
}

// Revocation must work even when invalid Compose YAML prevents a new secrets snapshot.
function withServiceCredentialsReconciled(
  snapshot: { agentValues: Record<string, string>; declared: { name: string }[] },
  credentialStore: AccountAgentEnvSource,
): Record<string, string> {
  const delivered = collectServiceCredentialEnv(credentialStore);
  const declaredByCompose = new Set(snapshot.declared.map((d) => d.name));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshot.agentValues)) {
    const isCatalogueCredential =
      credentialStorageEnvNames().includes(name) || name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX);
    if (isCatalogueCredential && !declaredByCompose.has(name) && delivered[name] === undefined) {
      continue;
    }
    out[name] = value;
  }
  // Per-route variables are reserved; always replace them after credential rotation.
  for (const [name, value] of Object.entries(delivered)) {
    if (name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX)) out[name] = value;
  }
  return out;
}

export type AccountAgentEnvSource = Pick<
  CredentialStore,
  "getAllAgentEnv" | "getAllMcpOAuthTokens" | "listCredentialRoutes" | "getCredentialSecret"
>;

export interface AgentSecretsCapableRunner {
  sessionId: string;
  serviceManager?: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  tryPushAgentSecrets(values: Record<string, string>): Promise<void>;
}

export function isAgentSecretsCapable(runner: unknown): runner is AgentSecretsCapableRunner {
  return (
    !!runner
    && typeof (runner as AgentSecretsCapableRunner).tryPushAgentSecrets === "function"
  );
}

export function refreshAgentEnvForAllSessions(
  serviceManagers: Map<string, Pick<ServiceManager, "refreshSecrets">>,
): void {
  for (const [sessionId, mgr] of serviceManagers) {
    mgr.refreshSecrets().catch((err: unknown) => {
      console.warn(`[credentials] agent-env refresh failed for session ${sessionId}:`, getErrorMessage(err));
    });
  }
}

export interface PrepareSessionAgentEnvironmentResult {
  turnRoute?: ProviderRoute;
  // Undefined preserves the captured resume ID; null clears it; a string replaces it.
  overrideAgentSessionId?: string | null;
}

function selectTurnRoute(
  agentId: AgentId,
  session: SessionInfo,
  deps: SessionAgentEnvDeps,
  opts: {
    excludeRouteIds?: readonly string[] | undefined;
    residentRoute?: { kind: ProviderRouteKind; id: string } | undefined;
    requireResidentRoute?: boolean;
  },
): ProviderRoute | undefined {
  const manager = deps.providerAccountManager;
  // Reused or busy processes must keep the credentials they already hold.
  if (opts.requireResidentRoute && opts.residentRoute) {
    const { kind, id } = opts.residentRoute;
    const stillExists =
      kind === "account"
        ? manager?.getByRouteId(id) !== undefined
        : !id.startsWith("cred_") || deps.credentialStore.getCredentialRoute(id) !== undefined;
    if (stillExists) return { kind, id };
  }
  const residentRouteId = opts.residentRoute?.id;
  // This turn attempts the result; only actual refusals in its exclusion list are final.
  const selection = selectRouteForSelection(
    agentId,
    modelSelectionOf(session),
    {
      credentialStore: deps.credentialStore,
      ...(manager ? { providerAccountManager: manager } : {}),
    },
    {
      optimistic: true,
      ...(opts.excludeRouteIds ? { exclude: opts.excludeRouteIds } : {}),
      ...(residentRouteId ? { residentRouteId } : {}),
    },
  );
  return routeFromSelection(agentId, selection, blockedSubjectFor(agentId, session));
}

function blockedSubjectFor(agentId: AgentId, session: SessionInfo): string | undefined {
  const serviceId = session.serviceId;
  if (!serviceId) return undefined;
  const accountBackedNative =
    serviceId === nativeServiceForHarness(agentId)
    && loginIntegrationForService(serviceId) !== undefined;
  if (accountBackedNative) return undefined;
  return getService(serviceId)?.name ?? serviceId;
}

export function modelSelectionOf(session: SessionInfo): ModelSelection | undefined {
  if (!session.model || !session.serviceId || !session.billingMode) return undefined;
  return {
    serviceId: session.serviceId,
    billingMode: session.billingMode,
    modelId: session.model,
  };
}

export async function prepareSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: {
    sessionId: string;
    agentId: AgentId;
    deps: SessionAgentEnvDeps;
    // Warm-ups omit this; routing failures must belong to a turn, not session creation.
    enforceAccountRouting?: boolean;
    excludeRouteIds?: readonly string[];
    residentRoute?: { kind: ProviderRouteKind; id: string };
    requireResidentRoute?: boolean;
    // Subtree repair removes files a live CLI can reread; defer repair until a fresh spawn.
    reusingResidentAgent?: boolean;
  },
): Promise<PrepareSessionAgentEnvironmentResult> {
  const { sessionId, agentId, deps } = args;
  let session = deps.sessionManager.get(sessionId);
  if (!session) return {};
  const isTurn = args.enforceAccountRouting === true;
  // Persist the default so credential routing and spawn parameters read the same selection.
  if (isTurn && !modelSelectionOf(session)) {
    const derived = firstEligibleSelectionForHarness(agentId, { credentialStore: deps.credentialStore });
    // Keep native login defaults; key-only native services still need explicit shaping.
    const nativeAuthenticatesUnshaped =
      loginIntegrationForService(nativeServiceForHarness(agentId)) !== undefined;
    if (derived && (derived.serviceId !== nativeServiceForHarness(agentId) || !nativeAuthenticatesUnshaped)) {
      deps.sessionManager.setModelSelection(sessionId, derived);
      session = deps.sessionManager.get(sessionId) ?? session;
      runner?.emitMessage({
        type: "model_selection_changed",
        sessionId,
        agentId,
        selection: derived,
        modelId: derived.modelId,
        reasoningEffort: session.reasoningEffort ?? null,
        roleName: session.roleName ?? null,
        notice: `No model was selected, so this session is running ${
          getService(derived.serviceId)?.name ?? derived.serviceId
        }.`,
      });
    }
  }
  const selectedRoute = isTurn
    ? selectTurnRoute(agentId, session, deps, {
        excludeRouteIds: args.excludeRouteIds,
        residentRoute: args.residentRoute,
        requireResidentRoute: args.requireResidentRoute === true,
      })
    : undefined;

  // Refresh the source account before creating its cross-harness projection.
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (isTurn && agentId === "opencode") {
    if (isLocalRuntime()) ensureManagedOpenCodeData(perSessionCredentialsDir(deps.credentialsDir, sessionId), agentHome());
    if (selectedRoute?.kind === "account") {
      if (deps.ensureAgentTokenFresh && !await deps.ensureAgentTokenFresh("codex", selectedRoute.id)) throw new Error("ChatGPT account renewal failed. Reconnect the OpenAI account.");
      ensureSessionAccountCredentials(deps.credentialsDir, sessionId, agentId, selectedRoute.id);
    } else {
      revokeOpenCodeAccount(perSessionCredentialsDir(deps.credentialsDir, sessionId));
    }
  }

  // Stamp before spawn: the HOME resolver and release check read this synchronously.
  if (isTurn && runner && selectedRoute) {
    runner.residentRoute = { kind: selectedRoute.kind, id: selectedRoute.id };
    if (runner instanceof ContainerSessionRunner) {
      try {
        writeSessionResidentRoute(deps.credentialsDir, sessionId, agentId, {
          kind: selectedRoute.kind, id: selectedRoute.id,
        });
      } catch (err) {
        console.warn("[credentials] resident-route record failed:", getErrorMessage(err));
      }
    }
  }

  if (selectedRoute?.kind === "account" && deps.providerAccountManager) {
    deps.providerAccountManager.markAccountUsed(accountServiceForHarness(agentId), selectedRoute.id);
  }
  markCredentialRouteUsed(deps.credentialStore, selectedRoute);

  const routeLabel = selectedRoute ? `${selectedRoute.kind}:${selectedRoute.id}` : "none";
  const repairLabel = args.reusingResidentAgent ? "skipped(resident-agent)" : "run";
  console.log(
    `[env-prep] ${sessionId} agent=${agentId} route=${routeLabel} turn=${isTurn ? "yes" : "warm-up"} repair=${repairLabel}`,
  );

  if (isTurn && runner instanceof ContainerSessionRunner) {
    // Identity checks must throw on failure; the old files may belong to another account.
    if (selectedRoute?.kind === "account") {
      const outcome = ensureSessionAccountCredentials(
        deps.credentialsDir, sessionId, agentId, selectedRoute.id,
      );
      if (outcome !== "match") {
        console.log(
          `[credentials] ${sessionId} account subtree ${outcome} for ${selectedRoute.id}`,
        );
      }
    }
    try {
      if (selectedRoute?.kind !== "account" && !session.agentPinned) {
        provisionAgentCredentials(deps.credentialsDir, sessionId, agentId);
      }
      // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-only memory dir layout, see provisionRepoMemory
      if (!session.agentPinned && agentId === "claude" && session.remoteUrl) {
        provisionRepoMemory(deps.credentialsDir, sessionId, repoUrlToHash(session.remoteUrl));
      }
    } catch (err) {
      console.warn("[credentials] provisioning failed:", getErrorMessage(err));
    }
  }
  if (isTurn && !session.agentPinned) {
    deps.sessionManager.setAgentId(sessionId, agentId);
    // This flag records one-time scaffolding, not a pinned credential route.
    deps.sessionManager.setAgentPinned(sessionId);
  } else if (isTurn && runner instanceof ContainerSessionRunner) {
    try {
      ensureSessionAgentUserConfig(deps.credentialsDir, sessionId, agentId);
    } catch (err) {
      console.warn("[credentials] agent user-config normalization failed:", getErrorMessage(err));
    }
  }

  // Local fallback HOME is shared; other sessions may have changed its links.
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (isLocalRuntime() && isTurn && agentId !== "opencode") {
    const accountId = selectedRoute?.kind === "account" ? selectedRoute.id : undefined;
    try {
      const outcomes = selectedRoute?.kind === "reserved"
        ? clearAgentHomeCredentialLinks({ agentId })
        : linkAgentHomeToCredentials({
          credentialsDir: deps.credentialsDir,
          agentId,
          ...(accountId ? { accountId } : {}),
        });
      const linked = Object.entries(outcomes).filter(([, o]) => o === "linked");
      if (linked.length > 0) {
        console.log(
          `[local-credentials] ${sessionId} agent=${agentId} linked ${linked.map(([rel]) => rel).join(", ")}`
            + ` from ${accountId ? `account:${accountId}` : "the flat credentials root"}`,
        );
      }
      const cleared = Object.entries(outcomes).filter(([, o]) => o === "unlinked");
      if (cleared.length > 0) {
        console.log(
          `[local-credentials] ${sessionId} agent=${agentId} cleared ${cleared.map(([rel]) => rel).join(", ")}`
            + ` — routed to reserved:${selectedRoute?.id ?? "?"}, which authenticates from the environment`,
        );
      }
    } catch (err) {
      console.warn("[local-credentials] updating agent home links failed:", getErrorMessage(err));
    }

    // Serialize first-run initialization against other spawns using this same root.
    // eslint-disable-next-line no-restricted-syntax -- genuine per-CLI-shape exception (docs/155): the non-atomic first-run init of a `.codex` state directory is a property of the Codex CLI, not a capability any agent could declare.
    if (agentId === "codex") {
      await ensureCodexHomeInitialized(
        accountId
          ? path.join(providerAccountCredentialRoot(deps.credentialsDir, agentId, accountId), ".codex")
          : codexHome(),
      );
    }

    // The adapter reads the broker URL synchronously at spawn.
    await ensureLocalAgentOpsHost({ sessionId });

    // Trust must be written to the HOME and exact workspace the local CLI uses.
    if (runner) {
      try {
        ensureLocalWorkspaceTrust(
          accountId
            ? providerAccountCredentialRoot(deps.credentialsDir, agentId, accountId)
            : agentHome(),
          agentId,
          runner.sessionDir,
        );
      } catch (err) {
        console.warn("[local-credentials] workspace trust write failed:", getErrorMessage(err));
      }
    }
  }

  // Refresh before copying; deployment-provided OAuth tokens are not managed here.
  if (
    isTurn &&
    runner instanceof ContainerSessionRunner &&
    deps.ensureAgentTokenFresh &&
    selectedRoute?.id !== "claude-env-oauth"
  ) {
    const accountId = selectedRoute?.kind === "account" ? selectedRoute.id : undefined;
    const ensureFresh = deps.ensureAgentTokenFresh;
    await withFailOpenTimeout(
      "token-fresh",
      () => ensureFresh(agentId, accountId),
      ENSURE_TOKEN_FRESH_TIMEOUT_MS,
    );
  }

  let overrideAgentSessionId: string | null | undefined;
  // Warm-ups have no route and must not copy the flat token over an account's subtree.
  if (isTurn && runner instanceof ContainerSessionRunner) {
    try {
      // Update both the row and the caller's already-captured resume ID.
      const onRecover = (recoveredOrClear: string | null): void => {
        const current = deps.sessionManager.get(sessionId)?.agentSessionId;
        if (recoveredOrClear === null) {
          overrideAgentSessionId = null;
          if (current) {
            console.log(`[credentials] clearing agent_session_id for ${sessionId} (was ${current}; no resumable conversation found on disk)`);
            deps.sessionManager.clearAgentSessionId(sessionId);
            armConversationReplay(deps, sessionId);
          }
          return;
        }
        overrideAgentSessionId = recoveredOrClear;
        if (current === recoveredOrClear) return;
        const wasNote = current ? ` (was ${current})` : "";
        console.log(`[credentials] recovered agent_session_id for ${sessionId}: ${recoveredOrClear}${wasNote}`);
        deps.sessionManager.setAgentSessionId(sessionId, recoveredOrClear);
      };
      const currentAgentSessionId = session.agentSessionId ?? null;
      const syncOpts = { repairLeakedSubtrees: !args.reusingResidentAgent };
      if (selectedRoute?.kind === "account") {
        syncProviderAccountTokenIn(
          deps.credentialsDir, sessionId, agentId, selectedRoute.id,
          onRecover, currentAgentSessionId, syncOpts,
        );
      } else if (selectedRoute?.id !== "claude-env-oauth") {
        syncAgentTokenIn(
          deps.credentialsDir, sessionId, agentId,
          onRecover, currentAgentSessionId, syncOpts,
        );
      }
    } catch (err) {
      console.warn("[credentials] token sync-in failed:", getErrorMessage(err));
    }
  }

  // Publish rotations during the turn so other sessions do not copy invalidated tokens.
  if (runner instanceof ContainerSessionRunner && args.enforceAccountRouting) {
    if (selectedRoute?.kind === "account") {
      startTokenWriteBackWatch({
        credentialsDir: deps.credentialsDir, sessionId, agentId,
        accountId: selectedRoute.id, runner,
      });
    } else if (selectedRoute?.id !== "claude-env-oauth") {
      startTokenWriteBackWatch({ credentialsDir: deps.credentialsDir, sessionId, agentId, runner });
    }
  }

  await withFailOpenTimeout(
    "mcp-oauth-refresh",
    () => refreshExpiredMcpOAuthTokens({ credentialStore: deps.credentialStore }),
    MCP_OAUTH_REFRESH_TIMEOUT_MS,
  );

  // Bound worker readiness as well as the secrets request itself.
  if (runner instanceof ContainerSessionRunner) {
    const containerRunner = runner;
    await withFailOpenTimeout(
      "push-agent-secrets",
      () =>
        containerRunner.tryPushAgentSecrets(
          selectAgentEnvForPush({
            serviceManager: containerRunner.serviceManager,
            credentialStore: deps.credentialStore,
          }),
        ),
      PUSH_AGENT_SECRETS_TIMEOUT_MS,
    );
  }

  return {
    ...(selectedRoute ? { turnRoute: selectedRoute } : {}),
    ...(overrideAgentSessionId !== undefined ? { overrideAgentSessionId } : {}),
  };
}

// After a 401, bypass expiry ordering: a later expiry does not prove a token is still valid.
export function repushSessionAgentToken(
  runner: SessionRunnerInterface | null,
  args: { sessionId: string; agentId: AgentId; deps: Pick<SessionAgentEnvDeps, "credentialsDir" | "sessionManager"> },
): void {
  if (!(runner instanceof ContainerSessionRunner)) return;
  try {
    const marked = readSessionAccountMarker(args.deps.credentialsDir, args.sessionId)[args.agentId];
    if (marked) {
      repushProviderAccountToken(args.deps.credentialsDir, args.sessionId, args.agentId, marked);
    } else if (runner.residentRoute?.id !== "claude-env-oauth") {
      repushAgentToken(args.deps.credentialsDir, args.sessionId, args.agentId);
    }
  } catch (err) {
    console.warn("[credentials] 401-recovery token repush failed:", getErrorMessage(err));
  }
}

export function finalizeSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: {
    sessionId: string;
    agentId: AgentId;
    deps: SessionAgentEnvDeps;
    capturedRoute?: Pick<SessionInfo, "providerRouteKind" | "providerRouteId">;
  },
): void {
  // Resident processes can rotate tokens between turns; keep their watchers alive.
  const residentAgentAlive =
    runner instanceof ContainerSessionRunner && (runner.getAgent() ?? null) !== null;
  if (!residentAgentAlive) stopTokenWriteBackWatch(args.sessionId);
  if (!(runner instanceof ContainerSessionRunner)) return;
  const session = args.deps.sessionManager.get(args.sessionId);
  // Use the turn's captured route or the disk marker, never the mutable session row.
  const markerAccountId = readSessionAccountMarker(args.deps.credentialsDir, args.sessionId)[args.agentId];
  const route = args.capturedRoute
    ?? (markerAccountId
      ? { providerRouteKind: "account" as const, providerRouteId: markerAccountId }
      : undefined);
  try {
    if (route?.providerRouteKind === "account" && route.providerRouteId) {
      syncProviderAccountTokenBack(
        args.deps.credentialsDir,
        args.sessionId,
        args.agentId,
        route.providerRouteId,
        { sessionOwnRoute: true },
      );
    } else if (route?.providerRouteId !== "claude-env-oauth") {
      syncAgentTokenBack(args.deps.credentialsDir, args.sessionId, args.agentId, { sessionOwnRoute: true });
    }
  } catch (err) {
    console.warn("[credentials] token sync-back failed:", getErrorMessage(err));
  }

  // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-only memory dir layout, see syncMemoryBack
  if (args.agentId === "claude" && session?.remoteUrl) {
    try {
      syncMemoryBack(args.deps.credentialsDir, args.sessionId, repoUrlToHash(session.remoteUrl));
    } catch (err) {
      console.warn("[credentials] memory sync-back failed:", getErrorMessage(err));
    }
  }
}
