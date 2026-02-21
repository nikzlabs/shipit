import fs from "node:fs/promises";
import type { WsClientMessage, ClaudeEvent, ClaudeContentBlockText, ClaudeContentBlockToolUse, ImageAttachment, FileAttachment, FileContextRef, PermissionMode } from "../types.js";
import type { AgentEvent, AgentProcess } from "../agents/agent-process.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage, validateImages, resolveFileAttachments, formatFileContext } from "../validation.js";
import { generateBranchPrefix } from "../git.js";
import { generateSessionName } from "../session-namer.js";

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;
type WsHomeSendWithRepo = Extract<WsClientMessage, { type: "home_send_with_repo" }>;

/**
 * Convert a normalized AgentEvent back to the legacy ClaudeEvent format
 * for backward compatibility. Returns null for events that don't have
 * a ClaudeEvent equivalent.
 */
function agentEventToClaudeEvent(event: AgentEvent): ClaudeEvent | null {
  switch (event.type) {
    case "agent_init":
      return {
        type: "system",
        subtype: "init",
        session_id: event.sessionId,
        model: event.model,
        tools: event.tools,
      };
    case "agent_assistant":
      return {
        type: "assistant",
        message: { content: event.content },
      };
    case "agent_tool_result":
      return {
        type: "user",
        message: { content: event.content },
      };
    case "agent_result":
      return {
        type: "result",
        subtype: event.status,
        session_id: event.sessionId,
        total_cost_usd: event.cost?.totalUsd,
        duration_ms: event.durationMs,
        result: event.error,
        input_tokens: event.tokens?.input,
        output_tokens: event.tokens?.output,
        cache_read_tokens: event.tokens?.cacheRead,
        cache_write_tokens: event.tokens?.cacheWrite,
      };
    default:
      return null;
  }
}

/** Map model identifiers to context window sizes. */
export function getContextWindowSize(model: string): number {
  if (model.includes("opus")) return 200_000;
  if (model.includes("sonnet")) return 200_000;
  if (model.includes("haiku")) return 200_000;
  return 200_000;
}

/**
 * Wire up common agent event listeners shared across send_message,
 * answer_question, and the queued-message replay inside runClaudeWithMessage.
 */
