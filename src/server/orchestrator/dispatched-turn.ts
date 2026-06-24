/**
 * Thin dispatch adapter over the shared `executeAgentTurn` (turn-executor.ts).
 *
 * Translates a server-dispatched message (quick / child / CI-fix / HTTP
 * dispatch / queue drain) into a normalized `TurnInput` and delegates. The only
 * dispatch-specific work left here is: acquire the agent (reuse a resident
 * streaming process when this turn streams and one is alive — docs/163 — else
 * spawn fresh; system turns never stream so they always spawn fresh), echo the
 * message via `emitUserEcho`, persist the user row (text-only), and supply the
 * queue-drain re-entry. Everything else — reset, env-prep, spawn, listeners,
 * post-turn commit/push/PR/drain — lives in the shared executor so this path
 * can't drift from the WS path.
 *
 * docs/163 — a child/quick-session dispatched turn runs as a *streaming* process
 * when live steering is on and the agent supports it (the same gate the WS path
 * uses), so a follow-up `shipit session message` arriving mid-turn is steered
 * into the running turn instead of being queued. See `useStreaming` below.
 *
 * Used by both SessionRunner.dispatch and ContainerSessionRunner.dispatch.
 *
 * docs/149 — async because env-prep + run-params assembly are async. Callers
 * fire-and-forget via `void runDispatchedTurn(...)`.
 */

import type { AgentId, AgentProcess, FileAttachment, ImageAttachment } from "../shared/types.js";
import { executeAgentTurn } from "./turn-executor.js";
import { buildTurnMessages, emitNoticePostTurn } from "./chat-card-persistence.js";
import { resolveFileAttachments, resolveUploadRefs, formatFileContext } from "./validation.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "./prompt-assembly.js";
import type {
  SessionRunnerInterface,
  SystemTurnDeps,
  AgentDispatchOptions,
  QueuedMessage,
} from "./session-runner.js";

function queuedMessageToDispatchOptions(next: QueuedMessage): AgentDispatchOptions {
  const nextOpts: AgentDispatchOptions = { text: next.text };
  if (next.activity !== undefined) nextOpts.activity = next.activity;
  if (next.images !== undefined) nextOpts.images = next.images;
  if (next.files !== undefined) nextOpts.files = next.files;
  if (next.uploads !== undefined) nextOpts.uploads = next.uploads;
  if (next.permissionMode !== undefined) nextOpts.permissionMode = next.permissionMode;
  if (next.postTurn !== undefined) nextOpts.postTurn = next.postTurn;
  if (next.systemTurn !== undefined) nextOpts.systemTurn = next.systemTurn;
  // docs/196 fix — carry the completion callback so an enqueued turn signals
  // completion when it drains (the merge-watch busy path depends on this).
  if (next.onTurnComplete !== undefined) nextOpts.onTurnComplete = next.onTurnComplete;
  return nextOpts;
}

/**
 * How many times a dispatched first turn that exited WITHOUT producing a result
 * is auto-retried before we give up and surface a visible error. The known
 * manual workaround for the docs/163 "quick-session first turn never ran" bug
 * is resending the prompt — one automatic retry reproduces that workaround so
 * the user never has to. Bounded so a genuinely broken turn can't loop.
 */
const MAX_NO_RESULT_RETRIES = 1;

