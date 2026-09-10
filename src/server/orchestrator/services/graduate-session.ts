/** Shared warm-to-active transition. Callers handle pool refill separately. */
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { RepoStore } from "../repo-store.js";
import type { GitManager } from "../../shared/git.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { AgentId } from "../../shared/types.js";
import { generateSessionName, type SessionNameResult } from "../session-namer.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { accountServiceForHarness, providerAccountCredentialRoot } from "../provider-account-manager.js";
import { getErrorMessage } from "../validation.js";
import { isTitleLockedAgainst } from "./session-title.js";
import { nativeServiceForHarness, selectionExists } from "../../shared/catalogue/index.js";
import type { BillingMode } from "../../shared/catalogue/index.js";
import { resolveNonTurnModel } from "../non-turn-model.js";
import {
  emitNonTurnFailure,
  recordNonTurnUsage,
  type NonTurnFailurePersister,
} from "./non-turn-work.js";
import type { CredentialStore } from "../credential-store.js";
import type { UsageManager } from "../usage.js";

export interface GraduateSessionDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  repoStore: RepoStore;
  createGitManager: (dir: string) => GitManager;
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  providerAccountManager?: ProviderAccountManager;
  credentialsDir?: string;
  credentialStore?: CredentialStore;
  chatHistoryManager?: NonTurnFailurePersister;
  usageManager?: UsageManager;
}

export interface GraduateSessionOpts {
  sessionId: string;
  userText: string;
  agentId: AgentId;
  explicitTitle?: string;
  /** Caller must already have set the branch on disk and in the session row. */
  explicitBranch?: string;
  /** Keep branches stable after the spawn API has returned their names. */
  skipBranchRename?: boolean;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
  reasoning?: string;
  parentSessionId?: string;
  spawnedByTurn?: string;
  originRoleName?: string;
  rootSessionId?: string;
}

/** Requires an existing session and workspace. AI naming completes in the background. */
export function graduateSession(deps: GraduateSessionDeps, opts: GraduateSessionOpts): void {
  const {
    sessionManager, runnerRegistry, repoStore, createGitManager, prStatusPoller, sseBroadcast,
    ensureAgentTokenFresh, providerAccountManager, credentialsDir,
    credentialStore, chatHistoryManager, usageManager,
  } = deps;
  const { sessionId, userText, agentId, explicitTitle, explicitBranch, skipBranchRename, model, serviceId, billingMode, reasoning, parentSessionId, spawnedByTurn, rootSessionId, originRoleName } = opts;

  sessionManager.setWarm(sessionId, false);
  sessionManager.track(sessionId);

  const placeholderTitle = explicitTitle?.trim() || userText.slice(0, 60) || "New session";
  sessionManager.rename(sessionId, placeholderTitle);

  // Preserve the full selection: one model ID can exist on several services.
  if (model) {
    const supplied = serviceId && billingMode ? { serviceId, billingMode, modelId: model } : undefined;
    if (supplied && selectionExists(supplied)) {
      sessionManager.setModelSelection(sessionId, supplied);
    } else {
      sessionManager.setModel(sessionId, model, nativeServiceForHarness(agentId));
    }
  }
  if (reasoning) sessionManager.setReasoning(sessionId, reasoning);
  if (originRoleName) sessionManager.setOriginRoleName(sessionId, originRoleName);
  if (parentSessionId) {
    sessionManager.setParentSession(sessionId, parentSessionId, spawnedByTurn, rootSessionId);
  } else if (spawnedByTurn) {
    // Detached sessions still count toward the originating turn's spawn cap.
    sessionManager.setSpawnedByTurn(sessionId, spawnedByTurn);
  }

  const session = sessionManager.get(sessionId);
  const shouldAutoName = !explicitTitle && !explicitBranch && session?.workspaceDir;
  if (shouldAutoName) {
    scheduleSessionNaming(
      {
        sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast,
        ...(ensureAgentTokenFresh ? { ensureAgentTokenFresh } : {}),
        ...(providerAccountManager ? { providerAccountManager } : {}),
        ...(credentialsDir ? { credentialsDir } : {}),
        ...(credentialStore ? { credentialStore } : {}),
        ...(chatHistoryManager ? { chatHistoryManager } : {}),
        ...(usageManager ? { usageManager } : {}),
      },
      { sessionId, userText, agentId, skipBranchRename: skipBranchRename ?? false },
    );
  } else {
    sessionManager.setBranchRenamed(sessionId, true);
  }

  const updated = sessionManager.get(sessionId);
  if (updated?.remoteUrl) repoStore.touch(updated.remoteUrl);
  sseBroadcast("session_list", { sessions: sessionManager.list() });
}

interface ScheduleSessionNamingDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  createGitManager: (dir: string) => GitManager;
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
  providerAccountManager?: ProviderAccountManager;
  credentialsDir?: string;
  credentialStore?: CredentialStore;
  chatHistoryManager?: NonTurnFailurePersister;
  usageManager?: UsageManager;
}

interface ScheduleSessionNamingOpts {
  sessionId: string;
  userText: string;
  agentId: AgentId;
  skipBranchRename: boolean;
}

