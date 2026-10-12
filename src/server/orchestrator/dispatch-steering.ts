import { recordSteeredMessage, persistTurnInProgress } from "./ws-handlers/agent-listeners.js";
import {
  resetSubAgentSpawnBudget,
  type SessionRunnerInterface,
  type AgentDispatchOptions,
  type QueuedMessage,
  type SystemTurnDeps,
} from "./session-runner.js";
import type { FileAttachment, FileContextRef, ImageAttachment, UploadRef } from "../shared/types.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";
import { currentTurnAttempt, turnTakesMessages } from "./turn-stop-request.js";
import { resolveFileAttachments, resolveUploadRefs, formatFileContext } from "./validation.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "./prompt-assembly.js";
import { imageHash, imageUrl } from "./transcript-projection.js";
import { TURN_STEERED } from "./turn-settlement.js";

// Callers must check that a resident agent exists.
export interface SteerDecisionInputs {
  steeringCapable: boolean;
  liveSteering: boolean;
  streamingActive: boolean;
  systemTurnInProgress: boolean;
  /** `turnTakesMessages(runner)`: the agent has the turn's prompt, and the turn is no compaction. */
  takesMessages: boolean;
}

export function shouldSteerMessage(i: SteerDecisionInputs): boolean {
  return (
    i.steeringCapable &&
    i.liveSteering &&
    i.streamingActive &&
    !i.systemTurnInProgress &&
    i.takesMessages
  );
}

export interface SteerSource {
  text: string;
  images?: ImageAttachment[] | undefined;
  files?: FileContextRef[] | undefined;
  uploads?: UploadRef[] | undefined;
  dictated?: boolean | undefined;
}

export interface PreparedSteer {
  prompt: string;
  images: { data: string; mediaType: string }[] | undefined;
  files: { path: string; contentPreview: string; startLine?: number; endLine?: number }[] | undefined;
  uploadPaths: string[] | undefined;
}

/**
 * What a steer writes to the agent and what the transcript keeps of it. It reads and writes
 * the workspace, so the caller decides the steer again after it.
 */
export async function prepareSteer(dir: string, source: SteerSource): Promise<PreparedSteer | { error: string }> {
  let files: FileAttachment[] = [];
  if (source.files && source.files.length > 0) {
    const result = await resolveFileAttachments(source.files, dir);
    if (result.error) return { error: result.error };
    files = result.files;
  }
  let images = source.images && source.images.length > 0 ? source.images : undefined;
  if (source.uploads && source.uploads.length > 0) {
    const uploadResult = await resolveUploadRefs(source.uploads, dir);
    if (uploadResult.error) return { error: uploadResult.error };
    files = [...files, ...uploadResult.files];
    if (uploadResult.images.length > 0) images = [...(images ?? []), ...uploadResult.images];
  }
  const prompt = assembleAgentPrompt({
    userText: source.text,
    fileContext: files.length > 0 ? formatFileContext(files) : "",
    imageContext: images && images.length > 0 ? saveImagesToUploadsDir(images, dir) : "",
    dictated: source.dictated,
  });
  return {
    prompt,
    images: images?.map((img) => ({ data: img.data, mediaType: img.mediaType })),
    files: files.length > 0
      ? files.map((f) => ({
          path: f.path,
          contentPreview: f.content.slice(0, 200),
          startLine: f.startLine,
          endLine: f.endLine,
        }))
      : undefined,
    uploadPaths: source.uploads && source.uploads.length > 0 ? source.uploads.map((u) => u.path) : undefined,
  };
}

// Steering has no separate teardown to fire an incoming turn's completion callback, and it
// sends the text alone: a dispatch that carries attachments would lose them.
export function isSteerableDispatch(opts: AgentDispatchOptions): boolean {
  const attachments = (opts.images?.length ?? 0) + (opts.files?.length ?? 0) + (opts.uploads?.length ?? 0);
  return !opts.systemTurn && !opts.onTurnComplete && attachments === 0;
}

