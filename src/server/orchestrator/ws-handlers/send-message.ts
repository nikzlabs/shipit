import fs from "node:fs/promises";
import type { WsClientMessage, ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { validateImages, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { graduateSession } from "../services/graduate-session.js";
import { recordSteeredMessage, persistTurnInProgress } from "./agent-listeners.js";
import { runAgentWithMessage, saveImagesToUploadsDir, assembleAgentPrompt } from "./agent-execution.js";
import { resolveRunner } from "./resolve-runner.js";
import { shouldSteerMessage } from "../dispatch-steering.js";

// Re-export all public symbols from sub-modules for backwards compatibility
export { CONTEXT_WINDOW_TOKENS, wireAgentListeners, extractToolResults } from "./agent-listeners.js";
export { runAgentWithMessage } from "./agent-execution.js";
export { postTurnCommit } from "./post-turn.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsSendReviewMessage = Extract<WsClientMessage, { type: "send_review_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;

function ensureActiveAgentAuthenticated(ctx: FullCtx): boolean {
  const activeAgentId = ctx.getActiveAgentId();

  // docs/155: per-backend auth gate; mirrored in services/agent.ts (HTTP
  // dispatch path). `AgentAuthManager.isConfigured()` + the
  // `Map<AgentId, AgentAuthManager>` from `buildAgentRuntime()` could front
  // this dispatch, but Claude's `checkCredentials()` (re-read on-disk creds)
  // and Codex's `agentRegistry.refreshAuth("codex")` (re-read env-var) plus
  // the per-backend error copy are still distinct. Consolidation tracked but
  // not done; the disables below annotate the surviving branches.
  // eslint-disable-next-line no-restricted-syntax -- docs/155: per-backend auth gate (see comment above)
  if (activeAgentId === "claude") {
    if (!ctx.authManager.authenticated) {
      ctx.authManager.checkCredentials();
    }
    if (!ctx.authManager.authenticated) {
      ctx.send({ type: "auth_required" });
      ctx.authManager.startOAuthFlow();
      return false;
    }
    return true;
  }

  // eslint-disable-next-line no-restricted-syntax -- docs/155: per-backend auth gate (see comment above)
  if (activeAgentId === "codex") {
    ctx.agentRegistry.refreshAuth("codex");
    const info = ctx.agentRegistry.get("codex");
    if (!info?.authConfigured) {
      ctx.send({
        type: "error",
        message: "Codex is not authenticated. Sign in to Codex or add OPENAI_API_KEY in Settings -> Agents.",
      });
      return false;
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

/**
 * docs/125 — start a chat-native review turn. Thin wrapper over
 * `handleSendMessage`: it routes the composed prompt through the exact same
 * agent code path, but passes `reviewFilePath` so the turn authorizes the
 * `submit_review_comments` tool for that file (and only that file). The client
 * has already ensured a draft exists for the file before sending this.
 */
export async function handleSendReviewMessage(ctx: FullCtx, msg: WsSendReviewMessage): Promise<void> {
  await handleSendMessage(
    ctx,
    { type: "send_message", text: msg.text, sessionId: msg.sessionId },
    msg.reviewFilePath,
  );
}

export async function handleSendMessage(
  ctx: FullCtx,
  msg: WsSendMessage,
  reviewFilePath?: string,
): Promise<void> {
  // Check auth before spawning — some CLIs hang if not authenticated.
  if (!ensureActiveAgentAuthenticated(ctx)) return;

  // Validate images if provided (do this before queue check so we reject bad images immediately)
  const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
  if (images) {
    const imageError = validateImages(images);
    if (imageError) {
      ctx.send({ type: "error", message: imageError });
      return;
    }
  }

  // If Claude is already processing, queue this message and return.
  // Resolve runner via registry — survives WS disconnect.
  const runnerForQueue = resolveRunner(ctx);
  if (runnerForQueue?.running) {
    // Verify with the worker that an agent is actually running. The local
    // `running` flag can get stranded `true` if the orchestrator missed a
    // terminal SSE event (drop mid-turn, container restart, /agent/kill
    // race). Without this check, the new message would be queued forever
    // and the user sees: "agent starts briefly, nothing happens".
    const actuallyRunning = await runnerForQueue.verifyRunningState();
    if (actuallyRunning) {
      // Live steering: inject the message mid-turn if capability + setting active.
      // Review messages (reviewFilePath set) are never steered — a review needs
      // its own turn so the per-turn review-tool allow-list is established
      // (docs/125). They fall through to the queue, which carries reviewFilePath
      // and applies the allow-list at dequeue/turn-start.
      //
      // docs/140 — also require `runner.isStreamingActive`. `supportsSteering` is
      // a static fact about the adapter (Claude can stream), but the currently-
      // resident process may not actually be a `StreamingClaudeProcess` (e.g.
      // the agent spawned while the toggle was off and the user flipped it on
      // mid-turn — see plan §"Post-stabilization cleanup"). Without this gate
      // we'd call `sendUserMessage` on a one-shot PTY `ClaudeProcess` whose
      // adapter silently no-ops, and the steer would vanish.
      const agentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
      const steeringCapable = agentInfo?.capabilities.supportsSteering ?? false;
      const liveSteering = ctx.credentialStore.getLiveSteering();
      const streamingActive = runnerForQueue.isStreamingActive;
      // docs/146 — suppress live steering when a system-driven turn is in
      // flight (auto-resolve rebase-resolution turn, etc.). Steering an
      // unrelated user message into the conflict-resolution prompt would
      // derail the agent; the message lands in the queue instead and drains
      // when the system turn finishes (the rebase-driver's drain hook).
      const systemTurnInProgress = runnerForQueue.systemTurnInProgress;

      // docs/163 — single shared steer-or-queue predicate. The dispatch path
      // (`runner.dispatch` → `trySteerDispatch`) consults the identical
      // `shouldSteerMessage` so the WS and programmatic paths can't diverge.
      if (shouldSteerMessage({
        steeringCapable,
        liveSteering,
        streamingActive,
        isReviewTurn: reviewFilePath !== undefined,
        systemTurnInProgress,
      })) {
        // Steer the running agent — inject message mid-turn
        const steeringAgent = runnerForQueue.getAgent();
        // docs/140 diag — pin the gate state at the moment of steer dispatch.
        // If a future repro shows "message appears in chat, agent doesn't
        // react", check this log: streamingActive=false means the gate
        // upstream (this.gate or agentInfo) was lying; agent=null means we
        // tried to steer with no resident process; both fall through to the
        // queue branch below today.
        console.log(
          `[steer-send] runner=${runnerForQueue.sessionId} steeringCapable=${steeringCapable} liveSteering=${liveSteering} streamingActive=${streamingActive} agent=${steeringAgent ? "yes" : "null"} text=${JSON.stringify(msg.text.slice(0, 80))}`,
        );
        if (steeringAgent) {
          const capturedSessionId = ctx.getActiveAppSessionId();

          // Resolve uploads + files now so the steered message can carry the
          // same attachment context a fresh turn would. Without this, attached
          // images never reach the agent (only `msg.text` would be injected)
          // and never reach chat history (the steered bubble would reload as
          // text-only after a session switch).
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

          // Same prompt assembly as runAgentWithMessage: save images to
          // /uploads/, reference them as a text block, then prepend file +
          // image context to the user text (or append for slash invocations).
          // The model reads each `/uploads/...` path with its Read tool.
          const fileContext = steerFiles.length > 0 ? formatFileContext(steerFiles) : "";
          const imageContext = steerImages && steerImages.length > 0
            ? saveImagesToUploadsDir(steerImages, steerDir)
            : "";
          const steerPrompt = assembleAgentPrompt({
            userText: msg.text,
            fileContext,
            imageContext,
          });
          steeringAgent.sendUserMessage(steerPrompt);

          // Shapes match PersistedMessage so the same payload feeds chat
          // history persistence and the message_steered broadcast.
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

          // Persist the steered message to chat history. Anchor it after the
          // assistant groups that exist *now* and fold it into the in-progress
          // set, so on reload it stays at the spot the user sent it instead of
          // collapsing up next to the turn's first user message (docs/140).
          if (capturedSessionId) {
            recordSteeredMessage(runnerForQueue, msg.text, {
              images: historyImages,
              files: historyFiles,
              uploadPaths: steerUploadPaths,
            });
            persistTurnInProgress(ctx.chatHistoryManager, runnerForQueue, capturedSessionId);
          }
          // Broadcast message_steered so all viewers (including other tabs) see it
          if (capturedSessionId) {
            runnerForQueue.emitMessage({
              type: "message_steered",
              text: msg.text,
              sessionId: capturedSessionId,
              images: historyImages,
              files: historyFiles,
              uploadPaths: steerUploadPaths,
            });
          }
          return;
        }
      }

      // Not steering (or no active agent ref): delegate to runner.dispatch
      // (docs/150). The runner owns the send-or-queue rule; here we're in
      // the "running" branch so dispatch will enqueue and broadcast
      // message_queued via runner.emitMessage (every attached viewer sees
      // it, not just this socket).
      runnerForQueue.dispatch({
        text: msg.text,
        ...(msg.images !== undefined ? { images: msg.images } : {}),
        ...(msg.files !== undefined ? { files: msg.files } : {}),
        ...(msg.uploads !== undefined ? { uploads: msg.uploads } : {}),
        ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
        ...(reviewFilePath !== undefined ? { reviewFilePath } : {}),
      });
      return;
    }
    // Worker reports no agent — verifyRunningState already reset the flag
    // and emitted a recovery `session_status`. Fall through to start a new
    // turn for this message.
  }

  // Kill any stale process (safety net — normally null if not running).
  //
  // docs/140 — EXCEPT for persistent streaming agents (live steering): the
  // runner intentionally keeps its agent reference across turns so the next
  // top-level turn can carry its message in via `sendUserMessage` (the
  // `existingAgent` reuse branch in `runAgentWithMessage`). Killing it here
  // would tear down the process the next turn is about to talk to and force
  // the new send back through the 409 → `/agent/kill` → SIGTERM recovery
  // path. Crash / error / auth paths in `agent-listeners.ts` still clear
  // the ref, so a genuinely stale ref here can only appear when streaming
  // is off.
  const staleAgent = runnerForQueue?.getAgent() ?? null;
  if (staleAgent) {
    const staleAgentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
    // docs/140 — also require `runner.isStreamingActive` so we don't preserve a
    // resident non-streaming agent under a steering-capable adapter (which would
    // strand a one-shot PTY process the next turn can't talk to via NDJSON).
    const persistentStreaming = (staleAgentInfo?.capabilities.supportsSteering ?? false)
      && ctx.credentialStore.getLiveSteering()
      && (runnerForQueue?.isStreamingActive ?? false);
    if (!persistentStreaming) {
      staleAgent.kill();
    }
  }

  // Validate and read file attachments from disk if provided
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

  // Resolve upload refs if provided — image uploads become ImageAttachments
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
      // Don't delete originals: the resolved ImageAttachments carry
      // `existingPath`, so saveImagesToUploadsDir references them in place
      // instead of re-saving under randomized names. Keeping the on-disk
      // path stable is what lets `hydrateUploads` recognize the upload as
      // already sent (matched against `uploadPaths` in chat history) — see
      // claude-execution.ts:saveImagesToUploadsDir for full context.
    }
  }

  const userText = msg.text;

  // Determine session context: resume existing or create new.
  // Per-session WS sets activeAppSessionId from the URL, so default to it
  // when the message doesn't include an explicit sessionId.
  const effectiveSessionId = msg.sessionId ?? ctx.getActiveAppSessionId();
  let agentSessionId: string | undefined;
  if (effectiveSessionId) {
    // Resuming an existing session
    // Clear the queue when switching to a different session.
    // Look up the OUTGOING session's runner so its queue isn't stranded.
    const previousSessionId = ctx.getActiveAppSessionId();
    if (previousSessionId && effectiveSessionId !== previousSessionId) {
      const previousRunner = ctx.getRunnerRegistry().get(previousSessionId);
      if (previousRunner && previousRunner.messageQueue.length > 0) {
        previousRunner.clearQueue();
        ctx.send({ type: "queue_updated", queue: [] });
      }
    }
    await ctx.activateSession(effectiveSessionId);
    const session = ctx.sessionManager.get(effectiveSessionId);
    // Only resume if we have a real Claude CLI session ID
    agentSessionId = session?.agentSessionId;

    // Graduate warm session on first message.
    // graduate-session.ts owns the warm → active transition (docs/156). Do
    // not inline setWarm / track / setBranchRenamed / scheduleSessionNaming /
    // repoStore.touch / sseBroadcast("session_list") here.
    if (session?.warm) {
      graduateSession(
        {
          sessionManager: ctx.sessionManager,
          runnerRegistry: ctx.getRunnerRegistry(),
          repoStore: ctx.repoStore,
          createGitManager: ctx.createGitManager,
          prStatusPoller: ctx.prStatusPoller,
          sseBroadcast: ctx.sseBroadcast,
        },
        {
          sessionId: effectiveSessionId,
          userText,
          agentId: session.agentId ?? ctx.getActiveAgentId(),
        },
      );

      // Warm-graduation is the only surface that doesn't reach graduation via
      // `claimSessionService.claim`, so the warm pool's single warm clone was
      // just consumed but no one re-warmed it. Refill inline. The other three
      // surfaces inherit re-warming from `claim-session.ts:rewarmPool`.
      if (session.remoteUrl) {
        void ctx.warmSessionForRepo(session.remoteUrl);
      }
    }

    // If session has a workspaceDir but it was deleted, the worktree
    // linkage (branch, shared repo) must be intact — can't recreate.
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
    // No session — messages must be sent to an existing session
    ctx.send({
      type: "error",
      message: "No active session. Please create a session first.",
    });
    return;
  }

  // Ensure a runner exists for this session and attach to it
  const activeId = ctx.getActiveAppSessionId();
  const activeDir = ctx.getActiveSessionDir();
  if (activeId && activeDir) {
    const registry = ctx.getRunnerRegistry();
    const runner = registry.getOrCreate(activeId, activeDir, ctx.getActiveAgentId());
    ctx.attachToRunner(runner);
  }

  // Collect all upload paths for chat history (so hydrateUploads can detect sent uploads)
  const uploadPaths = uploadRefs?.map((u) => u.path);

  // Mark the runner as running. Resolve via registry so this stays correct
  // even if the WS disconnects between handler entry and `await` resumption.
  const turnRunner = resolveRunner(ctx);
  if (turnRunner) turnRunner.running = true;
  await runAgentWithMessage(ctx, {
    userText,
    images: allImages,
    validatedFiles,
    agentSessionId,
    permissionMode: msg.permissionMode,
    isNewSession: !msg.sessionId,
    uploadPaths,
    reviewFilePath,
  });
}

export async function handleAnswerQuestion(ctx: FullCtx, msg: WsAnswerQuestion): Promise<void> {
  // Prefer the client-formatted text (unambiguous when answers contain
  // commas) and fall back to joining the answers map for older clients
  // that predate the `text` field.
  const answerText = msg.text?.trim()
    ? msg.text
    : Object.values(msg.answers).join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  // An AskUserQuestion answer is, by construction, the *next turn* of a session
  // whose previous turn already ended: the agent emitted the tool_use, the
  // orchestrator interrupted it (`agent.interrupt()` in agent-listeners.ts),
  // and the resulting `agent_result` flipped `running=false`. So the answer is
  // handled exactly like a normal user message — delegate to
  // `runAgentWithMessage`, which owns the canonical turn machinery:
  // `resetRunnerTurnState`, `existingAgent.removeAllListeners()` before
  // re-wiring, and a fresh `streamingPostTurnFired` closure.
  //
  // The previous implementation hand-rolled a steering branch that called
  // `existingAgent.sendUserMessage(answerText)` directly, bypassing all of
  // that. Because the interrupted turn's listeners stayed attached, the
  // answered turn's `agent_result` hit the *previous* turn's
  // `streamingPostTurnFired` guard (already `true`) and short-circuited —
  // skipping the queue drain, auto-commit, PR card, and
  // `session_agent_finished`. Symptom: "the answer pastes into chat but the
  // agent never starts." Routing through `runAgentWithMessage` makes the reset
  // + re-wire unconditional, which is the fix.
  const runnerEarly = resolveRunner(ctx);

  // Kill any stale resident agent before the new turn — EXCEPT a persistent
  // streaming agent we can reuse. Mirrors `handleSendMessage`'s stale-kill
  // (docs/140): a steering-capable adapter with `liveSteering` on and a still-
  // streaming process is the one case `runAgentWithMessage` carries the answer
  // in via `sendUserMessage` rather than respawning. `!systemTurnInProgress`
  // preserves the old "don't steer into a system-driven turn" guard (docs/146).
  // Every other resident ref (liveSteering off, a stranded non-streaming
  // process under a steering adapter) must be killed so the delegated turn
  // spawns a fresh `--resume` agent instead of writing to a process that can't
  // receive the message.
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
        // The AskUserQuestion interrupt already cleared `running`; reset
        // defensively so the duplicate guard below doesn't strand the answer
        // if a race left it true.
        runnerEarly.running = false;
      }
    }
  }

  // Defensive duplicate guard: a still-running runner here means a parallel
  // answer / turn is already in flight (UI double-click, two tabs, or a
  // genuinely-not-interrupted turn). The worker would reject the duplicate
  // /agent/start with 409 anyway, but dropping early avoids a misleading
  // setup flow. After the stale-kill above this only stays true for a reused
  // persistent-streaming agent whose turn really is still active.
  if (runnerEarly?.running) {
    console.warn(
      `[answer_question] Runner ${runnerEarly.sessionId} already running — dropping duplicate answer (text="${answerText.slice(0, 60)}")`,
    );
    return;
  }

  if (!ensureActiveAgentAuthenticated(ctx)) return;

  // Ensure a runner exists for this session and attach to it.
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

  // `runAgentWithMessage` does not flip `running` or emit `session_status` —
  // its WS callers do (see handleSendMessage). Mark running + announce BEFORE
  // delegating so the chat panel shows "Thinking..." and a reconnecting viewer
  // replays the running state (index.ts gates the replay on `runner.running`).
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
    isNewSession: false,
  });
}
