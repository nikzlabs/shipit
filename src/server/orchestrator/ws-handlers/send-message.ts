import fs from "node:fs/promises";
import type { WsClientMessage, WsServerMessage, ClaudeContentBlockText, ClaudeContentBlockToolUse, ImageAttachment, FileAttachment, FileContextRef, PermissionMode } from "../../shared/types.js";
import type { AgentEvent, AgentProcess } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;
import { getErrorMessage, validateImages, resolveFileAttachments, formatFileContext } from "../validation.js";
import { generateSessionName } from "../session-namer.js";

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;

/**
 * Auto-commit working tree changes after an agent turn and link the commit to
 * the last assistant message in chat history. Returns the commit hash or null.
 */
async function postTurnCommit(
  ctx: Pick<FullCtx, "createGitManager" | "getTurnSummary" | "scheduleAutoPush" | "chatHistoryManager">,
  opts: {
    sessionDir: string;
    sessionId: string | undefined;
    emit: (msg: WsServerMessage) => void;
  },
): Promise<string | null> {
  const git = ctx.createGitManager(opts.sessionDir);
  const parentHash = await git.getHeadHash();
  const firstLine = ctx.getTurnSummary().split("\n")[0]?.slice(0, 120) || "Agent turn";
  const commitHash = await git.autoCommit(firstLine);
  if (!commitHash) return null;

  opts.emit({ type: "git_committed", hash: commitHash, message: firstLine });
  ctx.scheduleAutoPush(git);

  if (opts.sessionId && parentHash) {
    ctx.chatHistoryManager.updateLastMessage(opts.sessionId, {
      commitHash,
      parentCommitHash: parentHash,
    });
    const messages = ctx.chatHistoryManager.load(opts.sessionId);
    opts.emit({
      type: "commit_linked",
      messageIndex: messages.length - 1,
      commitHash,
      parentCommitHash: parentHash,
    });
  }
  return commitHash;
}

/** Context window size in tokens (same across all current model families). */
export const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Wire up common agent event listeners shared across send_message,
 * answer_question, and the queued-message replay inside runClaudeWithMessage.
 */
