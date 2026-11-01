import { recordSteeredMessage, persistTurnInProgress } from "./ws-handlers/agent-listeners.js";
import type {
  SessionRunnerInterface,
  AgentDispatchOptions,
  QueuedMessage,
  SystemTurnDeps,
} from "./session-runner.js";
import type { FileAttachment, FileContextRef, ImageAttachment, UploadRef } from "../shared/types.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";
import { currentTurnAttempt, setSteerRefused, steerRefused, turnTakesMessages } from "./turn-stop-request.js";
import { resolveFileAttachments, resolveUploadRefs, formatFileContext } from "./validation.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "./prompt-assembly.js";
import { imageHash, imageUrl } from "./transcript-projection.js";
import { TURN_STEERED } from "./turn-settlement.js";
import { nextSendOrder, queueEntryId } from "./queue-identity.js";
import { releaseQueuedTurn } from "./queue-drain.js";
import { returnQueueSentBeforeStop } from "./queue-return.js";
import { isCompactCommand } from "../shared/compact-command.js";
import { parseGoalCommand } from "../shared/goal-command.js";

// Callers must check that a resident agent exists.
export interface SteerDecisionInputs {
  steeringCapable: boolean;
  liveSteering: boolean;
  streamingActive: boolean;
  /** `turnTakesMessages(runner)`: the agent has the turn's prompt, and the turn is no compaction. */
  takesMessages: boolean;
}

