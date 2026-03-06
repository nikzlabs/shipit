import fs from "node:fs/promises";
import type { WsClientMessage, ImageAttachment, FileAttachment, FileContextRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, validateImages, resolveFileAttachments } from "../validation.js";
import { generateSessionName } from "../session-namer.js";
import { wireAgentListeners } from "./agent-listeners.js";
import { runClaudeWithMessage } from "./claude-execution.js";
import { postTurnCommit } from "./post-turn.js";

// Re-export all public symbols from sub-modules for backwards compatibility
export { CONTEXT_WINDOW_TOKENS, wireAgentListeners, extractToolResults } from "./agent-listeners.js";
export { runClaudeWithMessage } from "./claude-execution.js";
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

  // If Claude is already processing, queue this message and return
  if (ctx.getIsClaudeRunning()) {
    ctx.getMessageQueue().push({ text: msg.text, images: msg.images, files: msg.files, permissionMode: msg.permissionMode });
    ctx.send({
      type: "message_queued",
      position: ctx.getMessageQueue().length,
      text: msg.text,
    });
    return;
  }

  // Kill any stale process (safety net — normally null if not running)
  const staleAgent = ctx.getAgent();
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

  const userText = msg.text;

  // Determine session context: resume existing or create new.
  // Per-session WS sets activeAppSessionId from the URL, so default to it
  // when the message doesn't include an explicit sessionId.
  const effectiveSessionId = msg.sessionId ?? ctx.getActiveAppSessionId();
  let agentSessionId: string | undefined;
  if (effectiveSessionId) {
    // Resuming an existing session
    // Clear the queue when switching to a different session
    if (ctx.getActiveAppSessionId() && effectiveSessionId !== ctx.getActiveAppSessionId() && ctx.getMessageQueue().length > 0) {
      ctx.clearMessageQueue();
      ctx.send({ type: "queue_updated", queue: [] });
    }
    await ctx.activateSession(effectiveSessionId);
    const session = ctx.sessionManager.get(effectiveSessionId);
    // Only resume if we have a real Claude CLI session ID
    agentSessionId = session?.agentSessionId;

    // Graduate warm session on first message
    if (session?.warm) {
      ctx.sessionManager.setWarm(effectiveSessionId, false);

      // Set a placeholder title immediately (replaced async by AI-generated name below)
      ctx.sessionManager.rename(effectiveSessionId, userText.slice(0, 60) || "New session");

      // Generate session name from the message text
      const utilityModel = ctx.credentialStore.getUtilityModel();
      if (utilityModel && session.workspaceDir) {
        // Helper: mark branch as renamed and emit PR "ready" card
        const finalizeBranchRenamed = async () => {
          ctx.sessionManager.setBranchRenamed(effectiveSessionId, true);
          const s = ctx.sessionManager.get(effectiveSessionId);
          if (!s?.remoteUrl || !s.workspaceDir) return;
          if (ctx.prStatusPoller.getStatus(effectiveSessionId)) return; // PR already exists
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
        generateSessionName(userText, utilityModel).then(async (nameResult) => {
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
              ctx.sessionManager.setWorktreeInfo(effectiveSessionId, {
                branch: newBranchName,
                sessionType: session.sessionType ?? "worktree",
              });
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
        // No utility model configured — unblock PR card immediately
        ctx.sessionManager.setBranchRenamed(effectiveSessionId, true);
      }

      // Broadcast session list via SSE so sidebar updates with the graduated session
      ctx.sseBroadcast("session_list", { sessions: ctx.sessionManager.list() });

      // Mark repo as used now that actual coding is starting
      if (session.remoteUrl) {
        ctx.repoStore.touch(session.remoteUrl);
      }

      // Start warming the next session for this repo in the background
      if (session.remoteUrl) {
        ctx.warmSessionForRepo(session.remoteUrl, { withStandby: true });
      }
    }

    // If session has a workspaceDir but it was deleted, handle recovery
    if (session?.workspaceDir) {
      try {
        await fs.access(session.workspaceDir);
      } catch {
        if (session.sessionType === "worktree") {
          // Worktree directories can't simply be recreated — the git
          // worktree linkage (branch, shared repo) must be intact.
          ctx.send({
            type: "error",
            message: "This session's workspace is no longer available. The worktree may have been cleaned up.",
          });
          return;
        }
        console.log("[server] Recreating missing session directory:", session.workspaceDir);
        await fs.mkdir(session.workspaceDir, { recursive: true });
        const git = ctx.createGitManager(session.workspaceDir);
        await git.init();
      }
    }
  } else {
    // New session — create isolated directory
    const { appSessionId, sessionDir } = await ctx.createSessionDir(
      userText.slice(0, 80) || "New session",
    );
    ctx.setActiveAppSessionId(appSessionId);
    ctx.setActiveSessionDir(sessionDir);

    // Check git identity for the new session
    ctx.checkGitIdentity(sessionDir);
  }

  // Ensure a runner exists for this session and attach to it
  const activeId = ctx.getActiveAppSessionId();
  const activeDir = ctx.getActiveSessionDir();
  if (activeId && activeDir) {
    const registry = ctx.getRunnerRegistry();
    const runner = registry.getOrCreate(activeId, activeDir, ctx.getActiveAgentId());
    ctx.attachToRunner(runner);
  }

  ctx.setIsClaudeRunning(true);
  await runClaudeWithMessage(ctx, {
    userText,
    images,
    validatedFiles,
    agentSessionId,
    permissionMode: msg.permissionMode,
    isNewSession: !msg.sessionId,
  });
}

export async function handleAnswerQuestion(ctx: FullCtx, msg: WsAnswerQuestion): Promise<void> {
  const answerParts = Object.values(msg.answers);
  const answerText = answerParts.join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  const existingAgent = ctx.getAgent();
  if (existingAgent) {
    // Claude is still running — write answer to stdin (it may be blocking on input)
    existingAgent.writeStdin(`${answerText  }\n`);
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

  ctx.setTurnSummary("");
  ctx.setAccumulatedText("");
  ctx.setAccumulatedToolUse([]);
  ctx.setChatMessageGroups([]);
  ctx.setNeedsNewMessageGroup(true);
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  ctx.setAgent(currentAgent);

  const persistUserMessage = (sessionId: string) => {
    ctx.chatHistoryManager.append(sessionId, { role: "user", text: answerText });
  };

  // Persist the user answer immediately if we have a session
  if (capturedSessionId) {
    persistUserMessage(capturedSessionId);
  }

  wireAgentListeners(ctx, currentAgent, {
    isNewSession: false,
    persistUserMessage,
    fallbackTitle: answerText.slice(0, 80) || "Answer",
    capturedSessionId,
  });

  const answerRunner = ctx.getRunner();
  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    if (answerRunner) answerRunner.setAgent(null);

    try {
      if (capturedSessionDir) {
        await postTurnCommit(ctx, {
          sessionDir: capturedSessionDir,
          sessionId: capturedSessionId,
          emit: (msg) => ctx.send(msg),
        });
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

  });

  // Look up agent session ID for --resume
  const session = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  const agentSessionId = session?.agentSessionId ?? capturedSessionId;

  const systemPrompt = await ctx.readSystemPrompt();
  currentAgent.run({
    prompt: answerText,
    sessionId: agentSessionId,
    systemPrompt,
    cwd: capturedSessionDir ?? ctx.workspaceDir,
  });
  ctx.broadcastLog("server", "Agent process started");
}