function wireAgentListeners(
  ctx: FullCtx,
  agent: AgentProcess,
  opts: {
    isNewSession: boolean;
    persistUserMessage: (sessionId: string) => void;
    fallbackTitle?: string;
    /** Session ID captured at turn start — immune to session switches. */
    capturedSessionId?: string;
  },
): void {
  const runner = ctx.getRunner();
  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitToViewers = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  agent.on("log", (source: string, text: string) => {
    ctx.broadcastLog(source as "stderr" | "stdout" | "server", text);
  });

  agent.on("event", (event: AgentEvent) => {
    emitToViewers({ type: "agent_event", event });

    if (event.type === "agent_init") {
      // Use the session ID captured at turn start — immune to session switches
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
        const session = ctx.sessionManager.get(turnSessionId);
        if (session) {
          emitToViewers({ type: "session_started", session });
          ctx.sseBroadcast("session_started", { session });
        }
        if (opts.isNewSession) {
          opts.persistUserMessage(turnSessionId);
        }
      } else {
        const title = opts.fallbackTitle ?? "New session";
        const session = ctx.sessionManager.track(event.sessionId, title);
        ctx.setActiveAppSessionId(event.sessionId);
        emitToViewers({ type: "session_started", session });
        ctx.sseBroadcast("session_started", { session });
        opts.persistUserMessage(event.sessionId);
      }

      if (event.model) {
        emitToViewers({
          type: "model_info",
          model: event.model,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        });
      }
    }

    if (event.type === "agent_assistant") {
      const text = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockText => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) {
        ctx.setTurnSummary(text);
        ctx.setAccumulatedText(ctx.getAccumulatedText() + text);
      }

      const toolBlocks = (event.content ?? [])
        .filter((b): b is ClaudeContentBlockToolUse => b.type === "tool_use");
      if (toolBlocks.length > 0) {
        ctx.setAccumulatedToolUse([...ctx.getAccumulatedToolUse(), ...toolBlocks]);
      }

      // Track message groups for chat history (split at tool-result boundaries)
      if (text || toolBlocks.length > 0) {
        const groups = ctx.getChatMessageGroups();
        if (ctx.getNeedsNewMessageGroup() || groups.length === 0) {
          groups.push({ text, toolUse: [...toolBlocks] });
          ctx.setNeedsNewMessageGroup(false);
        } else {
          const last = groups[groups.length - 1];
          last.text += text;
          last.toolUse.push(...toolBlocks);
        }
        ctx.setChatMessageGroups(groups);
      }
    }

    // Mark a message-group boundary when tool results arrive so the
    // next agent_assistant starts a new chat history entry.
    if (event.type === "agent_tool_result") {
      ctx.setNeedsNewMessageGroup(true);
    }

    if (event.type === "agent_result") {
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
        ctx.sessionManager.track(turnSessionId);
      }

      const usageSessionId = turnSessionId ?? event.sessionId;
      if (event.cost?.totalUsd !== undefined) {
        ctx.usageManager.record(
          usageSessionId,
          event.cost.totalUsd,
          event.durationMs ?? 0,
          event.tokens?.input,
          event.tokens?.output,
        );
        const sessionUsage = ctx.usageManager.getSessionUsage(usageSessionId);
        if (sessionUsage) {
          const tokenTotals = ctx.usageManager.getSessionTokenTotals(usageSessionId);
          emitToViewers({
            type: "usage_update",
            sessionId: sessionUsage.sessionId,
            totalCostUsd: sessionUsage.totalCostUsd,
            totalDurationMs: sessionUsage.totalDurationMs,
            turnCount: sessionUsage.turnCount,
            lastTurnInputTokens: event.tokens?.input,
            lastTurnOutputTokens: event.tokens?.output,
            cumulativeInputTokens: tokenTotals?.cumulativeInputTokens,
          });
        }
      }

      // Persist each message group as a separate assistant entry so that
      // reloaded chat history shows the same message boundaries as live streaming.
      const groups = ctx.getChatMessageGroups();
      for (const group of groups) {
        if (group.text || group.toolUse.length > 0) {
          ctx.chatHistoryManager.append(usageSessionId, {
            role: "assistant",
            text: group.text,
            toolUse: group.toolUse.length > 0 ? group.toolUse : undefined,
          });
        }
      }
    }
  });

  agent.on("auth_required", () => {
    console.log("[server] Agent CLI requires authentication, starting OAuth flow");
    emitToViewers({ type: "auth_required" });
    ctx.authManager.startOAuthFlow();
  });

  agent.on("error", (err: Error) => {
    console.error("[agent] process error:", err.message);
    ctx.broadcastLog("server", `Agent process error: ${err.message}`);
    emitToViewers({ type: "error", message: `Agent process error: ${err.message}` });
    const turnSessionId = opts.capturedSessionId;
    if (turnSessionId) {
      ctx.chatHistoryManager.append(turnSessionId, {
        role: "assistant",
        text: `Error: ${err.message}`,
        isError: true,
      });
    }
    ctx.setAgent(null);
  });
}

/**
 * Core Claude execution logic. Shared between send_message and
 * home_send_with_repo handlers. Session state (activeAppSessionId,
 * activeSessionDir) must already be set before calling this.
 */
async function runClaudeWithMessage(ctx: FullCtx, opts: {
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
    ctx.setAgent(null);

    // If the process exited without producing a result event, notify the
    // client so it can clear the loading state instead of hanging forever.
    if (!receivedResult && !ctx.getWasInterrupted()) {
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
    ctx.setIsClaudeRunning(false);
    const messageQueue = ctx.getMessageQueue();
    if (ctx.getWasInterrupted() && messageQueue.length > 0) {
      ctx.clearMessageQueue();
      emitDone({ type: "queue_updated", queue: [] });
    }
    if (!ctx.getWasInterrupted() && messageQueue.length > 0) {
      const next = messageQueue.shift()!;
      // Notify the client that the queue is now one shorter
      emitDone({
        type: "queue_updated",
        queue: messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
      });
      ctx.setIsClaudeRunning(true);
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
        ctx.setIsClaudeRunning(false);
      }
    }

    // Notify via SSE for sidebar activity dots
    if (capturedSessionId && !ctx.getIsClaudeRunning()) {
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

  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    ctx.setAgent(null);

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
