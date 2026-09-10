import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";
import { billingModeForRoute } from "../sessions.js";
import { resolveRunner } from "./resolve-runner.js";
import { parseCompactCommand } from "../../shared/compact-command.js";
import {
  shouldCompactBeforeTurn,
  noteMissedCompaction,
  POST_MERGE_COMPACT_PROMPT,
} from "../compact-before-turn.js";
import { emitResetEligible } from "../services/pre-turn-reset.js";
import { applyPreTurnReset, type PreTurnResetHookResult } from "../pre-turn-reset-hook.js";
import { buildBugOutcomeNotice } from "../services/bug-report.js";
import { routeVoiceNote } from "../voice/voice-note-router.js";
import type { SessionRunnerInterface, SystemTurnDeps, QueuedMessage } from "../session-runner.js";
import { startQueuedMessage } from "../queue-drain.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  repushSessionAgentToken,
  selectAgentEnvForPush,
} from "../session-agent-env.js";
import { buildAgentRunParams } from "../session-agent-run-params.js";
import { emitPrLifecycleAfterCommit } from "../services/pr-lifecycle.js";
import { detectAndReArmMergedSession, detectAndReArmResetSession } from "../services/pr-rearm.js";
import { reactToReleaseMarkers } from "../services/release-flow.js";
import { executeAgentTurn } from "../turn-executor.js";
import { releaseResidentOnSpawnChange } from "../resident-spawn-guard.js";
import { desiredSpawnIdentity, residentRouteNeedsRelease } from "../service-routing.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "../prompt-assembly.js";
import { takeRoleStandingInstructions } from "../services/session-role.js";
import { dependencyGapAgentPrefix } from "../dependency-staleness.js";
import { imageHash, imageUrl } from "../transcript-projection.js";

export { selectAgentEnvForPush };

export { saveImagesToUploadsDir, assembleAgentPrompt };

type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

// Finalize partial rows before the next turn replaces in-progress history.
function persistInterruptedTurn(
  ctx: FullCtx,
  sessionId: string,
  partial: ReturnType<typeof buildTurnMessages>,
): void {
  try {
    ctx.chatHistoryManager.replaceInProgress(sessionId, partial);
    ctx.chatHistoryManager.finalizeInProgress(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("database connection is not open")) return;
    throw err;
  }
}

export async function drainNextQueuedMessage(
  ctx: FullCtx,
  runner: SessionRunnerInterface | null,
  capturedSessionId: string | undefined,
  capturedSessionDir: string | null | undefined,
  emit: (msg: WsServerMessage) => void,
  compactionTurn = false,
): Promise<void> {
  if (!runner) return;

  // A system flow can acquire the session during the awaited commit.
  if (runner.systemTurnInProgress && !compactionTurn) return;

  const messageQueue = runner.messageQueue;
  if (compactionTurn) {
    // Clear here: resident reuse can remove finishTurn's listener before done.
    runner.systemTurnInProgress = false;
    if (capturedSessionId) noteMissedCompaction(runner, ctx.chatHistoryManager, capturedSessionId);
  }
  if (runner.wasInterrupted && !compactionTurn) {
    if (messageQueue.length > 0) {
      runner.clearQueue();
      emit({ type: "queue_updated", queue: [] });
    }
    return;
  }
  if (messageQueue.length === 0) return;

  const next = messageQueue.shift()!;
  emit({
    type: "queue_updated",
    queue: messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
    dequeued: next.text,
  });
  runner.running = true;

  await startQueuedMessage(runner, next, (queued) =>
    runQueuedInteractiveMessage(ctx, runner, capturedSessionId, capturedSessionDir, emit, queued),
  ).catch((err: unknown) => {
    console.error("[queue] Error processing queued message:", getErrorMessage(err));
    runner.running = false;
  });
}

function isCompactCommandFor(ctx: FullCtx, text: string): boolean {
  const capable =
    ctx.agentRegistry.get(ctx.getActiveAgentId())?.capabilities.supportsCompaction ?? false;
  return capable && parseCompactCommand(text).match;
}