export function shouldSteerMessage(i: SteerDecisionInputs): boolean {
  return (
    i.steeringCapable &&
    i.liveSteering &&
    i.streamingActive &&
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
  return !opts.onTurnComplete && attachments === 0;
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
  const clientRequestId = recordSteeredMessage(runner, opts.text, {
    assembledPrompt: agentText,
    ...(opts.bestEffortSteer ? { bestEffort: true } : {}),
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
    ...(opts.automatic ? { automatic: true } : {}),
    ...(opts.clientRequestId !== undefined ? { clientRequestId: opts.clientRequestId } : {}),
    ...(opts.sendOrder !== undefined ? { sendOrder: opts.sendOrder } : {}),
    // A message of the user's that a drain dispatched is still theirs.
    ...(opts.execution === "interactive" && !opts.steeredDispatch ? {} : { steeredDispatch: true }),
  });
  persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
  runner.emitMessage({
    type: "message_steered",
    text: opts.text,
    sessionId: runner.sessionId,
    clientRequestId,
    ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
    ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
  });
  return true;
}

/**
 * A message that the user wrote in this chat, and that waits in the queue. Not a command of
 * the harness: steered text is not read as one, so `/compact` and `/goal` keep their turn.
 */
function isWaitingUserMessage(entry: QueuedMessage): boolean {
  return entry.execution === "interactive"
    && entry.automatic !== true
    && !isCompactCommand(entry.text)
    && parseGoalCommand(entry.text) === null;
}

/** A newer message of the user's must not pass one that still waits; see `deliverWaitingMessages`. */
export function userMessageWaits(runner: Pick<SessionRunnerInterface, "messageQueue">): boolean {
  return runner.messageQueue.some(isWaitingUserMessage);
}

/** What a delivery reads: the steering inputs, and the history it saves the steer to. */
export type SteerDeliveryDeps = Pick<SystemTurnDeps, "steerInputs"> & {
  listenerDeps: Pick<SystemTurnDeps["listenerDeps"], "chatHistoryManager">;
};

/** The turn attempt that a delivery runs for now. */
const delivering = new WeakMap<object, object | undefined>();

/** An entry that could not be prepared reports why when it runs as a turn of its own. */
const unprepared = new WeakSet<QueuedMessage>();

/**
 * docs/329-user-steers-every-turn req 2 — the agent now has the prompt of the turn that
 * started, so what the user sent while no agent could read it goes into that turn, in the
 * order it was sent. One entry at a time: the preparation awaits, and the turn can end, be
 * stopped or be replaced meanwhile, so the steer is decided again before each write.
 *
 * One delivery runs for a turn attempt, because the next message must wait for the agent's
 * answer to the one before it. A call while it runs adds nothing: the loop reads the queue
 * again before each message.
 */
export async function deliverWaitingMessages(
  runner: SessionRunnerInterface,
  deps: SteerDeliveryDeps,
): Promise<void> {
  const steer = deps.steerInputs?.();
  if (!steer) return;
  const attempt = currentTurnAttempt(runner);
  if (delivering.has(runner) && delivering.get(runner) === attempt) return;
  delivering.set(runner, attempt);

  const takesMessagesNow = (): boolean =>
    !runner.disposed
    && currentTurnAttempt(runner) === attempt
    && !runner.mergeHold
    // A Stop, or a question of the agent's: the turn is ending, though `running` is still set.
    && !runner.wasInterrupted
    && !steerRefused(runner)
    && shouldSteerMessage({
      steeringCapable: steer.steeringCapable,
      liveSteering: steer.liveSteering,
      streamingActive: runner.isStreamingActive,
      takesMessages: turnTakesMessages(runner),
    });

  try {
    for (;;) {
      if (!takesMessagesNow()) return;
      returnQueueSentBeforeStop(runner);
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
      try {
        if (runner.appliedPermissionMode !== entry.permissionMode && agent.setPermissionMode) {
          agent.setPermissionMode(entry.permissionMode);
          runner.appliedPermissionMode = entry.permissionMode;
        }
        agent.sendUserMessage(prepared.prompt);
      } catch (err) {
        // Not written: the entry is still the user's next message.
        runner.messageQueue.splice(index, 0, entry);
        throw err;
      }
      // Written: from here a failure must not leave the entry's handle open.
      try {
        recordDelivered(runner, deps, entry, prepared);
      } catch (err) {
        console.error(`[steer] recording a delivered message for ${runner.sessionId} failed:`, err);
      }
      try {
        entry.onTurnComplete?.(TURN_STEERED);
      } catch (err) {
        console.error(`[steer] the callback of a delivered message for ${runner.sessionId} threw:`, err);
      }
      // In order: the next message goes in after the agent has this one. A refusal puts the
      // message back in the queue by its own path (`agent_steer_rejected`), and the loop must
      // not send it again: the mark, read above, stops it. The worker can also accept the
      // write and the harness refuse it later; the listener of that event sets the same mark.
      try {
        await agent.submissionSettled?.();
      } catch {
        if (currentTurnAttempt(runner) === attempt) setSteerRefused(runner, true);
        return;
      }
    }
  } finally {
    if (delivering.get(runner) === attempt) delivering.delete(runner);
  }
}

function recordDelivered(
  runner: SessionRunnerInterface,
  deps: SteerDeliveryDeps,
  entry: QueuedMessage,
  prepared: PreparedSteer,
): void {
  const clientRequestId = recordSteeredMessage(runner, entry.text, {
    images: prepared.images,
    files: prepared.files,
    uploadPaths: prepared.uploadPaths,
    assembledPrompt: prepared.prompt,
    clientRequestId: queueEntryId(entry),
    ...(entry.sendOrder !== undefined ? { sendOrder: entry.sendOrder } : {}),
    ...(entry.steeredDispatch ? { steeredDispatch: true } : {}),
  });
  persistTurnInProgress(deps.listenerDeps.chatHistoryManager, runner, runner.sessionId);
  // No `dequeued`: the steer is the bubble, with its attachments, on every viewer (planning#691).
  runner.emitMessage({ type: "queue_updated", sessionId: runner.sessionId, queue: runner.getQueueSnapshot() });
  runner.emitMessage({
    type: "message_steered",
    text: entry.text,
    sessionId: runner.sessionId,
    clientRequestId,
    images: prepared.images?.map((img) => ({
      mediaType: img.mediaType,
      src: imageUrl(runner.sessionId, imageHash(img.data)),
    })),
    files: prepared.files,
    uploadPaths: prepared.uploadPaths,
  });
}

/**
 * planning#703 — a turn of the CLI's own took the claim of a turn still in setup. The message
 * goes back to the head of the queue, not started, and reaches the agent as one sent during
 * that turn does: steered in, or run after it through the queue's gates. When that turn has
 * already ended, its drain is past, so the head is released here.
 */
export function requeueDisplacedTurn(
  runner: SessionRunnerInterface,
  entry: QueuedMessage | undefined,
  deps: SteerDeliveryDeps,
): void {
  if (entry) {
    const queued = { ...entry, sendOrder: entry.sendOrder ?? nextSendOrder() };
    runner.messageQueue.unshift(queued);
    runner.emitMessage({
      type: "message_queued",
      sessionId: runner.sessionId,
      id: queueEntryId(queued),
      text: queued.text,
      position: 1,
    });
  }
  console.log(
    `[queue] runner=${runner.sessionId} put a turn back in the queue — the agent started a turn of its own during its setup`,
  );
  if (!runner.running) {
    releaseQueuedTurn(runner);
    return;
  }
  void deliverWaitingMessages(runner, deps).catch((err: unknown) => {
    console.error(`[queue] delivering the waiting messages of ${runner.sessionId} failed:`, err);
  });
}
