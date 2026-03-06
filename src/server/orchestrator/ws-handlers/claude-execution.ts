import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { AgentEvent } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, formatFileContext } from "../validation.js";
import { wireAgentListeners } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/**
 * Core Claude execution logic. Shared between send_message and
 * home_send_with_repo handlers. Session state (activeAppSessionId,
 * activeSessionDir) must already be set before calling this.
 */
export async function runClaudeWithMessage(ctx: FullCtx, opts: {
  userText: string;
  images?: ImageAttachment[];
  validatedFiles: FileAttachment[];
  agentSessionId?: string;
  permissionMode?: PermissionMode;
  isNewSession: boolean;
}): Promise<void> {
  const { userText, images, validatedFiles, permissionMode, isNewSession } = opts;
  let { agentSessionId } = opts;

  const runner = ctx.getRunner();
  // Clear the turn event buffer for the new turn
  if (runner) runner.clearTurnEventBuffer();

  // Capture the session context at turn start. These values must NOT be read
  // from ctx later because the user may switch sessions while the agent runs,
  // which would change ctx.getActiveAppSessionId() / ctx.getActiveSessionDir().
  const capturedSessionId = ctx.getActiveAppSessionId();
  const capturedSessionDir = ctx.getActiveSessionDir();

  ctx.setTurnSummary("");
  ctx.setAccumulatedText("");
  ctx.setAccumulatedToolUse([]);
  ctx.setChatMessageGroups([]);
  ctx.setNeedsNewMessageGroup(true);
  let receivedResult = false;
  ctx.setWasInterrupted(false);
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  ctx.setAgent(currentAgent);

  // Notify via SSE for sidebar activity dots
  if (capturedSessionId) {
    ctx.sseBroadcast("session_agent_started", { sessionId: capturedSessionId });
  }

  // Build images metadata for chat history persistence (inline base64)
  const historyImages = images?.map((img) => ({
    data: img.data,
    mediaType: img.mediaType,
  }));

  // Build file metadata for chat history persistence (path + preview only)
  const historyFiles = validatedFiles.length > 0
    ? validatedFiles.map((f) => ({
        path: f.path,
        contentPreview: f.content.slice(0, 200),
        startLine: f.startLine,
        endLine: f.endLine,
      }))
    : undefined;

  const persistUserMessage = (sessionId: string) => {
    ctx.chatHistoryManager.append(sessionId, {
      role: "user",
      text: userText,
      images: historyImages,
      files: historyFiles,
    });
  };

  wireAgentListeners(ctx, currentAgent, {
    isNewSession,
    persistUserMessage,
    fallbackTitle: userText.slice(0, 80) || "New session",
    capturedSessionId,
  });

  // Track whether we got a result event
  currentAgent.on("event", (event: AgentEvent) => {
    if (event.type === "agent_result") {
      receivedResult = true;
    }
  });

  // For resumed sessions (sessionId already known), persist user message immediately
  if (!isNewSession && capturedSessionId) {
    persistUserMessage(capturedSessionId);
  }

  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitDone = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    if (runner) runner.setAgent(null);

    // If the process exited without producing a result event, notify the
    // client so it can clear the loading state instead of hanging forever.
    if (!receivedResult && !(runner?.wasInterrupted ?? false)) {
      const reason = code !== 0
        ? `Agent process exited with code ${code}`
        : "Agent process ended without a response";
      emitDone({ type: "error", message: reason });
    }

    // Auto-commit after agent turn using the session dir captured at turn start.
    // Do NOT use ctx.getActiveGitManager() — the user may have switched sessions.
    let commitHash: string | null = null;
    try {
      if (capturedSessionDir) {
        commitHash = await postTurnCommit(ctx, {
          sessionDir: capturedSessionDir,
          sessionId: capturedSessionId,
          emit: emitDone,
        });
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    // Emit PR lifecycle card after commit if the session has a remote
    if (commitHash && capturedSessionId && capturedSessionDir) {
      try {
        const session = ctx.sessionManager.get(capturedSessionId);
        if (session?.remoteUrl && session.branchRenamed !== false) {
          const git = ctx.createGitManager(capturedSessionDir);

          // Check if a PR already exists for this branch
          const prStatus = ctx.prStatusPoller.getStatus(capturedSessionId);
          if (prStatus) {
            // PR already exists — the poller handles updates via SSE
          } else {
            // No PR yet — send a "ready" card with diff stats vs base branch
            const headBranch = session.branch || await git.getCurrentBranch();
            const { insertions: totalInsertions, deletions: totalDeletions } = await git.diffStatVsBranch("main");

            emitDone({
              type: "pr_lifecycle_update",
              sessionId: capturedSessionId,
              cardId: `pr-card-${capturedSessionId}`,
              phase: "ready",
              headBranch,
              totalInsertions,
              totalDeletions,
            });
          }
        }
      } catch (err) {
        console.error("[pr-lifecycle] Failed to compute diff stats:", getErrorMessage(err));
      }
    }

    // Mark Claude as no longer running, then process the next queued message
    // If interrupted, clear the queue instead of dequeuing.
    // Use runner directly (not ctx) so this works even after WS disconnect.
    if (runner) runner.running = false;
    const messageQueue = runner?.messageQueue ?? [];
    if ((runner?.wasInterrupted ?? false) && messageQueue.length > 0) {
      if (runner) runner.clearQueue();
      emitDone({ type: "queue_updated", queue: [] });
    }
    if (!(runner?.wasInterrupted ?? false) && messageQueue.length > 0) {
      const next = messageQueue.shift()!;
      // Notify the client that the queue is now one shorter
      emitDone({
        type: "queue_updated",
        queue: messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
      });
      if (runner) runner.running = true;
      // Resolve file attachments for the queued message
      const nextImages = next.images && next.images.length > 0 ? next.images : undefined;
      const nextFileRefs = next.files && next.files.length > 0 ? next.files : undefined;
      let nextValidatedFiles: FileAttachment[] = [];
      if (nextFileRefs) {
        const dir = capturedSessionDir ?? ctx.workspaceDir;
        const fileResult = await resolveFileAttachments(nextFileRefs, dir);
        if (fileResult.error) {
          emitDone({ type: "error", message: fileResult.error });
          ctx.setIsClaudeRunning(false);
          return;
        }
        nextValidatedFiles = fileResult.files;
      }
      const nextSession = capturedSessionId
        ? ctx.sessionManager.get(capturedSessionId)
        : undefined;
      try {
        await runClaudeWithMessage(ctx, {
          userText: next.text,
          images: nextImages,
          validatedFiles: nextValidatedFiles,
          agentSessionId: nextSession?.agentSessionId,
          permissionMode: next.permissionMode,
          isNewSession: false,
        });
      } catch (err) {
        console.error("[queue] Error processing queued message:", getErrorMessage(err));
        if (runner) runner.running = false;
      }
    }

    // Notify via SSE for sidebar activity dots
    if (capturedSessionId && !(runner?.running ?? false)) {
      ctx.sseBroadcast("session_agent_finished", { sessionId: capturedSessionId });
      if (runner) runner.onAgentFinished();
    }
  });

  // Build the system prompt, incorporating conversation replay (from rollback/fork)
  let systemPrompt = await ctx.readSystemPrompt();
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (activeAppSessionId) {
    const sessionReplay = ctx.sessionManager.consumeConversationReplay(activeAppSessionId);
    if (sessionReplay) {
      agentSessionId = undefined;
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${sessionReplay}`
        : sessionReplay;
    }
  }
  // Prepend file context to the prompt if files are attached
  let prompt = userText;
  if (validatedFiles.length > 0) {
    const context = formatFileContext(validatedFiles);
    prompt = `${context}\n\n${prompt}`;
  }

  currentAgent.run({
    prompt,
    sessionId: agentSessionId,
    systemPrompt,
    images,
    cwd: ctx.getActiveDir(),
    permissionMode,
  });
  ctx.broadcastLog("server", "Agent process started");
}