// Hold systemTurnInProgress during the decision to prevent steering past compaction.
export async function decideCompactBeforeTurn(
  ctx: FullCtx,
  runner: SessionRunnerInterface,
  sessionId: string,
  sessionDir: string,
  intent: boolean | undefined,
): Promise<boolean> {
  const held = !runner.systemTurnInProgress;
  if (held) runner.systemTurnInProgress = true;
  let compact = false;
  try {
    compact = await decide();
  } finally {
    if (held && !compact) runner.systemTurnInProgress = false;
  }
  return compact;

  function decide(): Promise<boolean> {
    return shouldCompactBeforeTurn({
    deps: {
      getSession: (id) => ctx.sessionManager.get(id),
      getPrStatus: (id) => ctx.sessionManager.getPrStatus(id),
      createGitManager: ctx.createGitManager,
      getAutoResetMergedBranch: () => ctx.credentialStore.getAutoResetMergedBranch(),
      mergeRecheckDeps: {
        verifyPrState: (id) =>
          ctx.prStatusPoller.forceVerifySessionPrState(id, { armAbsentDebounce: false }),
        awaitMergeHandling: (id) => ctx.prStatusPoller.awaitMergeHandling(id),
      },
    },
      runner,
      agentId: ctx.getActiveAgentId(),
      sessionId,
      sessionDir,
      ...(intent !== undefined ? { intent } : {}),
    });
  }
}

export async function runCompactionAhead(
  ctx: FullCtx,
  runner: SessionRunnerInterface,
  queued: QueuedMessage,
  permissionMode: PermissionMode | undefined,
): Promise<void> {
  runner.messageQueue.unshift({ ...queued, compactContext: false });
  runner.emitMessage({ type: "message_queued", text: queued.text, position: 1 });
  runner.running = true;
  runner.systemTurnInProgress = true;
  await runAgentWithMessage(ctx, {
    userText: POST_MERGE_COMPACT_PROMPT,
    images: undefined,
    validatedFiles: [],
    agentSessionId: undefined,
    permissionMode,
    isNewSession: false,
    compact: true,
    silent: true,
    systemTurn: true,
  });
}

async function runQueuedInteractiveMessage(
  ctx: FullCtx,
  runner: SessionRunnerInterface,
  capturedSessionId: string | undefined,
  capturedSessionDir: string | null | undefined,
  emit: (msg: WsServerMessage) => void,
  next: QueuedMessage,
): Promise<void> {
  if (
    capturedSessionId && capturedSessionDir && !isCompactCommandFor(ctx, next.text)
    && await decideCompactBeforeTurn(ctx, runner, capturedSessionId, capturedSessionDir, next.compactContext)
  ) {
    await runCompactionAhead(ctx, runner, next, next.permissionMode);
    return;
  }
  const nextImages = next.images && next.images.length > 0 ? next.images : undefined;
  const nextFileRefs = next.files && next.files.length > 0 ? next.files : undefined;
  let nextValidatedFiles: FileAttachment[] = [];
  if (nextFileRefs) {
    const dir = capturedSessionDir ?? ctx.workspaceDir;
    const fileResult = await resolveFileAttachments(nextFileRefs, dir);
    if (fileResult.error) {
      emit({ type: "error", message: fileResult.error });
      runner.running = false;
      return;
    }
    nextValidatedFiles = fileResult.files;
  }
  let allNextImages = nextImages;
  const nextUploadRefs = next.uploads && next.uploads.length > 0 ? next.uploads : undefined;
  if (nextUploadRefs) {
    const dir = capturedSessionDir ?? ctx.workspaceDir;
    const uploadResult = await resolveUploadRefs(nextUploadRefs, dir);
    if (uploadResult.error) {
      emit({ type: "error", message: uploadResult.error });
      runner.running = false;
      return;
    }
    nextValidatedFiles = [...nextValidatedFiles, ...uploadResult.files];
    if (uploadResult.images.length > 0) {
      allNextImages = [...(allNextImages ?? []), ...uploadResult.images];
    }
  }
  const nextSession = capturedSessionId
    ? ctx.sessionManager.get(capturedSessionId)
    : undefined;
  try {
    await runAgentWithMessage(ctx, {
      userText: next.text,
      images: allNextImages,
      validatedFiles: nextValidatedFiles,
      agentSessionId: nextSession?.agentSessionId,
      permissionMode: next.permissionMode,
      isNewSession: false,
      uploadPaths: nextUploadRefs?.map((u) => u.path),
      ...(next.dictated ? { dictated: true } : {}),
      ...(next.resetMergedBranch !== undefined ? { resetMergedBranch: next.resetMergedBranch } : {}),
      ...(isCompactCommandFor(ctx, next.text) ? { compact: true } : {}),
    });
  } catch (err) {
    console.error("[queue] Error processing queued message:", getErrorMessage(err));
    runner.running = false;
  }
}