export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: AgentDispatchOptions,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  const { text, activity } = opts;

  // docs/163 — a child/quick-session dispatched turn must run as a *streaming*
  // process when live steering is on and the agent supports it, EXACTLY as a
  // user-typed WS turn does (agent-execution.ts computes the same gate). The
  // child's own first turn is started through THIS path, so if it spawns
  // non-streaming the resident process is one-shot, `runner.isStreamingActive`
  // stays false, and a follow-up `shipit session message` arriving mid-turn
  // fails `shouldSteerMessage` and is QUEUED instead of injected — the "spawn a
  // session, then message it, and the message just sits in the queue" bug. With
  // streaming on, the running turn's agent is steerable, so `trySteerDispatch`
  // injects the message via `sendUserMessage`, i.e. it behaves as if the user
  // typed it. System turns (rebase resolution, CI-fix) are explicitly never
  // steered (`systemTurnInProgress` blocks it), so they stay non-streaming and
  // keep their fresh-agent-per-turn / one-shot post-turn semantics.
  const steer = opts.systemTurn ? undefined : deps.steerInputs?.();
  const useStreaming = steer ? steer.liveSteering && steer.steeringCapable : false;

  // Fold any attachments into the prompt EXACTLY as the WS path does
  // (agent-execution.ts:runAgentWithMessage). A quick / child session dispatch
  // carries `uploads` (saved into the session's uploads dir by
  // `createHeadlessSession` before this turn fires) and may carry `files` /
  // inline `images`. Without resolving them here, `executeAgentTurn` would
  // receive a text-only prompt and the agent would never see the attached
  // image — the file sits on disk, unreferenced. We resolve upload refs to
  // ImageAttachments / FileAttachments, save images to the uploads dir
  // (referenced in place via `existingPath`), and assemble the slash-aware
  // prompt. `uploadPaths` is persisted on the user row so the bubble rehydrates
  // with its image/file chips and `hydrateUploads` sees the upload as sent.
  const sessionDir = runner.sessionDir;
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
        // Record the original `/uploads/...` paths even when the upload was a
        // non-image file, so the user bubble rehydrates with its chips.
        uploadPaths = opts.uploads.map((u) => u.path);
      }
    }
  }
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && sessionDir ? saveImagesToUploadsDir(images, sessionDir) : "";
  const prompt = assembleAgentPrompt({ userText: text, fileContext, imageContext });

  // Chat-history metadata for the persisted user row — mirrors the WS path so a
  // reload shows the same inline image / file chips on the dispatched bubble.
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
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  // Tracks no-result retries across the recursive `runOnce` calls for THIS
  // dispatched message (a queue drain re-enters `runDispatchedTurn`, which gets
  // its own fresh counter — each message is retried independently).
  let noResultRetries = 0;

  const runOnce = async (attempt: number): Promise<void> => {
    // docs/140 + docs/163 — when a resident streaming process from a previous
    // turn is still alive, REUSE it (carry the message in via `sendUserMessage`)
    // exactly as the WS path does, rather than spawning a fresh agent. Spawning
    // fresh while the worker still holds the old streaming process would 409 the
    // `/agent/start` and trigger a kill+restart (SIGTERM 143) — the respawn-noise
    // bug docs/140 fixed for the WS path.
    //
    // docs/146 follow-up (prod dispatched-turn race): the reuse decision must
    // NOT be gated on THIS turn's recomputed `useStreaming`. When a streaming
    // process is resident (`isStreamingActive`) but this dispatch happens to
    // compute `useStreaming === false` (live-steering toggled off, or
    // `steerInputs` momentarily reporting not-capable), the old code spawned a
    // fresh one-shot `claude -p <prompt>` via `createAgent`. That fresh proxy
    // DISPLACES the live streaming proxy in the runner's single `_agent` slot
    // and orphans it; when the one-shot later exits with no result it nulls the
    // slot, and the still-running streaming process's assistant/tool_result/
    // result events are then sse-dropped `(no _agent)` — the whole turn vanishes
    // from the UI. A live streaming process is fed via `sendUserMessage`, never
    // re-spawned. So reuse whenever one is resident, independent of
    // `useStreaming`. System turns (rebase / CI-fix) keep their fresh-spawn /
    // one-shot semantics — they are never steered and must not adopt the
    // resident process. Only the FIRST attempt can reuse; a no-result retry
    // always spawns fresh (the resident ref was cleared by the `done` handler
    // when the process exited without a result).
    const resident =
      !opts.systemTurn && attempt === 0 && runner.isStreamingActive ? runner.getAgent() : null;
    const reuse = resident !== null;
    const agent = resident ?? createAgent(agentId);
    // A reused process IS the resident streaming process, so this turn streams
    // (and the post-turn handler must key on streaming) even if `useStreaming`
    // was recomputed false for this dispatch. Otherwise `executeAgentTurn` would
    // set `isStreamingActive = false` and route the post-turn flow through the
    // non-streaming branch, clearing the resident flag mid-turn.
    const turnStreams = useStreaming || reuse;
    // Drop the previous turn's per-turn listeners off a reused process before the
    // executor wires its own, else they fire N times after N turns (mirrors the
    // WS path's `existingAgent.removeAllListeners()`).
    if (reuse) agent.removeAllListeners();

    await executeAgentTurn(runner, deps, agent, {
      agentId,
      sessionId: runner.sessionId,
      prompt,
      userText: text,
      ...(activity !== undefined ? { activity } : {}),
      // Only set the key when streaming so a non-steerable dispatch keeps the
      // exact run-params shape it had before (turn-executor leaves `useStreaming`
      // out of the run params when this is undefined — see its spawn branch).
      // `turnStreams` (not `useStreaming`) so a turn that reuses a resident
      // streaming process is treated as streaming end-to-end.
      ...(turnStreams ? { useStreaming: true } : {}),
      // Carry the message into the resident streaming process via
      // `sendUserMessage` instead of a fresh `/agent/start` (turn-executor's
      // reuse branch).
      ...(reuse ? { reuseExistingAgent: true } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      // docs/169 — post-turn policy + system-turn marker + completion signal.
      ...(opts.postTurn !== undefined ? { postTurn: opts.postTurn } : {}),
      ...(opts.systemTurn !== undefined ? { systemTurn: opts.systemTurn } : {}),
      // The completion callback only fires on the FIRST attempt's turn — a
      // no-result retry re-enters runOnce and would otherwise fire it twice.
      // (The rebase loop never sets onNoResultExit, so retries don't apply to
      // it; this guard keeps the contract clean regardless.)
      ...(attempt === 0 && opts.onTurnComplete !== undefined ? { onTurnComplete: opts.onTurnComplete } : {}),
      // Server-initiated message → emit a bubble (no client-side optimistic
      // one). A retry must NOT re-echo the bubble or re-append the user row —
      // both already happened on the first attempt — so only the first run does.
      emitUserEcho: attempt === 0,
      persistUserMessage:
        attempt === 0
          ? (sid) =>
              deps.listenerDeps.chatHistoryManager.append(sid, {
                role: "user",
                text,
                ...(historyImages ? { images: historyImages } : {}),
                ...(historyFiles ? { files: historyFiles } : {}),
                ...(uploadPaths && uploadPaths.length > 0 ? { uploadPaths } : {}),
              })
          : () => { /* user row already persisted on the first attempt */ },
      isNewSession: false,
      fallbackTitle: text.slice(0, 80) || "Agent",
      turnStartHeadHash: null,
      drainNext,
      emit: (m) => runner.emitMessage(m),
      // The masking-bug fix (docs/163): a dispatched first turn that exits
      // without an `agent_result` is NOT a completed turn. Auto-retry once
      // (the user's known "resend the prompt" workaround), then surface a
      // visible error so the failure can never silently vanish again.
      onNoResultExit: async (code) => {
        // A turn that streamed visible work (assistant text / tool calls) before
        // exiting WITHOUT an `agent_result` — the OOM/SIGHUP case (exit 137/129
        // under memory pressure) — DID run, and must NOT be retried:
        //   1. Re-running re-executes an already-partially-applied prompt.
        //   2. The retry's `resetRunnerTurnState` clears `runner.chatMessageGroups`
        //      in memory while the streamed rows are still `in_progress=1` in the
        //      DB. When the retry then also exits without a result, the surfaced
        //      error rebuilds chat history from the now-EMPTY groups, so
        //      `replaceInProgress([])` deletes the partial turn's rows. Across a
        //      long memory-pressured session these unfinalized `in_progress=1`
        //      rows accumulate and vanish in one wipe — "the agent did the work
        //      but the turns disappeared", while the diffs survive in git.
        // So only the genuinely-empty "never ran" exit (docs/163) is retried; a
        // partial-work exit surfaces the error immediately, while the groups are
        // still intact, so the `agent.error` handler FINALIZES the partial turn
        // (`replaceInProgress` + `finalizeInProgress`) instead of deleting it.
        // The WS path preserves partial turns the same way via `onInterruptedTurn`;
        // dispatch must not retry away from that guarantee.
        const producedPartialWork =
          buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          ).length > 0;

        if (!producedPartialWork && noResultRetries < MAX_NO_RESULT_RETRIES) {
          noResultRetries++;
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
        // Route through the agent's `error` event so the failure surfaces
        // exactly like any other turn error — a chat error row, a
        // `session_status` reset, `session_agent_finished`, and a queue drain —
        // instead of being swallowed as a completed turn. When the turn streamed
        // partial work before dying, the error handler FINALIZES those still-intact
        // groups (so the visible work is preserved on reload); phrase the message
        // as "stopped before finishing" rather than "without running", which only
        // fits the genuinely-empty case.
        agent.emit(
          "error",
          new Error(
            producedPartialWork
              ? (code !== null && code !== 0
                  ? `The agent stopped before finishing (exit ${code}). The work so far is preserved — send your message again to continue.`
                  : "The agent stopped before finishing. The work so far is preserved — send your message again to continue.")
              : (code !== null && code !== 0
                  ? `The agent exited with code ${code} without running. Please send your message again.`
                  : "The agent stopped without doing any work. Please send your message again."),
          ),
        );
        return true;
      },
    });
  };

  await runOnce(0);
}