function scheduleSessionNaming(deps: ScheduleSessionNamingDeps, opts: ScheduleSessionNamingOpts): void {
  const {
    sessionManager, runnerRegistry, createGitManager, prStatusPoller, sseBroadcast,
    ensureAgentTokenFresh, providerAccountManager, credentialsDir,
    credentialStore, chatHistoryManager, usageManager,
  } = deps;
  const { sessionId, userText, agentId, skipBranchRename } = opts;

  // Naming has its own model selection, independent of the session's model.
  const resolution = credentialStore
    ? resolveNonTurnModel({
        credentialStore,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      })
    : undefined;
  const target = resolution?.ok ? resolution.target : undefined;
  // A missing pinned model stops naming; no eligible selection allows the legacy CLI fallback.
  const pinUnavailable = resolution !== undefined && !resolution.ok
    && resolution.reason === "pin_unavailable";
  const namingHarness = target?.harnessId ?? agentId;

  const namingRoute = target
    ? target.route
    : (providerAccountManager?.selectRouteForTurn(accountServiceForHarness(namingHarness)) ?? null);
  const namingAccountId = namingRoute?.kind === "account" ? namingRoute.id : undefined;
  const namingCredentialRoot = namingAccountId && credentialsDir
    ? providerAccountCredentialRoot(credentialsDir, namingHarness, namingAccountId)
    : undefined;

  // Persist failures: background naming can finish after the user switches sessions.
  const reportNamingFailure = (detail: string | undefined): void => {
    if (!chatHistoryManager) return;
    if (resolution && !resolution.ok) {
      if (!pinUnavailable) return;
      emitNonTurnFailure(
        { getRunnerRegistry: () => runnerRegistry, chatHistoryManager },
        {
          sessionId,
          purpose: "session-naming",
          unavailable: {
            serviceName: resolution.serviceName,
            serviceId: resolution.selection.serviceId,
            billingMode: resolution.selection.billingMode,
            modelId: resolution.selection.modelId,
          },
          detail: "The chosen model is no longer available — its credential or harness is gone.",
        },
      );
      return;
    }
    if (!target) return;
    emitNonTurnFailure(
      { getRunnerRegistry: () => runnerRegistry, chatHistoryManager },
      { sessionId, purpose: "session-naming", target, detail },
    );
  };

  const finalizeBranchRenamed = async (): Promise<void> => {
    try {
      sessionManager.setBranchRenamed(sessionId, true);
      const s = sessionManager.get(sessionId);
      if (!s?.remoteUrl || !s.workspaceDir) return;
      if (prStatusPoller?.getStatus(sessionId)) return;
      if (s.mergedAt) return;
      try {
        const git = createGitManager(s.workspaceDir);
        const headBranch = s.branch || await git.getCurrentBranch();
        const { insertions, deletions } = await git.diffStatVsBranch(await git.getDefaultBranch());
        const runner = runnerRegistry.get(sessionId);
        runner?.emitMessage({
          type: "pr_lifecycle_update",
          sessionId,
          cardId: `pr-card-${sessionId}`,
          phase: "ready",
          headBranch,
          totalInsertions: insertions,
          totalDeletions: deletions,
        });
      } catch {
        // Post-commit retries stats if there are no commits yet.
      }
    } catch (err) {
      console.warn("[graduate-session] finalizeBranchRenamed failed:", getErrorMessage(err));
    }
  };

  const nameAfterHeal = async (): Promise<SessionNameResult> => {
    if (pinUnavailable) {
      return { name: null };
    }
    if (ensureAgentTokenFresh) {
      try {
        // Refresh only the account naming will use; an unrelated revoked account must not interfere.
        await ensureAgentTokenFresh(namingHarness, namingAccountId);
      } catch {
        // Let the CLI try even if credential refresh fails.
      }
    }
    const result = await generateSessionName(userText, {
      harnessId: namingHarness,
      ...(target?.selection.modelId ? { model: target.selection.modelId } : {}),
      ...(target?.serviceRouting ? { serviceRouting: target.serviceRouting } : {}),
      ...(target?.credentialSecret ? { credentialSecret: target.credentialSecret } : {}),
      ...(namingCredentialRoot ? { credentialRoot: namingCredentialRoot } : {}),
    });
    // Count usage even when title parsing fails or the legacy fallback has no target.
    if (result.usage) {
      recordNonTurnUsage(
        { ...(usageManager ? { usageManager } : {}) },
        {
          sessionId,
          harnessId: namingHarness,
          ...(target ? { target } : {}),
          purpose: "session-naming",
          telemetry: result.usage,
        },
      );
    }
    return result;
  };

  // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget session naming
  nameAfterHeal().then(async (result) => {
    const nameResult = result.name;
    if (!nameResult) {
      reportNamingFailure(result.failure);
      await finalizeBranchRenamed();
      return;
    }
    try {
      const session = sessionManager.get(sessionId);
      if (!session) {
        await finalizeBranchRenamed();
        return;
      }
      const currentBranch = session.branch;
      if (!skipBranchRename && currentBranch && session.workspaceDir) {
        const randomSlug = currentBranch.replace(/^shipit\//, "");
        const newBranchName = `shipit/${nameResult.slug}-${randomSlug}`;
        const sessionGit = createGitManager(session.workspaceDir);
        await sessionGit.renameBranch(currentBranch, newBranchName);
        sessionManager.setBranch(sessionId, newBranchName);
      }
      // Use the post-CLI row to respect titles set while naming ran. Branch naming stays independent.
      if (!isTitleLockedAgainst(session, undefined)) {
        sessionManager.rename(sessionId, nameResult.title);
        const updatedSession = sessionManager.get(sessionId);
        if (updatedSession) {
          const runner = runnerRegistry.get(sessionId);
          runner?.emitMessage({ type: "session_renamed", session: updatedSession });
          sseBroadcast("session_renamed", { session: updatedSession });
        }
      }
      await finalizeBranchRenamed();
    } catch (err) {
      console.warn("[graduate-session] Branch rename failed:", getErrorMessage(err));
      await finalizeBranchRenamed();
    }
  }).catch(async (err: unknown) => {
    console.warn("[graduate-session] Session naming failed:", err);
    reportNamingFailure(getErrorMessage(err));
    await finalizeBranchRenamed();
  });
}