function wireAgentListeners(
  ctx: HandlerContext,
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
  const emitToViewers = (msg: import("../types.js").WsServerMessage) => {
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

    const legacyEvent = agentEventToClaudeEvent(event);
    if (legacyEvent) {
      emitToViewers({ type: "claude_event", event: legacyEvent });
    }

    if (event.type === "agent_init") {
      // Use the session ID captured at turn start — immune to session switches
      const turnSessionId = opts.capturedSessionId;
      if (turnSessionId) {
        ctx.sessionManager.setAgentSessionId(turnSessionId, event.sessionId);
        const session = ctx.sessionManager.get(turnSessionId);
        if (session) {
          emitToViewers({ type: "session_started", session });
        }
        if (opts.isNewSession) {
          opts.persistUserMessage(turnSessionId);
        }
      } else {
        const title = opts.fallbackTitle ?? "New session";
        const session = ctx.sessionManager.track(event.sessionId, title);
        ctx.setActiveAppSessionId(event.sessionId);
        emitToViewers({ type: "session_started", session });
        opts.persistUserMessage(event.sessionId);
      }

      if (event.model) {
        emitToViewers({
          type: "model_info",
          model: event.model,
          contextWindowTokens: getContextWindowSize(event.model),
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

      const accumulatedText = ctx.getAccumulatedText();
      const accumulatedToolUse = ctx.getAccumulatedToolUse();
      if (accumulatedText || accumulatedToolUse.length > 0) {
        ctx.chatHistoryManager.append(usageSessionId, {
          role: "assistant",
          text: accumulatedText,
          toolUse: accumulatedToolUse.length > 0 ? accumulatedToolUse : undefined,
        });
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
async function runClaudeWithMessage(ctx: HandlerContext, opts: {
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
  let receivedResult = false;
  ctx.setWasInterrupted(false);
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  ctx.setAgent(currentAgent);

  // Broadcast session_agent_started to all clients (sidebar activity)
  if (capturedSessionId) {
    ctx.broadcast({ type: "session_agent_started", sessionId: capturedSessionId });
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
  const emitDone = (msg: import("../types.js").WsServerMessage) => {
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
    try {
      if (capturedSessionDir) {
        const git = ctx.createGitManager(capturedSessionDir);
        const firstLine = ctx.getTurnSummary().split("\n")[0]?.slice(0, 120) || "Agent turn";
        const hash = await git.autoCommit(firstLine);
        if (hash) {
          emitDone({ type: "git_committed", hash, message: firstLine });
          // Schedule auto-push (debounced)
          ctx.scheduleAutoPush(git, ctx.send);
        }
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    // Restart preview after agent finishes in case new files were created.
    // Use the captured session dir to avoid restarting the wrong preview.
    if (capturedSessionDir && !ctx.previewManager.running) {
      await ctx.previewManager.start(capturedSessionDir);
    }

    // Scan for dev servers that the agent may have started.
    await ctx.runPortScan();

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

    // Broadcast session_agent_finished to all clients (sidebar activity)
    if (capturedSessionId && !ctx.getIsClaudeRunning()) {
      ctx.broadcast({ type: "session_agent_finished", sessionId: capturedSessionId });
      if (runner) runner.onAgentFinished();
    }
  });

  // Build the system prompt, incorporating conversation replay for forked threads
  let systemPrompt = await ctx.readSystemPrompt();
  const activeAppSessionId = ctx.getActiveAppSessionId();
  if (activeAppSessionId) {
    const activeThread = ctx.threadManager.getActiveThread(activeAppSessionId);
    if (activeThread) {
      const replay = ctx.threadManager.consumeConversationReplay(
        activeAppSessionId,
        activeThread.id,
      );
      if (replay) {
        // On a forked thread with replay context, start a fresh session
        agentSessionId = undefined;
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${replay}`
          : replay;
      }
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

export async function handleSendMessage(ctx: HandlerContext, msg: WsSendMessage): Promise<void> {
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

  // Determine session context: resume existing or create new
  let agentSessionId: string | undefined;
  if (msg.sessionId) {
    // Resuming an existing session
    // Clear the queue when switching to a different session
    if (ctx.getActiveAppSessionId() && msg.sessionId !== ctx.getActiveAppSessionId() && ctx.getMessageQueue().length > 0) {
      ctx.clearMessageQueue();
      ctx.send({ type: "queue_updated", queue: [] });
    }
    await ctx.activateSession(msg.sessionId);
    const session = ctx.sessionManager.get(msg.sessionId);
    // Only resume if we have a real Claude CLI session ID
    agentSessionId = session?.agentSessionId;

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
        const identity = ctx.credentialStore.getGitIdentity();
        if (!identity) {
          ctx.send({ type: "git_identity_required" });
          return;
        }
        const git = ctx.createGitManager(session.workspaceDir);
        await git.init(identity);
      }
    }
  } else {
    // New session — create isolated directory
    const { appSessionId, sessionDir } = await ctx.createSessionDir(
      userText.slice(0, 80) || "New session",
    );
    ctx.setActiveAppSessionId(appSessionId);
    ctx.setActiveSessionDir(sessionDir);

    // Restart file watcher to the new session directory
    ctx.fileWatcher.stop();
    ctx.fileWatcher.start(sessionDir);

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

export async function handleAnswerQuestion(ctx: HandlerContext, msg: WsAnswerQuestion): Promise<void> {
  const answerParts = Object.values(msg.answers);
  const answerText = answerParts.join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  const existingAgent = ctx.getAgent();
  if (existingAgent) {
    // Claude is still running — write answer to stdin (it may be blocking on input)
    existingAgent.writeStdin(answerText + "\n");
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
        const git = ctx.createGitManager(capturedSessionDir);
        const firstLine = ctx.getTurnSummary().split("\n")[0]?.slice(0, 120) || "Agent turn";
        const hash = await git.autoCommit(firstLine);
        if (hash) {
          ctx.send({ type: "git_committed", hash, message: firstLine });
          // Schedule auto-push (debounced)
          ctx.scheduleAutoPush(git, ctx.send);
        }
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    if (capturedSessionDir && !ctx.previewManager.running) {
      await ctx.previewManager.start(capturedSessionDir);
    }
    await ctx.runPortScan();
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

export async function handleHomeSendWithRepo(ctx: HandlerContext, msg: WsHomeSendWithRepo): Promise<void> {
  // Check auth before spawning
  if (!ctx.authManager.authenticated) {
    ctx.authManager.checkCredentials();
  }
  if (!ctx.authManager.authenticated) {
    ctx.send({ type: "auth_required" });
    ctx.authManager.startOAuthFlow();
    return;
  }

  const staleAgent = ctx.getAgent();
  if (staleAgent) {
    staleAgent.kill();
  }

  let repoUrl = typeof msg.repoUrl === "string" ? msg.repoUrl.trim() : "";
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!repoUrl) {
    ctx.send({ type: "error", message: "Repository URL is required" });
    return;
  }
  if (!text) {
    ctx.send({ type: "error", message: "Message text is required" });
    return;
  }
  if (text.length > 10000) {
    ctx.send({ type: "error", message: "Message too long (max 10000 characters)" });
    return;
  }

  // Support owner/repo shorthand
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoUrl)) {
    repoUrl = `https://github.com/${repoUrl}.git`;
  }

  // Validate images if provided
  const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
  if (images) {
    const imageError = validateImages(images);
    if (imageError) {
      ctx.send({ type: "error", message: imageError });
      return;
    }
  }

  // Validate file attachments
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

  try {
    // Shared repo dir — one clone per repo URL, all sessions are worktrees
    const repoDir = ctx.getSharedRepoDir(repoUrl);
    const repoExists = await fs.stat(repoDir).then(() => true, () => false);

    if (!repoExists) {
      // First time: clone into shared repo dir
      await fs.mkdir(repoDir, { recursive: true });
      const cloneUrl = ctx.githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
      const repoGit = ctx.createGitManager(repoDir);
      await repoGit.clone(cloneUrl);
      console.log("[home] Cloned repo to shared dir:", repoDir);
    } else {
      // Fetch latest from remote so the worktree starts up-to-date
      try {
        const repoGit = ctx.createGitManager(repoDir);
        await repoGit.fetch("origin");
      } catch (err) {
        console.warn("[home] Fetch in shared repo failed (continuing):", getErrorMessage(err));
      }
    }

    // Create session dir (skip git init — worktree handles this)
    const branchPrefix = generateBranchPrefix();
    const created = await ctx.createSessionDir(text.slice(0, 80), { skipGitInit: true });
    const appSessionId = created.appSessionId;
    const sessionDir = created.sessionDir;

    // Remove the empty dir (worktree add needs it absent)
    await fs.rm(sessionDir, { recursive: true, force: true });

    // Create worktree from shared repo, starting from latest remote default branch
    const repoGit = ctx.createGitManager(repoDir);

    // Detect empty repo (no commits yet — HEAD is invalid, can't create worktree)
    const repoLog = await repoGit.log(1);
    const isEmptyRepo = repoLog.length === 0;

    if (isEmptyRepo) {
      // Empty repo: can't use worktrees. Init a fresh repo with remote configured.
      const identity = ctx.credentialStore.getGitIdentity();
      if (!identity) {
        ctx.send({ type: "git_identity_required" });
        return;
      }
      await fs.mkdir(sessionDir, { recursive: true });
      const sessionGit = ctx.createGitManager(sessionDir);
      await sessionGit.init(identity);
      const cloneUrl = ctx.githubAuthManager.getAuthenticatedCloneUrl(repoUrl);
      await sessionGit.addRemote("origin", cloneUrl);
    } else {
      let startPoint: string | undefined;
      try {
        const defaultBranch = await repoGit.getDefaultBranch();
        if (defaultBranch && !defaultBranch.includes("(")) {
          startPoint = `origin/${defaultBranch}`;
        }
      } catch {
        // Fallback: let git use HEAD
      }
      await repoGit.createWorktree(sessionDir, branchPrefix, startPoint);
    }

    // Configure credentials and identity in the worktree
    if (ctx.githubAuthManager.authenticated) {
      ctx.githubAuthManager.configureGitCredentials(sessionDir);
    }
    const storedId = ctx.credentialStore.getGitIdentity();
    if (storedId) {
      const git = ctx.createGitManager(sessionDir);
      await git.setIdentity(storedId.name, storedId.email);
    }

    // Store metadata and activate session
    ctx.sessionManager.setRemoteUrl(appSessionId, repoUrl);
    if (!isEmptyRepo) {
      ctx.sessionManager.setWorktreeInfo(appSessionId, {
        branch: branchPrefix,
        sessionType: "worktree",
      });
    }
    ctx.setActiveAppSessionId(appSessionId);
    ctx.setActiveSessionDir(sessionDir);
    ctx.fileWatcher.stop();
    ctx.fileWatcher.start(sessionDir);

    const session = ctx.sessionManager.get(appSessionId);
    if (session) {
      ctx.send({ type: "session_started", session });
    }

    // Fire non-blocking Claude call to generate session name + branch slug
    generateSessionName(text, sessionDir).then(async (nameResult) => {
      if (!nameResult) return;
      try {
        const newBranchName = `${branchPrefix}-${nameResult.slug}`;
        const sessionGit = ctx.createGitManager(sessionDir);
        await sessionGit.renameBranch(branchPrefix, newBranchName);
        ctx.sessionManager.rename(appSessionId, nameResult.title);
        ctx.sessionManager.setWorktreeInfo(appSessionId, {
          branch: newBranchName,
          sessionType: "worktree",
        });
        const finalSession = ctx.sessionManager.get(appSessionId);
        if (finalSession) {
          ctx.send({ type: "session_renamed", session: finalSession });
        }
      } catch (err) {
        console.warn("[home] Branch rename failed:", getErrorMessage(err));
      }
    }).catch((err) => {
      console.warn("[home] Session naming failed:", err);
    });

    // Ensure a runner exists for this session and attach to it
    {
      const registry = ctx.getRunnerRegistry();
      const homeRunner = registry.getOrCreate(appSessionId, sessionDir, ctx.getActiveAgentId());
      ctx.attachToRunner(homeRunner);
    }

    // Run Claude with the user's message
    ctx.setIsClaudeRunning(true);
    await runClaudeWithMessage(ctx, {
      userText: text,
      images,
      validatedFiles,
      permissionMode: msg.permissionMode,
      isNewSession: true,
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to setup repo: ${getErrorMessage(err)}` });
  }
}
