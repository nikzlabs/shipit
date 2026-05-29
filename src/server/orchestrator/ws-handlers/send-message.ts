import fs from "node:fs/promises";
import type { WsClientMessage, WsServerMessage, ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, validateImages, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { graduateSession } from "../services/graduate-session.js";
import { wireAgentListeners, recordSteeredMessage, persistTurnInProgress, type AgentListenerDeps } from "./agent-listeners.js";
import { runAgentWithMessage, drainNextQueuedMessage, saveImagesToUploadsDir, assembleAgentPrompt } from "./agent-execution.js";
import { postTurnCommit } from "./post-turn.js";
import { resolveRunner } from "./resolve-runner.js";

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

      if (steeringCapable && liveSteering && streamingActive && !reviewFilePath) {
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

  // Resolve the runner from the registry first so it survives WS disconnect.
  const runnerEarly = resolveRunner(ctx);
  const existingAgent = runnerEarly?.getAgent() ?? null;
  const agentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
  const steeringCapable = agentInfo?.capabilities.supportsSteering ?? false;
  const liveSteering = ctx.credentialStore.getLiveSteering();
  // docs/140 — the CLI process must actually be in streaming mode for
  // `sendUserMessage` to land; otherwise the adapter silently no-ops and the
  // answer disappears.
  const streamingActive = runnerEarly?.isStreamingActive ?? false;

  // docs/140 diag — same shape as `[steer-send]` in handleSendMessage. If a
  // future repro shows "answer appears in chat, agent doesn't react", this
  // log pins the gate state and the recovery path the handler took.
  console.log(
    `[answer-question] runner=${runnerEarly?.sessionId} steeringCapable=${steeringCapable} liveSteering=${liveSteering} streamingActive=${streamingActive} existingAgent=${existingAgent ? "yes" : "null"} text=${JSON.stringify(answerText.slice(0, 80))}`,
  );

  if (existingAgent) {
    // docs/140 — live steering: when the persistent streaming agent is blocked
    // on AskUserQuestion, route the answer through `sendUserMessage` so the
    // CLI receives a properly framed NDJSON user message on its piped stdin.
    if (steeringCapable && liveSteering && streamingActive) {
      const answerSessionId = ctx.getActiveAppSessionId();
      existingAgent.sendUserMessage(answerText);
      if (answerSessionId && runnerEarly) {
        // Same ordering fix as live steering: the answer is a mid-turn user
        // message, so anchor + fold it into the in-progress set rather than
        // appending it out-of-band (docs/140).
        recordSteeredMessage(runnerEarly, answerText);
        persistTurnInProgress(ctx.chatHistoryManager, runnerEarly, answerSessionId);
        runnerEarly.emitMessage({
          type: "message_steered",
          text: answerText,
          sessionId: answerSessionId,
        });
        // The AskUserQuestion-interrupt in `agent-listeners.ts` ended the
        // previous turn (agent_result → `running=false`). Re-arm the runner so
        // the UI shows "thinking" while the streaming process processes this
        // answer as the next turn.
        runnerEarly.running = true;
        runnerEarly.emitMessage({
          type: "session_status",
          sessionId: answerSessionId,
          running: true,
          queueLength: runnerEarly.queueLength,
        });
      }
      return;
    }

    // The steering gate failed but an agent ref is still resident. Two cases:
    //
    //   (A) `steeringCapable` adapter (claude / codex) — the resident process
    //       is either a streaming process whose `isStreamingActive` flag was
    //       cleared (stranded; `writeStdin` would land as raw bytes on a
    //       process that expects NDJSON and get silently dropped) OR the user
    //       flipped `liveSteering` off mid-turn (the streamer is still alive
    //       but the user opted out of steering). Either way the safe recovery
    //       is to kill the stale ref and fall through to the fresh-spawn
    //       `--resume` path below — same shape as `handleSendMessage`'s
    //       stale-kill at line 263.
    //
    //       Without this branch the previous code wrote raw text to stdin and
    //       returned without flipping `runner.running` back to true or
    //       emitting `session_status`. The optimistic answer bubble rendered
    //       on the client and the agent never reacted — the exact symptom of
    //       the steering "appears to work, doesn't react" bug closed by
    //       ee313d3661, but on the answer path.
    //
    //   (B) `!steeringCapable` adapter — hypothetical PTY-only agent that
    //       genuinely reads raw stdin during a turn. `writeStdin` is the
    //       correct delivery and we must also re-arm `running=true` plus
    //       `session_status` because the AskUserQuestion interrupt cleared it.
    //       No agent in the registry is currently `!steeringCapable`, so this
    //       branch is dead in production — kept as a forward-compat safety
    //       net for future adapters.
    if (steeringCapable) {
      existingAgent.kill();
      if (runnerEarly?.getAgent() === existingAgent) {
        runnerEarly.setAgent(null);
        runnerEarly.isStreamingActive = false;
        // The AskUserQuestion-interrupt already cleared `running` on
        // agent_result; reset defensively so the duplicate-drop check below
        // doesn't strand this answer if a race left it true.
        runnerEarly.running = false;
      }
      // Fall through to the fresh-spawn `--resume` path.
    } else {
      existingAgent.writeStdin(`${answerText}\n`);
      if (runnerEarly) {
        runnerEarly.running = true;
        const sid = ctx.getActiveAppSessionId();
        if (sid) {
          ctx.sseBroadcast("session_agent_started", { sessionId: sid });
          runnerEarly.emitMessage({
            type: "session_status",
            sessionId: sid,
            running: true,
            queueLength: runnerEarly.queueLength,
          });
        }
      }
      return;
    }
  }

  // Defensive guard: if the runner is already marked as running but
  // `getAgent()` returned null, an agent-start is already in flight on
  // this session — either from a parallel `answer_question` (UI
  // double-click, two browser tabs) or from a system-turn that hasn't
  // yet reached `setAgent`. The worker rejects duplicate /agent/start
  // with 409, so the parallel start would fail anyway, but without
  // this guard the orchestrator still goes through the full setup and
  // emits a misleading flow of "Agent process started" log entries
  // (now mitigated by moving that log to the agent_init handler).
  // Match the handleSendMessage pattern: drop the duplicate when the
  // worker confirms a turn is in flight. Note: there's no
  // verifyRunningState() short-circuit here because the most common
  // case is a genuine duplicate, not a stranded `running=true` flag.
  if (runnerEarly?.running) {
    console.warn(
      `[answer_question] Runner ${runnerEarly.sessionId} already running — dropping duplicate answer (text="${answerText.slice(0, 60)}")`,
    );
    return;
  }

  // Agent has finished — send the answer as a new prompt with --resume.
  if (!ensureActiveAgentAuthenticated(ctx)) return;

  // Ensure a runner exists for this session and attach to it
  {
    const answerActiveId = ctx.getActiveAppSessionId();
    const answerActiveDir = ctx.getActiveSessionDir();
    if (answerActiveId && answerActiveDir && !ctx.getRunner()) {
      const registry = ctx.getRunnerRegistry();
      const answerRunner = registry.getOrCreate(answerActiveId, answerActiveDir, ctx.getActiveAgentId());
      ctx.attachToRunner(answerRunner);
    }
  }

  // Capture session context at turn start — immune to session switches
  const capturedSessionId = ctx.getActiveAppSessionId();
  const capturedSessionDir = ctx.getActiveSessionDir();
  const turnStartHeadHash = capturedSessionDir
    ? await ctx.createGitManager(capturedSessionDir).getHeadHash()
    : null;

  // Resolve runner via the registry so it survives WS disconnect.
  const answerRunner = resolveRunner(ctx, capturedSessionId);

  // Reset turn-scoped state directly on the runner.
  if (answerRunner) {
    answerRunner.turnSummary = "";
    answerRunner.accumulatedText = "";
    answerRunner.accumulatedToolUse = [];
    answerRunner.chatMessageGroups = [];
    answerRunner.needsNewMessageGroup = true;
    answerRunner.steeredMessages = [];
  }
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  if (answerRunner) answerRunner.setAgent(currentAgent);

  const persistUserMessage = (sessionId: string) => {
    // docs/140 diag — see comment in agent-execution.ts persistUserMessage.
    console.log(
      `[persist-user] handleAnswerQuestion session=${sessionId} text=${JSON.stringify(answerText.slice(0, 60))}`,
    );
    ctx.chatHistoryManager.append(sessionId, { role: "user", text: answerText });
  };

  // Persist the user answer immediately if we have a session
  if (capturedSessionId) {
    persistUserMessage(capturedSessionId);
  }

  // Shared emit helper — also used by onError below.
  const emitDone = (msg: WsServerMessage) => {
    if (answerRunner) answerRunner.emitMessage(msg);
    else ctx.send(msg);
  };

  const answerListenerDeps: AgentListenerDeps = {
    sessionManager: ctx.sessionManager,
    chatHistoryManager: ctx.chatHistoryManager,
    usageManager: ctx.usageManager,
    authManager: ctx.authManager,
    authManagers: ctx.authManagers,
    sseBroadcast: ctx.sseBroadcast,
    broadcastLog: ctx.broadcastLog,
    getSelectedModel: ctx.getSelectedModel,
    recordAgentRateLimits: ctx.recordAgentRateLimits,
    getSubscriptionLimitsSnapshot: ctx.getSubscriptionLimitsSnapshot,
    nudgeClaudeOAuthRefresh: ctx.nudgeClaudeOAuthRefresh,
    onAgentAuthRequired: ctx.onAgentAuthRequired,
  };
  wireAgentListeners(currentAgent, answerRunner, answerListenerDeps, {
    isNewSession: false,
    persistUserMessage,
    fallbackTitle: answerText.slice(0, 80) || "Answer",
    capturedSessionId,
    onError: () => drainNextQueuedMessage(ctx, answerRunner, capturedSessionId, capturedSessionDir, emitDone),
  });
  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    // Identity-guard: a concurrent turn (typically a system-dispatched turn
    // racing with this answer_question) may have replaced the runner's
    // agent ref already; only clear if it's still our process.
    if (answerRunner?.getAgent() === currentAgent) answerRunner.setAgent(null);

    try {
      if (capturedSessionDir) {
        await postTurnCommit(ctx, {
          sessionDir: capturedSessionDir,
          sessionId: capturedSessionId,
          emit: emitDone,
          // Pass the captured runner's summary explicitly — ctx.getTurnSummary()
          // returns "" after WS disconnect (it routes through attachedRunner).
          turnSummary: answerRunner?.turnSummary ?? "",
          turnStartHeadHash,
        });
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    // Mirror the cleanup that runAgentWithMessage's done handler performs.
    // `agent-listeners.ts` already flips `running` to false and emits
    // `session_status { running: false }` on agent_result, but the SSE
    // `session_agent_finished` broadcast is owned by the handler, not the
    // listeners. Without this, sidebars on other tabs would keep showing
    // the "agent running" dot until they reconnect. Defensive `running=false`
    // covers the no-result-event crash path the same way it does in
    // agent-execution.ts.
    if (answerRunner) {
      answerRunner.running = false;
      if (capturedSessionId) {
        ctx.sseBroadcast("session_agent_finished", { sessionId: capturedSessionId });
      }
      answerRunner.onAgentFinished();
    }
  });

  // Look up agent session ID for --resume
  const session = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  const agentSessionId = session?.agentSessionId ?? capturedSessionId;

  // Mark the runner as running BEFORE starting the agent — same pattern as
  // handleSendMessage/runAgentWithMessage. Without this:
  //   - the SSE `session_agent_started` event is never broadcast, so the
  //     sidebar keeps the "Waiting for your input" attention indicator and
  //     the active-runner dot doesn't appear;
  //   - if the WS reconnects mid-turn, the reattach path in index.ts skips
  //     the `session_status` replay (gated on `runner.running`), so the
  //     reattached viewer's "Thinking..." indicator stays cleared even
  //     though the agent is actively running.
  if (answerRunner) answerRunner.running = true;
  if (capturedSessionId) {
    ctx.sseBroadcast("session_agent_started", { sessionId: capturedSessionId });
  }
  // Emit session_status to all attached viewers so the chat panel's
  // "Thinking..." indicator and sidebar's active-runner dot show up even
  // without optimistic client-side state (e.g., a second tab that didn't
  // initiate the answer).
  if (answerRunner && capturedSessionId) {
    answerRunner.emitMessage({
      type: "session_status",
      sessionId: capturedSessionId,
      running: true,
      queueLength: answerRunner.queueLength,
    });
  }

  const systemPrompt = await ctx.readSystemPrompt();
  currentAgent.run({
    prompt: answerText,
    sessionId: agentSessionId,
    systemPrompt,
    cwd: capturedSessionDir ?? ctx.workspaceDir,
  });
  // "Agent process started" is emitted from agent-listeners.ts on
  // agent_init — see the matching comment in agent-execution.ts.
}
