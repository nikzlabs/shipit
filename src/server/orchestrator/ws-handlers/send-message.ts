import fs from "node:fs/promises";
import type { WsClientMessage, ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { validateImages, imageAttachmentRefusal, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { parseCompactCommand } from "../../shared/compact-command.js";
import { modelSelectionOf } from "../session-agent-env.js";
import { graduateSession } from "../services/graduate-session.js";
import { pinIssueSeededSession } from "../services/issue-seeded-session.js";
import { markIssueStartedFromSeed } from "../issue-lifecycle.js";
import { recordSteeredMessage, persistTurnInProgress } from "./agent-listeners.js";
import { decideCompactBeforeTurn, runCompactionAhead, runAgentWithMessage, saveImagesToUploadsDir, assembleAgentPrompt } from "./agent-execution.js";
import { resolveRunner } from "./resolve-runner.js";
import { shouldSteerMessage } from "../dispatch-steering.js";
import { resetSubAgentSpawnBudget } from "../session-runner.js";
import { settleNetworkModeWrites } from "../services/network-mode-writes.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { toQueuedMessage } from "../session-runner.js";
import { agentAdmissionError } from "../services/agent-auth-gate.js";
import { imageHash, imageUrl } from "../transcript-projection.js";

export { CONTEXT_WINDOW_TOKENS, wireAgentListeners, extractToolResults } from "./agent-listeners.js";
export { runAgentWithMessage } from "./agent-execution.js";
export { postTurnCommit } from "./post-turn.js";

type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;

function ensureActiveAgentAuthenticated(ctx: FullCtx): boolean {
  const activeAgentId = ctx.getActiveAgentId();

  const refusal = agentAdmissionError(ctx.agentRegistry, activeAgentId);
  if (refusal) {
    ctx.send({ type: "error", message: refusal });
    return false;
  }
  return true;
}

export async function handleSendMessage(
  ctx: FullCtx,
  msg: WsSendMessage,
): Promise<void> {
  if (!ensureActiveAgentAuthenticated(ctx)) return;

  const compactCapable =
    ctx.agentRegistry.get(ctx.getActiveAgentId())?.capabilities.supportsCompaction ?? false;
  const compactParsed = parseCompactCommand(msg.text);
  const isCompactRequest = compactParsed.match && compactCapable;

  const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
  if (images) {
    const imageError = validateImages(images);
    if (imageError) {
      ctx.send({ type: "error", message: imageError });
      return;
    }
  }

  // Check the target session's model, which can differ from the connection's.
  const targetSessionId = msg.sessionId ?? ctx.getActiveAppSessionId();
  const targetSession = targetSessionId ? ctx.sessionManager.get(targetSessionId) : undefined;
  const visionRefusal = imageAttachmentRefusal(
    targetSession ? modelSelectionOf(targetSession) : undefined,
    images,
    msg.uploads,
  );
  if (visionRefusal) {
    ctx.send({ type: "error", message: visionRefusal });
    return;
  }

  const runnerForQueue = resolveRunner(ctx);
  if (runnerForQueue) runnerForQueue.assertCanDispatch();
  const heldByMerge = runnerForQueue?.mergeHold === true;
  if (runnerForQueue?.running || runnerForQueue?.systemTurnInProgress || heldByMerge) {
    const actuallyRunning = heldByMerge ? false : await runnerForQueue.verifyRunningState();
    // Recovery can start a queued turn; re-read the runner after verification.
    if (
      actuallyRunning || runnerForQueue.running || runnerForQueue.systemTurnInProgress
      || runnerForQueue.mergeHold
    ) {
      if (isCompactRequest) {
        const compactAgent = runnerForQueue.getAgent();
        if (compactAgent?.compact) {
          compactAgent.compact(compactParsed.instructions);
          const compactSessionId = ctx.getActiveAppSessionId();
          if (compactSessionId) {
            runnerForQueue.emitMessage({
              type: "compaction_status",
              sessionId: compactSessionId,
              active: true,
              trigger: "manual",
            });
          }
        }
        return;
      }
      // Adapter capability does not prove the current process was started in streaming mode.
      const agentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
      const steeringCapable = agentInfo?.capabilities.supportsSteering ?? false;
      const liveSteering = ctx.credentialStore.getLiveSteering();
      const streamingActive = runnerForQueue.isStreamingActive;
      const systemTurnInProgress = runnerForQueue.systemTurnInProgress;

      if (!heldByMerge && shouldSteerMessage({
        steeringCapable,
        liveSteering,
        streamingActive,
        systemTurnInProgress,
      })) {
        const steeringAgent = runnerForQueue.getAgent();
        console.log(
          `[steer-send] runner=${runnerForQueue.sessionId} steeringCapable=${steeringCapable} liveSteering=${liveSteering} streamingActive=${streamingActive} agent=${steeringAgent ? "yes" : "null"} text=${JSON.stringify(msg.text.slice(0, 80))}`,
        );
        if (steeringAgent) {
          const capturedSessionId = ctx.getActiveAppSessionId();

          const steerDir = ctx.getActiveSessionDir() ?? ctx.workspaceDir;
          let steerFiles: FileAttachment[] = [];
          if (msg.files && msg.files.length > 0) {
            const result = await resolveFileAttachments(msg.files, steerDir);
            if (result.error) {
              ctx.send({ type: "error", message: result.error });
              return;
            }
            steerFiles = result.files;
          }
          let steerImages: ImageAttachment[] | undefined = images;
          if (msg.uploads && msg.uploads.length > 0) {
            const uploadResult = await resolveUploadRefs(msg.uploads, steerDir);
            if (uploadResult.error) {
              ctx.send({ type: "error", message: uploadResult.error });
              return;
            }
            steerFiles = [...steerFiles, ...uploadResult.files];
            if (uploadResult.images.length > 0) {
              steerImages = [...(steerImages ?? []), ...uploadResult.images];
            }
          }
          const steerUploadPaths = msg.uploads && msg.uploads.length > 0
            ? msg.uploads.map((u) => u.path)
            : undefined;

          const fileContext = steerFiles.length > 0 ? formatFileContext(steerFiles) : "";
          const imageContext = steerImages && steerImages.length > 0
            ? saveImagesToUploadsDir(steerImages, steerDir)
            : "";
          const steerPrompt = assembleAgentPrompt({
            userText: msg.text,
            fileContext,
            imageContext,
            dictated: msg.dictated,
          });
          // Steering bypasses turn setup; update permission mode before sending.
          if (
            runnerForQueue.appliedPermissionMode !== msg.permissionMode &&
            steeringAgent.setPermissionMode
          ) {
            steeringAgent.setPermissionMode(msg.permissionMode);
            runnerForQueue.appliedPermissionMode = msg.permissionMode;
          }
          steeringAgent.sendUserMessage(steerPrompt);

          // Refill the human-message budget without clearing the running turn's history.
          resetSubAgentSpawnBudget(runnerForQueue);

          const historyImages = steerImages?.map((img) => ({
            data: img.data,
            mediaType: img.mediaType,
          }));
          const historyFiles = steerFiles.length > 0
            ? steerFiles.map((f) => ({
                path: f.path,
                contentPreview: f.content.slice(0, 200),
                startLine: f.startLine,
                endLine: f.endLine,
              }))
            : undefined;

          if (capturedSessionId) {
            recordSteeredMessage(runnerForQueue, msg.text, {
              images: historyImages,
              files: historyFiles,
              uploadPaths: steerUploadPaths,
              assembledPrompt: steerPrompt,
            });
            persistTurnInProgress(ctx.chatHistoryManager, runnerForQueue, capturedSessionId);
          }
          // Persist before emitting image URLs that resolve against the stored row.
          if (capturedSessionId) {
            runnerForQueue.emitMessage({
              type: "message_steered",
              text: msg.text,
              sessionId: capturedSessionId,
              images: historyImages?.map((img) => ({
                mediaType: img.mediaType,
                src: imageUrl(capturedSessionId, imageHash(img.data)),
              })),
              files: historyFiles,
              uploadPaths: steerUploadPaths,
            });
          }
          return;
        }
      }

      runnerForQueue.dispatch(prepareDispatch({
        text: msg.text,
        agentInterface: undefined,
        execution: "interactive",
        images: msg.images,
        files: msg.files,
        uploads: msg.uploads,
        permissionMode: msg.permissionMode,
        activity: undefined,
        postTurn: undefined,
        systemTurn: undefined,
        onTurnComplete: undefined,
        deliveryId: undefined,
        dictated: msg.dictated,
        resetMergedBranch: msg.resetMergedBranch,
        compactContext: msg.compactContext,
        silent: undefined,
      }));
      return;
    }
  }

  const staleAgent = runnerForQueue?.getAgent() ?? null;
  if (staleAgent) {
    const staleAgentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
    const persistentStreaming = (staleAgentInfo?.capabilities.supportsSteering ?? false)
      && ctx.credentialStore.getLiveSteering()
      && (runnerForQueue?.isStreamingActive ?? false);
    if (!persistentStreaming) {
      staleAgent.kill();
    }
  }

  const fileRefs: FileContextRef[] | undefined = msg.files && msg.files.length > 0 ? msg.files : undefined;
  let validatedFiles: FileAttachment[] = [];
  if (fileRefs) {
    const dir = ctx.getActiveSessionDir() ?? ctx.workspaceDir;
    const result = await resolveFileAttachments(fileRefs, dir);
    if (result.error) {
      ctx.send({ type: "error", message: result.error });
      return;
    }
    validatedFiles = result.files;
  }

  const uploadRefs: UploadRef[] | undefined = msg.uploads && msg.uploads.length > 0 ? msg.uploads : undefined;
  let allImages = images;
  if (uploadRefs) {
    const dir = ctx.getActiveSessionDir() ?? ctx.workspaceDir;
    const uploadResult = await resolveUploadRefs(uploadRefs, dir);
    if (uploadResult.error) {
      ctx.send({ type: "error", message: uploadResult.error });
      return;
    }
    validatedFiles = [...validatedFiles, ...uploadResult.files];
    if (uploadResult.images.length > 0) {
      allImages = [...(allImages ?? []), ...uploadResult.images];
      // Keep originals at stable paths so history can recognize sent uploads.
    }
  }

  const userText = msg.text;

  const effectiveSessionId = msg.sessionId ?? ctx.getActiveAppSessionId();
  let agentSessionId: string | undefined;
  if (effectiveSessionId) {
    const previousSessionId = ctx.getActiveAppSessionId();
    if (previousSessionId && effectiveSessionId !== previousSessionId) {
      const previousRunner = ctx.getRunnerRegistry().get(previousSessionId);
      if (previousRunner && previousRunner.messageQueue.length > 0) {
        previousRunner.clearQueue();
        ctx.send({ type: "queue_updated", queue: [] });
      }
    }
    // Another viewer can change network mode and rebuild the container before this send.
    await settleNetworkModeWrites(effectiveSessionId);
    await ctx.activateSession(effectiveSessionId);
    const session = ctx.sessionManager.get(effectiveSessionId);
    agentSessionId = session?.agentSessionId;

    if (session?.warm) {
      // Pin before graduation starts automatic naming.
      const issuePins = msg.issueRef
        ? await pinIssueSeededSession(
          { sessionManager: ctx.sessionManager, createGitManager: ctx.createGitManager },
          effectiveSessionId,
          msg.issueRef,
        )
        : undefined;

      graduateSession(
        {
          sessionManager: ctx.sessionManager,
          runnerRegistry: ctx.getRunnerRegistry(),
          repoStore: ctx.repoStore,
          createGitManager: ctx.createGitManager,
          prStatusPoller: ctx.prStatusPoller,
          sseBroadcast: ctx.sseBroadcast,
          ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
          ...(ctx.providerAccountManager ? { providerAccountManager: ctx.providerAccountManager } : {}),
          ...(ctx.credentialsDir ? { credentialsDir: ctx.credentialsDir } : {}),
          credentialStore: ctx.credentialStore,
          chatHistoryManager: ctx.chatHistoryManager,
          usageManager: ctx.usageManager,
        },
        {
          sessionId: effectiveSessionId,
          userText,
          agentId: session.agentId ?? ctx.getActiveAgentId(),
          ...(issuePins ? { explicitBranch: issuePins.branch, explicitTitle: issuePins.title } : {}),
        },
      );

      if (msg.issueRef) {
        void markIssueStartedFromSeed(
          {
            credentialStore: ctx.credentialStore,
            ...(ctx.trackerFetchImpl ? { trackerFetchImpl: ctx.trackerFetchImpl } : {}),
            githubAuthManager: ctx.githubAuthManager,
            sessionManager: ctx.sessionManager,
            chatHistoryManager: ctx.chatHistoryManager,
            runnerRegistry: ctx.getRunnerRegistry(),
          },
          effectiveSessionId,
          msg.issueRef,
        ).catch((err: unknown) => {
          console.warn("[send-message] seed 'started' failed:", err);
        });
      }

      // This path bypasses claimSessionService's pool refill.
      if (session.remoteUrl) {
        void ctx.warmSessionForRepo(session.remoteUrl);
      }
    }

    if (session?.workspaceDir) {
      try {
        await fs.access(session.workspaceDir);
      } catch {
        ctx.send({
          type: "error",
          message: "This session's workspace is no longer available. The clone may have been cleaned up.",
        });
        return;
      }
    }
  } else {
    ctx.send({
      type: "error",
      message: "No active session. Please create a session first.",
    });
    return;
  }

  const activeId = ctx.getActiveAppSessionId();
  const activeDir = ctx.getActiveSessionDir();
  if (activeId && activeDir) {
    const registry = ctx.getRunnerRegistry();
    const runner = registry.getOrCreate(activeId, activeDir, ctx.getActiveAgentId());
    ctx.attachToRunner(runner);
  }

  const uploadPaths = uploadRefs?.map((u) => u.path);

  const turnRunner = resolveRunner(ctx);
  // A turn or merge can start during the awaits above.
  if (turnRunner?.mergeHold || turnRunner?.running) {
    turnRunner.dispatch(prepareDispatch({
      text: userText,
      agentInterface: undefined,
      resetMergedBranch: msg.resetMergedBranch,
      compactContext: msg.compactContext,
      silent: undefined,
      execution: "interactive",
      // Queue raw inputs; the drain resolves uploads again.
      images: msg.images,
      files: msg.files,
      uploads: msg.uploads,
      permissionMode: msg.permissionMode,
      activity: undefined,
      postTurn: undefined,
      systemTurn: undefined,
      onTurnComplete: undefined,
      deliveryId: undefined,
      dictated: msg.dictated,
    }));
    return;
  }
  if (turnRunner) turnRunner.running = true;
  if (
    turnRunner && activeId && activeDir && !isCompactRequest
    && await decideCompactBeforeTurn(ctx, turnRunner, activeId, activeDir, msg.compactContext)
  ) {
    await runCompactionAhead(ctx, turnRunner, toQueuedMessage(prepareDispatch({
      text: userText,
      agentInterface: undefined,
      resetMergedBranch: msg.resetMergedBranch,
      compactContext: msg.compactContext,
      silent: undefined,
      execution: "interactive",
      images: msg.images,
      files: msg.files,
      uploads: msg.uploads,
      permissionMode: msg.permissionMode,
      activity: undefined,
      postTurn: undefined,
      systemTurn: undefined,
      onTurnComplete: undefined,
      deliveryId: undefined,
      dictated: msg.dictated,
    })), msg.permissionMode);
    return;
  }

  await runAgentWithMessage(ctx, {
    userText,
    images: allImages,
    validatedFiles,
    agentSessionId,
    permissionMode: msg.permissionMode,
    isNewSession: !msg.sessionId,
    uploadPaths,
    ...(msg.userReview ? { userReview: msg.userReview } : {}),
    ...(msg.resetMergedBranch !== undefined ? { resetMergedBranch: msg.resetMergedBranch } : {}),
    ...(msg.dictated ? { dictated: true } : {}),
    compact: isCompactRequest,
    userEcho: { ...(msg.requestId ? { clientRequestId: msg.requestId } : {}) },
  });
}

export async function handleAnswerQuestion(ctx: FullCtx, msg: WsAnswerQuestion): Promise<void> {
  const answerText = msg.text?.trim()
    ? msg.text
    : Object.values(msg.answers).join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  const runnerEarly = resolveRunner(ctx);
  if (runnerEarly) runnerEarly.assertCanDispatch();

  if (runnerEarly?.mergeHold) {
    runnerEarly.dispatch(prepareDispatch({
      text: answerText,
      agentInterface: undefined,
      resetMergedBranch: undefined,
      compactContext: undefined,
      silent: undefined,
      execution: "interactive",
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: msg.permissionMode ?? runnerEarly.appliedPermissionMode,
      activity: undefined,
      postTurn: undefined,
      systemTurn: undefined,
      onTurnComplete: undefined,
      deliveryId: undefined,
      dictated: msg.dictated,
    }));
    return;
  }

  // Do not let stale-process cleanup kill a system flow's agent.
  if (runnerEarly?.systemTurnInProgress) {
    ctx.send({
      type: "error",
      message: "The agent is busy with a system operation (rebase or CI fix). Try again once it finishes.",
    });
    return;
  }

  // Capture before setAgent(null) clears the mode; answering must not leave plan mode.
  const capturedPermissionMode = msg.permissionMode ?? runnerEarly?.appliedPermissionMode;

  const staleAgent = runnerEarly?.getAgent() ?? null;
  if (staleAgent) {
    const staleAgentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
    const persistentStreaming =
      (staleAgentInfo?.capabilities.supportsSteering ?? false) &&
      ctx.credentialStore.getLiveSteering() &&
      (runnerEarly?.isStreamingActive ?? false) &&
      !(runnerEarly?.systemTurnInProgress ?? false);
    if (!persistentStreaming) {
      staleAgent.kill();
      if (runnerEarly?.getAgent() === staleAgent) {
        runnerEarly.setAgent(null);
        runnerEarly.isStreamingActive = false;
        runnerEarly.running = false;
      }
    }
  }

  if (runnerEarly?.running) {
    console.warn(
      `[answer_question] Runner ${runnerEarly.sessionId} already running — dropping duplicate answer (text="${answerText.slice(0, 60)}")`,
    );
    return;
  }

  if (!ensureActiveAgentAuthenticated(ctx)) return;

  {
    const answerActiveId = ctx.getActiveAppSessionId();
    const answerActiveDir = ctx.getActiveSessionDir();
    if (answerActiveId && answerActiveDir && !ctx.getRunner()) {
      const registry = ctx.getRunnerRegistry();
      const answerRunner = registry.getOrCreate(answerActiveId, answerActiveDir, ctx.getActiveAgentId());
      ctx.attachToRunner(answerRunner);
    }
  }

  const capturedSessionId = ctx.getActiveAppSessionId();
  const session = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  const agentSessionId = session?.agentSessionId ?? capturedSessionId ?? undefined;

  const turnRunner = resolveRunner(ctx, capturedSessionId);
  if (turnRunner) turnRunner.running = true;
  if (turnRunner && capturedSessionId) {
    turnRunner.emitMessage({
      type: "session_status",
      sessionId: capturedSessionId,
      running: true,
      queueLength: turnRunner.queueLength,
    });
  }

  await runAgentWithMessage(ctx, {
    userText: answerText,
    validatedFiles: [],
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    ...(capturedPermissionMode !== undefined ? { permissionMode: capturedPermissionMode } : {}),
    ...(msg.dictated ? { dictated: true } : {}),
    isNewSession: false,
    userEcho: { ...(msg.requestId ? { clientRequestId: msg.requestId } : {}) },
  });
}