/** Returns false when the caller must enqueue the message. */
export function trySteerDispatch(
  runner: SessionRunnerInterface,
  opts: AgentDispatchOptions,
  deps: SystemTurnDeps,
): boolean {
  if (!isSteerableDispatch(opts)) return false;
  if (!deps.steerInputs) return false;
  const { liveSteering, steeringCapable } = deps.steerInputs();

  if (
    !shouldSteerMessage({
      steeringCapable,
      liveSteering,
      streamingActive: runner.isStreamingActive,
      systemTurnInProgress: runner.systemTurnInProgress,
      takesMessages: turnTakesMessages(runner),
    })
  ) {
    return false;
  }

  const agent = runner.getAgent();
  if (!agent) return false;

  // A resident CLI retains its spawn-time permission mode until explicitly updated.
  if (runner.appliedPermissionMode !== opts.permissionMode && agent.setPermissionMode) {
    agent.setPermissionMode(opts.permissionMode);
    runner.appliedPermissionMode = opts.permissionMode;
  }

  const surfacedText = opts.agentInterface
    ? formatAgentInterfacePrompt(opts.text, opts.agentInterface)
    : opts.text;
  const agentText = opts.messageOrigin
    ? formatSessionMessagePrompt(surfacedText, opts.messageOrigin)
    : surfacedText;
  agent.sendUserMessage(agentText);

  // Acknowledgement and retry matching need the exact text sent to the CLI.
  recordSteeredMessage(runner, opts.text, {
    assembledPrompt: agentText,
    ...(opts.bestEffortSteer ? { bestEffort: true } : {}),
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
    ...(opts.automatic ? { automatic: true } : {}),
  });
  persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
  runner.emitMessage({
    type: "message_steered",
    text: opts.text,
    sessionId: runner.sessionId,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  return true;
}

/** A message that the user wrote in this chat, and that waits in the queue. */
function isWaitingUserMessage(entry: QueuedMessage): boolean {
  return entry.execution === "interactive" && entry.automatic !== true;
}

/**
 * docs/329-user-steers-every-turn req 2 — the agent now has the prompt of the turn that
 * started, so what the user sent while no agent could read it goes into that turn, in the
 * order it was sent. One entry at a time: the preparation awaits, and the turn can end or be
 * replaced meanwhile, so the steer is decided again before each write, and an entry leaves
 * the queue only when it is written.
 */
export async function deliverWaitingMessages(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
): Promise<void> {
  const steer = deps.steerInputs?.();
  if (!steer) return;
  const attempt = currentTurnAttempt(runner);
  const takesMessagesNow = (): boolean =>
    !runner.disposed
    && currentTurnAttempt(runner) === attempt
    && !runner.mergeHold
    && shouldSteerMessage({
      steeringCapable: steer.steeringCapable,
      liveSteering: steer.liveSteering,
      streamingActive: runner.isStreamingActive,
      systemTurnInProgress: runner.systemTurnInProgress,
      takesMessages: turnTakesMessages(runner),
    });
  // An entry that cannot be prepared reports why when it runs as a turn of its own.
  const unprepared = new Set<QueuedMessage>();

  for (;;) {
    if (!takesMessagesNow()) return;
    const entry = runner.messageQueue.find((m) => isWaitingUserMessage(m) && !unprepared.has(m));
    if (!entry) return;
    const prepared = await prepareSteer(runner.sessionDir, entry);
    if ("error" in prepared) {
      unprepared.add(entry);
      continue;
    }
    if (!takesMessagesNow()) return;
    const agent = runner.getAgent();
    const index = runner.messageQueue.indexOf(entry);
    if (!agent) return;
    if (index === -1) continue;

    runner.messageQueue.splice(index, 1);
    if (runner.appliedPermissionMode !== entry.permissionMode && agent.setPermissionMode) {
      agent.setPermissionMode(entry.permissionMode);
      runner.appliedPermissionMode = entry.permissionMode;
    }
    agent.sendUserMessage(prepared.prompt);
    resetSubAgentSpawnBudget(runner);
    recordSteeredMessage(runner, entry.text, {
      images: prepared.images,
      files: prepared.files,
      uploadPaths: prepared.uploadPaths,
      assembledPrompt: prepared.prompt,
    });
    persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
    // `dequeued` puts the bubble back in the transcript, where the steer below finds it.
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot(), dequeued: entry.text });
    runner.emitMessage({
      type: "message_steered",
      text: entry.text,
      sessionId: runner.sessionId,
      images: prepared.images?.map((img) => ({
        mediaType: img.mediaType,
        src: imageUrl(runner.sessionId, imageHash(img.data)),
      })),
      files: prepared.files,
      uploadPaths: prepared.uploadPaths,
    });
    try {
      entry.onTurnComplete?.(TURN_STEERED);
    } catch (err) {
      console.error(`[steer] the callback of a delivered message for ${runner.sessionId} threw:`, err);
    }
    // In order: the next message goes in after the agent has this one. A rejected write
    // puts the message back in the queue by its own path (`agent_steer_rejected`).
    await agent.submissionSettled?.()?.catch(() => {});
  }
}
