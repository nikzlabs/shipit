import fs from "node:fs/promises";
import type { WsClientMessage, WsServerMessage, ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, validateImages, resolveFileAttachments, resolveUploadRefs } from "../validation.js";
import { generateSessionName } from "../session-namer.js";
import { wireAgentListeners } from "./agent-listeners.js";
import { runAgentWithMessage, drainNextQueuedMessage } from "./agent-execution.js";
import { postTurnCommit } from "./post-turn.js";
import { resolveRunner } from "./resolve-runner.js";

// Re-export all public symbols from sub-modules for backwards compatibility
export { CONTEXT_WINDOW_TOKENS, wireAgentListeners, extractToolResults } from "./agent-listeners.js";
export { runAgentWithMessage } from "./agent-execution.js";
export { postTurnCommit } from "./post-turn.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

export async function handleSendMessage(ctx: FullCtx, msg: WsSendMessage): Promise<void> {
  // Check auth before spawning — the CLI hangs if not authenticated
  if (!ctx.authManager.authenticated) {
    ctx.authManager.checkCredentials();
  }
  if (!ctx.authManager.authenticated) {
    ctx.send({ type: "auth_required" });
    ctx.authManager.startOAuthFlow();
    return;
  }

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
      runnerForQueue.messageQueue.push({ text: msg.text, images: msg.images, files: msg.files, uploads: msg.uploads, permissionMode: msg.permissionMode });
      ctx.send({
        type: "message_queued",
        position: runnerForQueue.messageQueue.length,
        text: msg.text,
      });
      return;
    }
    // Worker reports no agent — verifyRunningState already reset the flag
    // and emitted a recovery `session_status`. Fall through to start a new
    // turn for this message.
  }

  // Kill any stale process (safety net — normally null if not running)
  const staleAgent = runnerForQueue?.getAgent() ?? null;
  if (staleAgent) {
    staleAgent.kill();
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

    // Graduate warm session on first message
    if (session?.warm) {
      ctx.sessionManager.setWarm(effectiveSessionId, false);
      ctx.sessionManager.track(effectiveSessionId);

      // Set a placeholder title immediately (replaced async by AI-generated name below)
      ctx.sessionManager.rename(effectiveSessionId, userText.slice(0, 60) || "New session");

      // Generate session name from the message text. Uses the local Claude Code
      // CLI's OAuth credentials — always available, so no opt-in required. If the
      // CLI call fails we silently fall through (see finalizeBranchRenamed below).
      if (session.workspaceDir) {
        // Helper: mark branch as renamed and emit PR "ready" card
        const finalizeBranchRenamed = async () => {
          ctx.sessionManager.setBranchRenamed(effectiveSessionId, true);
          const s = ctx.sessionManager.get(effectiveSessionId);
          if (!s?.remoteUrl || !s.workspaceDir) return;
          if (ctx.prStatusPoller.getStatus(effectiveSessionId)) return; // PR already exists
          if (s.mergedAt) return; // PR was already merged
          try {
            const git = ctx.createGitManager(s.workspaceDir);
            const headBranch = s.branch || await git.getCurrentBranch();
            const { insertions, deletions } = await git.diffStatVsBranch("main");
            ctx.send({
              type: "pr_lifecycle_update",
              sessionId: effectiveSessionId,
              cardId: `pr-card-${effectiveSessionId}`,
              phase: "ready",
              headBranch,
              totalInsertions: insertions,
              totalDeletions: deletions,
            });
          } catch {
            // Diff stats may fail if no commits yet — that's fine, post-commit will retry
          }
        };

        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget session naming
        generateSessionName(userText).then(async (nameResult) => {
          if (!nameResult) {
            await finalizeBranchRenamed();
            return;
          }
          try {
            const currentBranch = session.branch;
            if (currentBranch) {
              // Extract the random slug from the prefix (e.g. "shipit/abc123" → "abc123")
              // and rebuild as shipit/<descriptive-name>-<random-slug>
              const randomSlug = currentBranch.replace(/^shipit\//, "");
              const newBranchName = `shipit/${nameResult.slug}-${randomSlug}`;
              const sessionGit = ctx.createGitManager(session.workspaceDir!);
              await sessionGit.renameBranch(currentBranch, newBranchName);
              ctx.sessionManager.setBranch(effectiveSessionId, newBranchName);
            }
            ctx.sessionManager.rename(effectiveSessionId, nameResult.title);
            const updatedSession = ctx.sessionManager.get(effectiveSessionId);
            if (updatedSession) {
              ctx.send({ type: "session_renamed", session: updatedSession });
              ctx.sseBroadcast("session_renamed", { session: updatedSession });
            }
            await finalizeBranchRenamed();
          } catch (err) {
            console.warn("[warm] Branch rename failed:", getErrorMessage(err));
            await finalizeBranchRenamed();
          }
        }).catch(async (err: unknown) => {
          console.warn("[warm] Session naming failed:", err);
          await finalizeBranchRenamed();
        });
      } else {
        // No workspace directory yet (shouldn't normally happen for a graduating
        // warm session) — unblock PR card immediately so the UI doesn't hang.
        ctx.sessionManager.setBranchRenamed(effectiveSessionId, true);
      }

      // Broadcast session list via SSE so sidebar updates with the graduated session
      ctx.sseBroadcast("session_list", { sessions: ctx.sessionManager.list() });

      // Mark repo as used now that actual coding is starting
      if (session.remoteUrl) {
        ctx.repoStore.touch(session.remoteUrl);
      }

      // Start warming the next session for this repo in the background.
      // Intentionally not awaited — warming is independent of the user's message.
      if (session.remoteUrl) {
        void ctx.warmSessionForRepo(session.remoteUrl, { withStandby: true });
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
  });
}

export async function handleAnswerQuestion(ctx: FullCtx, msg: WsAnswerQuestion): Promise<void> {
  const answerParts = Object.values(msg.answers);
  const answerText = answerParts.join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  // Resolve the runner from the registry first so it survives WS disconnect.
  const runnerEarly = resolveRunner(ctx);
  const existingAgent = runnerEarly?.getAgent() ?? null;
  if (existingAgent) {
    // Claude is still running — write answer to stdin (it may be blocking on input)
    existingAgent.writeStdin(`${answerText  }\n`);
    return;
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

  // Agent has finished — send the answer as a new prompt with --resume
  if (!ctx.authManager.authenticated) {
    ctx.authManager.checkCredentials();
  }
  if (!ctx.authManager.authenticated) {
    ctx.send({ type: "auth_required" });
    ctx.authManager.startOAuthFlow();
    return;
  }

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

  // Resolve runner via the registry so it survives WS disconnect.
  const answerRunner = resolveRunner(ctx, capturedSessionId);

  // Reset turn-scoped state directly on the runner.
  if (answerRunner) {
    answerRunner.turnSummary = "";
    answerRunner.accumulatedText = "";
    answerRunner.accumulatedToolUse = [];
    answerRunner.chatMessageGroups = [];
    answerRunner.needsNewMessageGroup = true;
  }
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  if (answerRunner) answerRunner.setAgent(currentAgent);

  const persistUserMessage = (sessionId: string) => {
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

  wireAgentListeners(ctx, currentAgent, {
    isNewSession: false,
    persistUserMessage,
    fallbackTitle: answerText.slice(0, 80) || "Answer",
    capturedSessionId,
    onError: () => drainNextQueuedMessage(ctx, answerRunner, capturedSessionId, capturedSessionDir, emitDone),
  });
  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    if (answerRunner) answerRunner.setAgent(null);

    try {
      if (capturedSessionDir) {
        await postTurnCommit(ctx, {
          sessionDir: capturedSessionDir,
          sessionId: capturedSessionId,
          emit: emitDone,
          // Pass the captured runner's summary explicitly — ctx.getTurnSummary()
          // returns "" after WS disconnect (it routes through attachedRunner).
          turnSummary: answerRunner?.turnSummary ?? "",
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
