import type { AgentId, AgentProcess, FileAttachment, ImageAttachment } from "../shared/types.js";
import { executeAgentTurn } from "./turn-executor.js";
import { releaseResidentOnSpawnChange } from "./resident-spawn-guard.js";
import { desiredSpawnIdentity } from "./service-routing.js";
import { buildTurnMessages, emitNoticePostTurn } from "./chat-card-persistence.js";
import { resolveFileAttachments, resolveUploadRefs, formatFileContext, imageAttachmentRefusal } from "./validation.js";
import { modelSelectionOf } from "./session-agent-env.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "./prompt-assembly.js";
import { buildBugOutcomeNotice } from "./services/bug-report.js";
import type {
  SessionRunnerInterface,
  SystemTurnDeps,
} from "./session-runner.js";
import type { PreparedDispatch } from "./prepared-dispatch.js";
import { queuedMessageToDispatchOptions } from "./queue-drain.js";
import { prepareDispatch } from "./prepared-dispatch.js";
import { toQueuedMessage } from "./session-runner.js";
import { POST_MERGE_COMPACT_PROMPT, noteMissedCompaction } from "./compact-before-turn.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";
import { dependencyGapAgentPrefix } from "./dependency-staleness.js";
import { isCompactCommand } from "../shared/compact-command.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";

const MAX_NO_RESULT_RETRIES = 1;

// Clearing the slot bypasses displacement detection. Settle without touching the next turn.
function supersedeRetiredTurn(outgoing: AgentProcess): void {
  outgoing.emit("superseded");
}

// Queue incoming messages during the decision; compaction keeps the hold if selected.
async function decideWithSystemHold(
  runner: SessionRunnerInterface,
  decide: () => Promise<boolean>,
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
}

// Reserve the runner during setup, before the executor owns failure cleanup.
export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: PreparedDispatch,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  runner.running = true;
  if (opts.systemTurn) runner.systemTurnInProgress = true;
  runner.activeDeliveryId = opts.deliveryId;
  try {
    await runDispatchedTurnInner(runner, deps, agentId, opts, createAgent);
  } catch (err) {
    runner.running = false;
    if (opts.systemTurn) runner.systemTurnInProgress = false;
    if (opts.deliveryId !== undefined && runner.activeDeliveryId === opts.deliveryId) {
      runner.activeDeliveryId = undefined;
    }
    throw err;
  }
}