export async function runAgentWithMessage(ctx: FullCtx, opts: {
  userText: string;
  images?: ImageAttachment[];
  validatedFiles: FileAttachment[];
  agentSessionId?: string;
  permissionMode?: PermissionMode;
  isNewSession: boolean;
  uploadPaths?: string[];
  userReview?: { filePaths: string[]; commentCount: number };
  compact?: boolean;
  /** false skips reset; true/undefined follows the global setting. */
  resetMergedBranch?: boolean;
  silent?: boolean;
  systemTurn?: boolean;
  dictated?: boolean;
  /** Presence enables echo; omit for queued messages already restored by dequeued. */
  userEcho?: { clientRequestId?: string };
}): Promise<void> {
  const { userText, images, validatedFiles, permissionMode, isNewSession, uploadPaths, userReview } = opts;

  // Capture before awaits: the user can switch sessions during this turn.
  const capturedSessionId = ctx.getActiveAppSessionId();
  const capturedSessionDir = ctx.getActiveSessionDir();
  const turnStartHeadHash = capturedSessionDir
    ? await ctx.createGitManager(capturedSessionDir).getHeadHash()
    : null;

  if (capturedSessionId) ctx.sessionManager.track(capturedSessionId);

  const runner = resolveRunner(ctx, capturedSessionId);

  const agentId = ctx.getActiveAgentId();

  const effectivePermissionMode: PermissionMode | undefined =
    permissionMode === "guarded" && (runner?.guardedUnavailable ?? false) ? undefined : permissionMode;

  const agentInfo = ctx.agentRegistry.get(agentId);
  const useStreaming = ctx.credentialStore.getLiveSteering() && (agentInfo?.capabilities.supportsSteering ?? false);
  // Release stale credentials before the executor captures a process to write into.
  const failoverSession = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  if (
    useStreaming &&
    residentRouteNeedsRelease(failoverSession, agentId, runner, {
      credentialStore: ctx.credentialStore,
      ...(ctx.providerAccountManager ? { providerAccountManager: ctx.providerAccountManager } : {}),
    })
  ) {
    const resident = runner?.getAgent() ?? null;
    if (resident) {
      // Settle before removing the listener that handles superseded.
      resident.emit("superseded");
      // Late done/error events must not finalize the next turn's state.
      try {
        resident.removeAllListeners();
      } catch {
        // Best-effort: an adapter without listeners is already the state we want.
      }
      try {
        resident.kill();
      } catch {
        // Already gone is the state we wanted.
      }
      runner?.setAgent(null);
    }
  }
  if (useStreaming && capturedSessionId) {
    releaseResidentOnSpawnChange(
      runner,
      desiredSpawnIdentity(ctx.sessionManager, capturedSessionId, agentId),
    );
  }
  const existingAgent = useStreaming ? (runner?.getAgent() ?? null) : null;
  const currentAgent = existingAgent ?? ctx.agentFactory(agentId);
  if (!existingAgent && runner) runner.setAgent(currentAgent);

  const emit = (m: WsServerMessage): void => {
    if (runner) runner.emitMessage(m);
    else ctx.send(m);
  };
  const sessionId = capturedSessionId ?? runner?.sessionId ?? "";
  if (existingAgent) existingAgent.removeAllListeners();

  const historyImages = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
  const historyFiles = validatedFiles.length > 0
    ? validatedFiles.map((f) => ({
        path: f.path,
        contentPreview: f.content.slice(0, 200),
        startLine: f.startLine,
        endLine: f.endLine,
      }))
    : undefined;
  const persistUserMessage = (sessionId: string): void => {
    if (opts.silent) return;
    ctx.chatHistoryManager.append(sessionId, {
      role: "user",
      text: userText,
      images: historyImages,
      files: historyFiles,
      uploadPaths: uploadPaths && uploadPaths.length > 0 ? uploadPaths : undefined,
      ...(userReview ? { userReview } : {}),
      // Match the echo's identity so identical messages remain distinct.
      ...(opts.userEcho?.clientRequestId ? { clientRequestId: opts.userEcho.clientRequestId } : {}),
    });
  };

  // Emit after persistence: image URLs resolve against the stored row.
  const userEcho = opts.userEcho
    ? {
        ...(opts.userEcho.clientRequestId ? { clientRequestId: opts.userEcho.clientRequestId } : {}),
        ...(historyImages && sessionId
          ? {
              images: historyImages.map((img) => ({
                mediaType: img.mediaType,
                src: imageUrl(sessionId, imageHash(img.data)),
              })),
            }
          : {}),
        ...(historyFiles ? { files: historyFiles } : {}),
        ...(uploadPaths && uploadPaths.length > 0 ? { uploadPaths } : {}),
        ...(userReview ? { userReview } : {}),
      }
    : undefined;

  // Compaction must neither move the branch nor receive instructions to resume work.
  let resetHook: PreTurnResetHookResult = { agentPrefix: "" };
  if (capturedSessionId && capturedSessionDir && runner && !opts.compact) {
    resetHook = await applyPreTurnReset({
      deps: {
        sessionManager: ctx.sessionManager,
        prStatusPoller: ctx.prStatusPoller,
        createGitManager: ctx.createGitManager,
        sseBroadcast: ctx.sseBroadcast,
        chatHistoryManager: ctx.chatHistoryManager,
        getAutoResetMergedBranch: () => ctx.credentialStore.getAutoResetMergedBranch(),
      },
      runner,
      sessionId: capturedSessionId,
      sessionDir: capturedSessionDir,
      ...(opts.resetMergedBranch !== undefined ? { intent: opts.resetMergedBranch } : {}),
    });
  }
  const resetAgentPrefix = resetHook.agentPrefix;

  const pendingAgentNotice =
    capturedSessionId && !opts.compact
      ? ctx.sessionManager.consumePendingAgentNotice(capturedSessionId) ?? ""
      : "";

  const bugOutcomeNotice =
    capturedSessionId && !opts.compact
      ? buildBugOutcomeNotice(ctx.chatHistoryManager.consumeUnreportedBugOutcomes(capturedSessionId))
      : "";

  const activeDir = ctx.getActiveDir();
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && activeDir ? saveImagesToUploadsDir(images, activeDir) : "";
  const dependencyPrefix = opts.compact ? "" : dependencyGapAgentPrefix(runner?.dependencyGap);
  const agentPrefix = [
    pendingAgentNotice,
    bugOutcomeNotice,
    resetAgentPrefix,
    dependencyPrefix,
  ]
    .filter(Boolean)
    .join("\n\n");
  const roleContext = capturedSessionId
    ? takeRoleStandingInstructions(capturedSessionId, {
        sessionManager: ctx.sessionManager,
        credentialStore: ctx.credentialStore,
      })
    : "";
  const prompt =
    (agentPrefix ? `${agentPrefix}\n\n` : "") +
    assembleAgentPrompt({
      userText,
      fileContext,
      imageContext,
      dictated: opts.dictated,
      ...(roleContext ? { roleContext } : {}),
    });

  const afterUserMessagePersisted = resetHook.afterUserMessagePersisted;

  const listenerDeps: AgentListenerDeps = {
    sessionManager: ctx.sessionManager,
    chatHistoryManager: ctx.chatHistoryManager,
    usageManager: ctx.usageManager,
    sseBroadcast: ctx.sseBroadcast,
    broadcastLog: ctx.broadcastLog,
    getSelectedModel: ctx.getSelectedModel,
    recordAgentRateLimits: ctx.recordAgentRateLimits,
    getSubscriptionLimitsSnapshot: ctx.getSubscriptionLimitsSnapshot,
    markSessionAccountExhausted: ctx.markSessionAccountExhausted,
    nudgeClaudeOAuthRefresh: ctx.nudgeClaudeOAuthRefresh,
    onAgentAuthRequired: ctx.onAgentAuthRequired,
    deliverVoiceNote: (payload, runner, source) =>
      void routeVoiceNote(payload, {
        runner,
        sessionId: runner.sessionId,
        credentialStore: ctx.credentialStore,
        source,
        chatHistoryManager: ctx.chatHistoryManager,
      }),
  };

  const deps: SystemTurnDeps = {
    agentFactory: (id) => ctx.agentFactory(id),
    ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
    autoCommit: async (sessionDir, summary) => {
      const git = ctx.createGitManager(sessionDir);
      const parentHash = await git.getHeadHash();
      const { commitHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable } =
        await git.autoCommit(summary);
      return { commitHash, parentHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable };
    },
    scheduleAutoPush: (sessionDir, sessionId) => ctx.scheduleAutoPush(ctx.createGitManager(sessionDir), sessionId),
    listenerDeps,
    buildRunParams: async (sessionId, id, p, turnRoute) => {
      // Env preparation can replace agentSessionId; read it again.
      const session = ctx.sessionManager.get(sessionId);
      return buildAgentRunParams({
        deps: {
          credentialStore: ctx.credentialStore,
          githubAuthManager: ctx.githubAuthManager,
          sessionManager: ctx.sessionManager,
          readSystemPrompt: ctx.readSystemPrompt,
          getSelectedModel: ctx.getSelectedModel,
          getSelectedReasoning: ctx.getSelectedReasoning,
          ...(ctx.runParamsPreps ? { runParamsPreps: ctx.runParamsPreps } : {}),
        },
        sessionId,
        agentId: id,
        prompt: p,
        ...(turnRoute ? { turnRoute } : {}),
        sessionDir: activeDir,
        ...(session?.agentSessionId !== undefined ? { agentSessionId: session.agentSessionId } : {}),
        ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
        ...(opts.compact ? { compact: true } : {}),
      });
    },
    prepareAgentEnv: async (sessionId, id, envOpts) => {
      return prepareSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        enforceAccountRouting: true,
        ...(envOpts?.reusingResidentAgent ? { reusingResidentAgent: true } : {}),
        ...(envOpts?.excludeRouteIds ? { excludeRouteIds: envOpts.excludeRouteIds } : {}),
        ...(envOpts?.residentRoute ? { residentRoute: envOpts.residentRoute } : {}),
        ...(envOpts?.requireResidentRoute ? { requireResidentRoute: true } : {}),
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
          chatHistoryManager: ctx.chatHistoryManager,
          ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
        },
      });
    },
    routeLabel: (routeId) =>
      ctx.providerAccountManager?.getByRouteId(routeId)?.label
      ?? ctx.credentialStore.getCredentialRoute(routeId)?.label,
    routeProfile: (kind, routeId) => {
      const row = ctx.providerAccountManager?.getByRouteId(routeId)
        ?? ctx.credentialStore.getCredentialRoute(routeId);
      if (row) return { billingMode: row.billingMode, serviceId: row.serviceId };
      const mode = billingModeForRoute(kind, routeId);
      return mode ? { billingMode: mode } : undefined;
    },
    finalizeAgentEnv: (sessionId, id, capturedRoute) => {
      finalizeSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        ...(capturedRoute ? { capturedRoute } : {}),
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
        },
      });
    },
    repushSessionAgentToken: (sessionId, id) => {
      repushSessionAgentToken(runner, {
        sessionId,
        agentId: id,
        deps: { credentialsDir: ctx.credentialsDir, sessionManager: ctx.sessionManager },
      });
    },
    commitTurn: ({ sessionDir, sessionId, summary, turnStartHeadHash: tsh, runner: r, emit, deferPushArm }) =>
      postTurnCommit(ctx, {
        sessionDir,
        sessionId,
        emit,
        turnSummary: summary,
        turnStartHeadHash: tsh,
        runner: r,
        ...(deferPushArm ? { deferPushArm } : {}),
      }),
    postTurnPrFlow: async (sessionId, sessionDir, commitHash, emit) => {
      await detectAndReArmMergedSession({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          createGitManager: ctx.createGitManager,
          sseBroadcast: ctx.sseBroadcast,
        },
        sessionId,
        sessionDir,
      });
      await emitPrLifecycleAfterCommit({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          githubAuthManager: ctx.githubAuthManager,
          credentialStore: ctx.credentialStore,
          chatHistoryManager: ctx.chatHistoryManager,
          generateText: ctx.generateText,
          createGitManager: ctx.createGitManager,
        },
        sessionId,
        sessionDir,
        commitHash,
        emit,
      });
    },
    postTurnReArmReset: async (sessionId, sessionDir, emit) => {
      await detectAndReArmResetSession({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          createGitManager: ctx.createGitManager,
          sseBroadcast: ctx.sseBroadcast,
        },
        sessionId,
        sessionDir,
        emit,
      });
      try {
        await emitResetEligible(
          {
            getSession: (id) => ctx.sessionManager.get(id),
            getPrStatus: (id) => ctx.sessionManager.getPrStatus(id),
            createGitManager: ctx.createGitManager,
          },
          { sessionId, sessionDir, origin: "post-turn", emit },
        );
      } catch (err) {
        console.error(`[pre-turn-reset] post-turn eligibility signal failed for ${sessionId}:`, err);
      }
    },
    postTurnReleaseFlow: async (sessionId, sessionDir, turnText) => {
      await reactToReleaseMarkers({
        deps: {
          releaseStatusPoller: ctx.releaseStatusPoller,
          sessionManager: ctx.sessionManager,
        },
        sessionId,
        sessionDir,
        turnText,
      });
    },
  };

  const onInterruptedTurn = (): void => {
    if (!runner || !capturedSessionId) return;
    const partial = buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages ?? [], runner.recordedCards ?? [], { inProgress: false });
    persistInterruptedTurn(ctx, capturedSessionId, partial);
    // Prevent reconnect replay from duplicating the finalized history.
    runner.clearTurnEventBuffer();
  };

  const drainNext = (): Promise<void> =>
    drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emit, opts.silent === true);

  // Record the branch move even if the turn fails before the user-row hook.
  try {
    await executeAgentTurn(runner, deps, currentAgent, {
      agentId,
      sessionId,
      prompt,
      userText,
      ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
      ...(opts.systemTurn ? { systemTurn: true } : {}),
      emitUserEcho: userEcho !== undefined,
      ...(userEcho ? { userEcho } : {}),
      persistUserMessage,
      ...(afterUserMessagePersisted ? { afterUserMessagePersisted } : {}),
      isNewSession,
      fallbackTitle: userText.slice(0, 80) || "New session",
      turnStartHeadHash,
      // Adopted CLI turns need their own starting HEAD in the captured directory.
      ...(capturedSessionDir
        ? { readTurnStartHeadHash: () => ctx.createGitManager(capturedSessionDir).getHeadHash() }
        : {}),
      drainNext,
      emit,
      useStreaming,
      reuseExistingAgent: existingAgent !== null,
      emitErrorOnNoResult: true,
      onInterruptedTurn,
    });
  } finally {
    if (sessionId) resetHook.ensureRecorded?.(sessionId);
  }
}