async function runDispatchedTurnInner(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: PreparedDispatch,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  // Queued and recovered turns must recheck admission.
  runner.assertCanDispatch();
  const { text, activity } = opts;

  const isCompactRequest =
    (getAgentCapabilities(agentId)?.supportsCompaction ?? false) && isCompactCommand(text);

  const steer = opts.systemTurn ? undefined : deps.steerInputs?.();
  const useStreaming = steer ? steer.liveSteering && steer.steeringCapable : false;
  const sessionDir = runner.sessionDir;

  // Keep this message first after compaction; avoid resolving its attachments twice.
  if (
    sessionDir && opts.postTurn !== "none" && !isCompactRequest
    && await decideWithSystemHold(runner, () =>
      deps.shouldCompactBeforeTurn?.(runner, agentId, runner.sessionId, sessionDir, opts.compactContext) ?? Promise.resolve(false))
  ) {
    runner.messageQueue.unshift({ ...toQueuedMessage(opts), compactContext: false });
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, prepareDispatch({
      text: POST_MERGE_COMPACT_PROMPT,
      agentInterface: undefined,
      messageOrigin: undefined,
      execution: undefined,
      activity: "Compacting context…",
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: opts.permissionMode,
      postTurn: undefined,
      systemTurn: true,
      onTurnComplete: undefined,
      deliveryId: undefined,
      dictated: undefined,
      resetMergedBranch: undefined,
      compactContext: undefined,
      silent: true,
    }), createAgent);
    return;
  }

  let validatedFiles: FileAttachment[] = [];
  let images: ImageAttachment[] | undefined =
    opts.images && opts.images.length > 0 ? opts.images : undefined;
  let uploadPaths: string[] | undefined;
  if (sessionDir) {
    if (opts.files && opts.files.length > 0) {
      const result = await resolveFileAttachments(opts.files, sessionDir);
      if (result.error) {
        emitNoticePostTurn(
          (m) => runner.emitMessage(m),
          deps.listenerDeps.chatHistoryManager,
          runner.sessionId,
          `Some attached files couldn't be read: ${result.error}`,
          "warn",
        );
      } else {
        validatedFiles = result.files;
      }
    }
    if (opts.uploads && opts.uploads.length > 0) {
      const uploadResult = await resolveUploadRefs(opts.uploads, sessionDir);
      if (uploadResult.error) {
        emitNoticePostTurn(
          (m) => runner.emitMessage(m),
          deps.listenerDeps.chatHistoryManager,
          runner.sessionId,
          `Some attached uploads couldn't be read: ${uploadResult.error}`,
          "warn",
        );
      } else {
        validatedFiles = [...validatedFiles, ...uploadResult.files];
        if (uploadResult.images.length > 0) {
          images = [...(images ?? []), ...uploadResult.images];
        }
        uploadPaths = opts.uploads.map((u) => u.path);
      }
    }
  }
  // The model may have changed since enqueue. Warn and omit unsupported images;
  // retain uploadPaths so the user's attachment chips still appear.
  if (images && images.length > 0) {
    const session = deps.listenerDeps.sessionManager.get(runner.sessionId);
    const blindNotice = imageAttachmentRefusal(
      session ? modelSelectionOf(session) : undefined,
      images,
      undefined,
    );
    if (blindNotice) {
      emitNoticePostTurn(
        (m) => runner.emitMessage(m),
        deps.listenerDeps.chatHistoryManager,
        runner.sessionId,
        blindNotice,
        "warn",
      );
      images = undefined;
    }
  }

  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && sessionDir ? saveImagesToUploadsDir(images, sessionDir) : "";
  const surfacedText = opts.agentInterface ? formatAgentInterfacePrompt(text, opts.agentInterface) : text;
  const agentText = opts.messageOrigin
    ? formatSessionMessagePrompt(surfacedText, opts.messageOrigin)
    : surfacedText;

  // Reset once per message, outside retries. postTurn:none belongs to an ongoing git operation.
  const reset = sessionDir && opts.postTurn !== "none" && !isCompactRequest
    ? await deps.preTurnReset?.(
        runner, runner.sessionId, sessionDir, opts.resetMergedBranch,
      )
    : undefined;

  const pendingNotice = opts.postTurn !== "none" && !isCompactRequest
    ? deps.consumePendingAgentNotice?.(runner.sessionId) ?? ""
    : "";
  // Consumption clears the notice; restore it if setup fails before executor handoff.
  let promptDelivered = false;
  const reparkNoticeIfUndelivered = () => {
    if (!pendingNotice || promptDelivered) return;
    promptDelivered = true;
    try {
      deps.restorePendingAgentNotice?.(runner.sessionId, pendingNotice);
    } catch (err) {
      console.error("[dispatch] re-parking the pending agent notice failed:", err);
    }
  };

  // Bug outcomes are intentionally consumed at most once, including failed delivery.
  const bugOutcomeNotice = opts.systemTurn || isCompactRequest
    ? ""
    : buildBugOutcomeNotice(deps.consumeBugOutcomes?.(runner.sessionId) ?? []);

  const agentPrefix = [
    pendingNotice,
    bugOutcomeNotice,
    reset?.agentPrefix,
    isCompactRequest ? "" : dependencyGapAgentPrefix(runner.dependencyGap),
  ]
    .filter(Boolean)
    .join("\n\n");
  const roleContext = deps.takeRoleInstructions?.(runner.sessionId) ?? "";
  const prompt =
    (agentPrefix ? `${agentPrefix}\n\n` : "") +
    assembleAgentPrompt({
      userText: agentText,
      fileContext,
      imageContext,
      ...(roleContext ? { roleContext } : {}),
      dictated: opts.dictated,
    });

  const historyImages = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
  const historyFiles =
    validatedFiles.length > 0
      ? validatedFiles.map((f) => ({
          path: f.path,
          contentPreview: f.content.slice(0, 200),
          startLine: f.startLine,
          endLine: f.endLine,
        }))
      : undefined;

  const drainNext = async (): Promise<void> => {
    // A rebase may take the hold during the local commit. A system turn owns its existing hold.
    if (runner.systemTurnInProgress && !opts.systemTurn) return;
    if (opts.silent) {
      runner.systemTurnInProgress = false;
      noteMissedCompaction(runner, deps.listenerDeps.chatHistoryManager, runner.sessionId);
    }
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  let noResultRetries = 0;

  // All retry attempts share one settlement, owned by the latest attempt.
  let currentAttempt = 0;
  let settled = false;
  const settleAttempt = (attempt: number, outcome: TurnOutcome): void => {
    if (attempt !== currentAttempt) return;
    if (settled) return;
    settled = true;
    opts.onTurnComplete?.(outcome);
  };

  const runOnce = async (attempt: number): Promise<void> => {
    // Retire before capture: env prep must not kill the incoming agent during account failover.
    if (deps.needsAccountFailover?.(runner.sessionId, agentId)) {
      const outgoing = runner.getAgent();
      if (outgoing) {
        // Settlement needs its listener; remove listeners before kill can emit late terminal events.
        supersedeRetiredTurn(outgoing);
        try { outgoing.removeAllListeners(); } catch { /* already bare */ }
        try { outgoing.kill(); } catch { /* already gone */ }
        runner.setAgent(null);
      }
    }
    if (!opts.systemTurn) {
      releaseResidentOnSpawnChange(
        runner,
        desiredSpawnIdentity(deps.listenerDeps.sessionManager, runner.sessionId, agentId),
      );
    }
    // Reuse follows the resident process, even if live steering was since disabled.
    const resident =
      !opts.systemTurn && attempt === 0 && runner.isStreamingActive ? runner.getAgent() : null;
    const reuse = resident !== null;
    // System turns must retire the resident before env prep rewrites its credential tree.
    if (opts.systemTurn && !reuse) {
      const outgoing = runner.getAgent();
      if (outgoing) {
        supersedeRetiredTurn(outgoing);
        try { outgoing.kill(); } catch { /* already gone */ }
        runner.setAgent(null);
        runner.isStreamingActive = false;
      }
    }
    const agent = resident ?? createAgent(agentId);
    const turnStreams = useStreaming || reuse;
    if (reuse) agent.removeAllListeners();

    promptDelivered = true;
    await executeAgentTurn(runner, deps, agent, {
      agentId,
      sessionId: runner.sessionId,
      prompt,
      userText: text,
      ...(activity !== undefined ? { activity } : {}),
      ...(turnStreams ? { useStreaming: true } : {}),
      ...(reuse ? { reuseExistingAgent: true } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(isCompactRequest ? { compact: true } : {}),
      ...(opts.postTurn !== undefined ? { postTurn: opts.postTurn } : {}),
      ...(opts.systemTurn !== undefined ? { systemTurn: opts.systemTurn } : {}),
      ...(opts.deliveryId !== undefined ? { deliveryId: opts.deliveryId } : {}),
      onTurnComplete: (outcome) => settleAttempt(attempt, outcome),
      emitUserEcho: attempt === 0 && !opts.silent,
      ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
      ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
      ...(attempt === 0 && reset?.afterUserMessagePersisted
        ? { afterUserMessagePersisted: reset.afterUserMessagePersisted }
        : {}),
      persistUserMessage:
        attempt === 0 && !opts.silent
          ? (sid) =>
              deps.listenerDeps.chatHistoryManager.append(sid, {
                role: "user",
                text,
                ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
                ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
                ...(historyImages ? { images: historyImages } : {}),
                ...(historyFiles ? { files: historyFiles } : {}),
                ...(uploadPaths && uploadPaths.length > 0 ? { uploadPaths } : {}),
              })
          : () => { /* already persisted or silent */ },
      isNewSession: false,
      fallbackTitle: text.slice(0, 80) || "Agent",
      turnStartHeadHash: null,
      drainNext,
      emit: (m) => runner.emitMessage(m),
      onNoResultExit: async (code, stderrDetail) => {
        // Retrying partial work repeats side effects and clears the transcript before finalization.
        const producedPartialWork =
          buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          ).length > 0;

        if (!producedPartialWork && noResultRetries < MAX_NO_RESULT_RETRIES) {
          noResultRetries++;
          // Transfer settlement ownership before starting the retry.
          currentAttempt = attempt + 1;
          console.warn(
            `[turn] dispatched turn for ${runner.sessionId} exited (code ${code}) with no result — ` +
              `retrying (attempt ${noResultRetries}/${MAX_NO_RESULT_RETRIES})`,
          );
          emitNoticePostTurn(
            (m) => runner.emitMessage(m),
            deps.listenerDeps.chatHistoryManager,
            runner.sessionId,
            "The agent didn't start on the first attempt — retrying…",
            "warn",
          );
          await runOnce(attempt + 1);
          return true;
        }
        console.error(
          `[turn] dispatched turn for ${runner.sessionId} exited with no result ` +
            `(partialWork=${producedPartialWork}, retries=${noResultRetries}) — surfacing error`,
        );
        // The error handler finalizes partial work and releases the queue.
        const summary = producedPartialWork
          ? (code !== null && code !== 0
              ? `The agent stopped before finishing (exit ${code}). The work so far is preserved — send your message again to continue.`
              : "The agent stopped before finishing. The work so far is preserved — send your message again to continue.")
          : (code !== null && code !== 0
              ? `The agent exited with code ${code} without running. Please send your message again.`
              : "The agent stopped without doing any work. Please send your message again.");
        agent.emit("error", new Error(stderrDetail ? `${summary} (${stderrDetail})` : summary));
        return true;
      },
    });
  };

  // Record a branch reset even when setup fails before the user row is persisted.
  try {
    await runOnce(0);
  } finally {
    reset?.ensureRecorded?.(runner.sessionId);
    reparkNoticeIfUndelivered();
  }
}
