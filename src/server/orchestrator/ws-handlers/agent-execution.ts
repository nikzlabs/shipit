import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { AgentEvent } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { wireAgentListeners } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";
import { buildAgentSystemInstructions } from "../agent-instructions.js";
import { quickCreatePr } from "../services/github.js";
import { resolveRunner } from "./resolve-runner.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { ServiceManager } from "../service-manager.js";
import type { CredentialStore } from "../credential-store.js";
import { collectMcpAgentEnv } from "../secret-resolver.js";
import { provisionAgentCredentials, syncAgentTokenIn, syncAgentTokenBack } from "../session-credentials.js";
import { refreshExpiredMcpOAuthTokens } from "../services/mcp-oauth.js";

/**
 * Compute the full agent-env map that should be pushed to the worker's
 * `process.env` ahead of `/agent/start` (docs/088).
 *
 * Two regimes, distinguished by whether the runner has a `ServiceManager`:
 *
 *   * Compose-less session (`serviceManager` is `null`) — pull directly from
 *     `CredentialStore`. The account-level set covers `mcp__*` secrets,
 *     `MCP_PLATFORM_*` OAuth tokens, and `OPENAI_API_KEY`-style top-level
 *     keys. `collectMcpAgentEnv` returns both `mcp__*` and `MCP_PLATFORM_*`
 *     entries; the `mcp__*` ones overlap with `getAllAgentEnv()` but the
 *     values are identical, so spread order doesn't matter.
 *
 *   * Compose session — return the snapshot's `agentValues` map. The snapshot
 *     is the merged set (compose-declared + MCP) produced inside the most
 *     recent `ServiceManager.syncSecrets()` pass. The worker REPLACES its
 *     tracked set on every `PUT /secrets` call, so we MUST carry the *full*
 *     merged set here — pushing just the account-level subset would clobber
 *     the compose-declared `agent: true` secrets.
 *
 * Extracted from `runAgentWithMessage` for unit testability — the if/else
 * decision is the contract; the surrounding `runAgentWithMessage` flow
 * (queue drain, post-turn commit, PR card) is too entangled to test
 * directly.
 */
export function selectAgentEnvForPush(input: {
  serviceManager: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  credentialStore: Pick<CredentialStore, "getAllAgentEnv" | "getAllMcpOAuthTokens">;
}): Record<string, string> {
  if (input.serviceManager) {
    return input.serviceManager.getSecretsSnapshot().agentValues;
  }
  return {
    ...input.credentialStore.getAllAgentEnv(),
    ...collectMcpAgentEnv(input.credentialStore),
  };
}
/**
 * Save base64 images to the session's uploads directory on the host.
 * Returns a prompt prefix referencing the on-disk files (container paths).
 * The agent reads them with the Read tool, which natively supports images.
 *
 * Images that carry `existingPath` (set by `resolveUploadRefs` for images
 * sourced from `/uploads/` upload refs) are referenced in place — they are
 * NOT re-saved. Re-saving under a randomized filename would create a
 * duplicate and the original would have to be deleted, leaving the on-disk
 * path out of sync with the `uploadPaths` recorded in chat history. That
 * mismatch was the root cause of uploaded images reappearing as attached
 * after a reload (see fix history in commits b7375baa5, 654b2c931).
 */
function saveImagesToUploadsDir(images: ImageAttachment[], workspaceDir: string): string {
  const uploadsDir = path.join(path.dirname(workspaceDir), "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const containerPaths: string[] = [];
  for (const img of images) {
    if (img.existingPath) {
      // Image already lives on disk at this path (came in via an upload ref).
      // Reference in place — don't re-save under a new name.
      containerPaths.push(img.existingPath);
      continue;
    }
    const ext = img.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const name = img.filename
      ? `${path.parse(img.filename).name}-${crypto.randomUUID().slice(0, 8)}.${ext}`
      : `image-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(img.data, "base64"));
    containerPaths.push(`/uploads/${name}`);
  }

  const refs = containerPaths.map((p) => `- ${p}`).join("\n");
  return `<attached_images>\nThe user has attached the following image(s) to this message. Use the Read tool to view each one:\n${refs}\n</attached_images>`;
}

/**
 * Assemble the final prompt string from the user text plus optional file and
 * image context.
 *
 * Normally context is PREPENDED to the user text. But when the user invokes a
 * slash command / skill (`/my-skill …`), the Claude CLI only resolves the
 * command when the `/token` sits at index 0 of the prompt. Prepending file or
 * image context would push the `/` off the front and the command would be
 * silently swallowed as literal prose. So for slash invocations we APPEND the
 * context after the user text instead, keeping `/my-skill` at position 0.
 *
 * Extracted as a pure function for unit testability — the ordering decision is
 * the contract. See docs/138.
 */
export function assembleAgentPrompt(input: {
  userText: string;
  fileContext: string;
  imageContext: string;
}): string {
  const { userText, fileContext, imageContext } = input;
  const isSlashInvocation = /^\/[a-zA-Z0-9._-]+/.test(userText.trimStart());
  return (
    isSlashInvocation
      ? [userText, fileContext, imageContext]
      : [imageContext, fileContext, userText]
  )
    .filter(Boolean)
    .join("\n\n");
}

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

/**
 * Mark the captured runner as stopped. Centralizes the `if (runner) runner.running = false`
 * pattern so adding a new error/exit path doesn't drift from the existing
 * ones. Always safe to call — no-op when the runner reference is null
 * (which can happen if the registry entry was disposed mid-turn).
 */
function stopRunner(runner: { running: boolean } | null): void {
  if (runner) runner.running = false;
}

/**
 * Drain the next message from the runner's queue and start a new agent turn.
 * Shared between the agent's `done` handler (normal post-turn path) and the
 * `error` handler (so a transient /agent/start failure — typically a 409
 * race with the previous turn's worker-side cleanup — doesn't strand the
 * rest of the queue).
 *
 * Callers must have already cleared the runner's `_agent` reference and set
 * `running = false`. This helper sets `running = true` again when it shifts
 * a message off, and recursively calls `runAgentWithMessage` to drive the
 * new turn.
 */
export async function drainNextQueuedMessage(
  ctx: FullCtx,
  runner: SessionRunnerInterface | null,
  capturedSessionId: string | undefined,
  capturedSessionDir: string | null | undefined,
  emit: (msg: WsServerMessage) => void,
): Promise<void> {
  if (!runner) return;

  const messageQueue = runner.messageQueue;
  if (runner.wasInterrupted) {
    if (messageQueue.length > 0) {
      runner.clearQueue();
      emit({ type: "queue_updated", queue: [] });
    }
    return;
  }
  if (messageQueue.length === 0) return;

  const next = messageQueue.shift()!;
  emit({
    type: "queue_updated",
    queue: messageQueue.map((item, idx) => ({ text: item.text, position: idx + 1 })),
    dequeued: next.text,
  });
  runner.running = true;

  const nextImages = next.images && next.images.length > 0 ? next.images : undefined;
  const nextFileRefs = next.files && next.files.length > 0 ? next.files : undefined;
  let nextValidatedFiles: FileAttachment[] = [];
  if (nextFileRefs) {
    const dir = capturedSessionDir ?? ctx.workspaceDir;
    const fileResult = await resolveFileAttachments(nextFileRefs, dir);
    if (fileResult.error) {
      emit({ type: "error", message: fileResult.error });
      runner.running = false;
      return;
    }
    nextValidatedFiles = fileResult.files;
  }
  let allNextImages = nextImages;
  const nextUploadRefs = next.uploads && next.uploads.length > 0 ? next.uploads : undefined;
  if (nextUploadRefs) {
    const dir = capturedSessionDir ?? ctx.workspaceDir;
    const uploadResult = await resolveUploadRefs(nextUploadRefs, dir);
    if (uploadResult.error) {
      emit({ type: "error", message: uploadResult.error });
      runner.running = false;
      return;
    }
    nextValidatedFiles = [...nextValidatedFiles, ...uploadResult.files];
    if (uploadResult.images.length > 0) {
      allNextImages = [...(allNextImages ?? []), ...uploadResult.images];
      // See send-message.ts: originals are kept in place so
      // `uploadPaths` in chat history matches the actual on-disk path,
      // which is what makes hydrateUploads work correctly.
    }
  }
  const nextSession = capturedSessionId
    ? ctx.sessionManager.get(capturedSessionId)
    : undefined;
  try {
    await runAgentWithMessage(ctx, {
      userText: next.text,
      images: allNextImages,
      validatedFiles: nextValidatedFiles,
      agentSessionId: nextSession?.agentSessionId,
      permissionMode: next.permissionMode,
      isNewSession: false,
      uploadPaths: nextUploadRefs?.map((u) => u.path),
      reviewFilePath: next.reviewFilePath,
    });
  } catch (err) {
    console.error("[queue] Error processing queued message:", getErrorMessage(err));
    runner.running = false;
  }
}

/**
 * Core agent execution logic. Shared between send_message and
 * home_send_with_repo handlers. Session state (activeAppSessionId,
 * activeSessionDir) must already be set before calling this.
 */
export async function runAgentWithMessage(ctx: FullCtx, opts: {
  userText: string;
  images?: ImageAttachment[];
  validatedFiles: FileAttachment[];
  agentSessionId?: string;
  permissionMode?: PermissionMode;
  isNewSession: boolean;
  /** Original upload paths consumed by this message (for sent-state tracking on reload). */
  uploadPaths?: string[];
  /**
   * docs/125 — when this turn is a chat-native review, the file the
   * `submit_review_comments` tool is authorized to write on. Set on the runner
   * at turn start (here, which is also the dequeue point for queued turns) and
   * cleared when the turn ends.
   */
  reviewFilePath?: string;
}): Promise<void> {
  const { userText, images, validatedFiles, permissionMode, isNewSession, uploadPaths } = opts;
  let { agentSessionId } = opts;

  // Capture the session context at turn start. These values must NOT be read
  // from ctx later because the user may switch sessions while the agent runs,
  // which would change ctx.getActiveAppSessionId() / ctx.getActiveSessionDir().
  const capturedSessionId = ctx.getActiveAppSessionId();
  const capturedSessionDir = ctx.getActiveSessionDir();

  // Resolve the runner via the registry (by session ID) when possible. This
  // makes the runner reference survive WebSocket disconnects — critical for
  // queue-drained turns that may finish after the originating WS is gone.
  const runner = resolveRunner(ctx, capturedSessionId);

  // docs/138 — if a previous turn this session found guarded mode unavailable,
  // silently downgrade `guarded` → `auto` (omit the field) so we don't keep
  // re-requesting a mode the account/model can't use and re-notifying the user.
  // The flag is volatile (clears on restart / reload), so a later admin enable
  // is rediscovered on the next fresh attempt. The downgraded mode is what we
  // both pass to the CLI and report to the listeners as "requested", so the
  // availability check only fires when guarded was genuinely attempted.
  const effectivePermissionMode: PermissionMode | undefined =
    permissionMode === "guarded" && runner?.guardedUnavailable
      ? undefined
      : permissionMode;

  // Reset turn-scoped state directly on the runner.
  if (runner) {
    runner.clearTurnEventBuffer();
    runner.turnSummary = "";
    runner.accumulatedText = "";
    runner.accumulatedToolUse = [];
    runner.chatMessageGroups = [];
    runner.needsNewMessageGroup = true;
    runner.steeredMessages = [];
    runner.wasInterrupted = false;
    // docs/125 — authorize the review tool for exactly this turn's file (or
    // clear the allow-list for a normal turn). Setting it at turn start — the
    // same point sessionId is captured — means a queued review message is
    // authorized only when it actually starts running. Subagent tool calls
    // happen inline within the parent's turn, so the value is still set when
    // `submit_review_comments` lands.
    runner.activeReviewFilePath = opts.reviewFilePath ?? null;
  }
  // Live steering: use streaming mode when enabled and the active agent supports it.
  // For streaming agents, reuse the existing agent process (it persists across turns)
  // rather than creating a new one via the factory. (docs/140)
  const agentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
  const useStreaming = ctx.credentialStore.getLiveSteering() && (agentInfo?.capabilities.supportsSteering ?? false);

  let receivedResult = false;
  const existingAgent = useStreaming ? (runner?.getAgent() ?? null) : null;
  const currentAgent = existingAgent ?? ctx.agentFactory(ctx.getActiveAgentId());
  if (!existingAgent && runner) runner.setAgent(currentAgent);

  // docs/140 — when reusing a persistent streaming agent, the previous turn
  // attached listeners that close over per-turn state (capturedSessionId,
  // persistUserMessage, the `streamingPostTurnFired` flag, etc.). Drop them
  // before this turn re-wires its own, otherwise every `agent_result` /
  // `agent_init` fires N times after N turns — the symptom that prompted this
  // fix (multiple "Agent process started" entries in the log panel). The
  // orchestrator-side `AgentProcess` EventEmitter has no other subscribers —
  // events flow in from the worker SSE relay (proxy) or the local adapter and
  // out to wireAgentListeners + the per-turn handlers in this function — so a
  // blanket removeAllListeners is safe.
  if (existingAgent) {
    existingAgent.removeAllListeners();
  }

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
    // docs/140 diag — tag persist sites so a double-bubble repro shows which
    // call paths fired. Pair this with the `[steered]` and `[sse-drop]` logs
    // in agent-listeners.ts / container-session-runner.ts.
    console.log(
      `[persist-user] runAgentWithMessage session=${sessionId} isNewSession=${isNewSession} text=${JSON.stringify(userText.slice(0, 60))}`,
    );
    ctx.chatHistoryManager.append(sessionId, {
      role: "user",
      text: userText,
      images: historyImages,
      files: historyFiles,
      uploadPaths: uploadPaths && uploadPaths.length > 0 ? uploadPaths : undefined,
    });
  };

  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitDone = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  // docs/142 A — after the turn, write the CLI's refreshed OAuth token back to
  // the orchestrator source if it advanced (expiry-guarded), so the source and
  // future sessions stay fresh. Safe to call on every post-turn path; no-op
  // outside container mode or when nothing rotated.
  const syncTokenBackAfterTurn = () => {
    if (runner instanceof ContainerSessionRunner && capturedSessionId) {
      try {
        syncAgentTokenBack(ctx.credentialsDir, capturedSessionId, currentAgent.agentId);
      } catch (err) {
        console.warn("[credentials] token sync-back failed:", getErrorMessage(err));
      }
    }
  };

  wireAgentListeners(ctx, currentAgent, {
    isNewSession,
    persistUserMessage,
    fallbackTitle: userText.slice(0, 80) || "New session",
    capturedSessionId,
    requestedPermissionMode: effectivePermissionMode,
    onError: () => drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone),
    useStreaming,
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

  // For streaming agents: wire post-turn actions on agent_result instead of done.
  // done fires only on process exit (dispose/crash), not on turn end. (docs/140)
  if (useStreaming) {
    let streamingPostTurnFired = false;
    currentAgent.on("event", async (event: AgentEvent) => {
      if (event.type !== "agent_result") return;
      if (streamingPostTurnFired) return; // guard against multiple result events per turn
      streamingPostTurnFired = true;

      // Capture any OAuth token the CLI refreshed during this turn.
      syncTokenBackAfterTurn();

      // agent-listeners already set runner.running=false on agent_result.
      // DO NOT clear the agent reference here: the streaming CLI process
      // stays alive across turns, and the next top-level turn reuses it via
      // the `existingAgent` branch at the top of `runAgentWithMessage`
      // (which then carries the user message in via `sendUserMessage`).
      // Clearing the ref here was the bug: the next turn would call
      // `/agent/start` against the still-running worker agent, get a 409,
      // fall back to `/agent/kill` + restart (SIGTERM, exit 143), and spam
      // the log panel with a fresh "Agent process started" every turn.
      // Crash / error / dispose paths still clear the ref (agent.on("error"),
      // agent.on("auth_required"), agent.on("done"), runner.dispose).
      stopRunner(runner);

      // Drain queue (may start next turn immediately via the existingAgent path)
      await drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone);

      // Auto-commit
      let commitHash: string | null = null;
      try {
        if (capturedSessionDir) {
          commitHash = await postTurnCommit(ctx, {
            sessionDir: capturedSessionDir,
            sessionId: capturedSessionId,
            emit: emitDone,
            turnSummary: runner?.turnSummary ?? "",
          });
        }
      } catch (err) {
        console.error("[git] streaming auto-commit failed:", getErrorMessage(err));
      }

      // PR lifecycle card (mirrors non-streaming done handler)
      if (commitHash && capturedSessionId && capturedSessionDir) {
        try {
          const session = ctx.sessionManager.get(capturedSessionId);
          if (session?.remoteUrl && session.branchRenamed !== false && !session.mergedAt) {
            const git = ctx.createGitManager(capturedSessionDir);
            const prStatus = ctx.prStatusPoller.getStatus(capturedSessionId);
            if (!prStatus) {
              const shouldAutoCreate = ctx.credentialStore.getAutoCreatePr()
                && ctx.githubAuthManager.authenticated;
              if (shouldAutoCreate) {
                emitDone({
                  type: "pr_lifecycle_update",
                  sessionId: capturedSessionId,
                  cardId: `pr-card-${capturedSessionId}`,
                  phase: "creating",
                });
                try {
                  const result = await quickCreatePr(
                    git,
                    ctx.githubAuthManager,
                    ctx.chatHistoryManager,
                    ctx.generateText,
                    capturedSessionId,
                    session.title ?? "",
                    capturedSessionDir,
                    session.remoteUrl,
                  );
                  if (ctx.prStatusPoller && session.remoteUrl) {
                    ctx.prStatusPoller.trackSession(capturedSessionId, session.remoteUrl);
                  }
                  emitDone({
                    type: "pr_lifecycle_update",
                    sessionId: capturedSessionId,
                    cardId: `pr-card-${capturedSessionId}`,
                    phase: "open",
                    pr: {
                      number: result.number,
                      title: result.title,
                      body: result.body,
                      url: result.url,
                      baseBranch: result.baseBranch,
                      headBranch: result.headBranch,
                      insertions: result.insertions,
                      deletions: result.deletions,
                    },
                  });
                } catch (prErr) {
                  console.error("[pr-lifecycle] streaming auto-create PR failed:", getErrorMessage(prErr));
                  emitDone({
                    type: "pr_lifecycle_update",
                    sessionId: capturedSessionId,
                    cardId: `pr-card-${capturedSessionId}`,
                    phase: "error",
                    errorMessage: getErrorMessage(prErr),
                  });
                }
              } else {
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
          }
        } catch (err) {
          console.error("[pr-lifecycle] streaming diff stats failed:", getErrorMessage(err));
        }
      }

      if (capturedSessionId && !(runner?.running ?? false)) {
        ctx.sseBroadcast("session_agent_finished", { sessionId: capturedSessionId });
        if (runner) runner.onAgentFinished();
      }
    });
  }

  currentAgent.on("done", async (code: number | null) => {
    console.log("[agent] process exited with code", code);
    ctx.broadcastLog("server", `Agent process exited with code ${code}`);
    if (runner) runner.setAgent(null);

    // Capture any OAuth token the CLI refreshed during this turn (non-streaming
    // path; the streaming path does this in the agent_result handler above).
    if (!useStreaming) syncTokenBackAfterTurn();

    // For streaming agents, post-turn flow (commit, PR card, queue drain) already
    // ran in the agent_result listener above. done fires only on process exit
    // (dispose/crash), not on turn end. Just handle the error/cleanup path. (docs/140)
    if (useStreaming) {
      if (!receivedResult && !(runner?.wasInterrupted ?? false)) {
        const reason = code !== 0
          ? `Agent process exited with code ${code}`
          : "Agent process ended without a response";
        emitDone({ type: "error", message: reason });
      }
      stopRunner(runner);
      if (capturedSessionId && !(runner?.running ?? false)) {
        ctx.sseBroadcast("session_agent_finished", { sessionId: capturedSessionId });
        if (runner) runner.onAgentFinished();
      }
      return;
    }

    // Non-streaming: original post-turn flow below.

    // If the process exited without producing a result event, notify the
    // client so it can clear the loading state instead of hanging forever.
    if (!receivedResult && !(runner?.wasInterrupted ?? false)) {
      const reason = code !== 0
        ? `Agent process exited with code ${code}`
        : "Agent process ended without a response";
      emitDone({ type: "error", message: reason });
    }

    // Process the message queue FIRST so the client clears queued visual state
    // immediately, before the (potentially slow) post-turn git commit work.
    // Use runner directly (not ctx) so this works even after WS disconnect.
    stopRunner(runner);
    await drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone);

    // Auto-commit after agent turn using the session dir captured at turn start.
    // Do NOT use ctx.getActiveGitManager() — the user may have switched sessions.
    let commitHash: string | null = null;
    try {
      if (capturedSessionDir) {
        commitHash = await postTurnCommit(ctx, {
          sessionDir: capturedSessionDir,
          sessionId: capturedSessionId,
          emit: emitDone,
          // Pass the captured runner's summary explicitly — ctx.getTurnSummary()
          // returns "" after WS disconnect because it routes through the
          // per-connection attachedRunner. Use the captured (registry-backed)
          // runner so commit messages are correct even for queue-drained turns.
          turnSummary: runner?.turnSummary ?? "",
        });
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    // Emit PR lifecycle card after commit if the session has a remote
    if (commitHash && capturedSessionId && capturedSessionDir) {
      try {
        const session = ctx.sessionManager.get(capturedSessionId);
        if (session?.remoteUrl && session.branchRenamed !== false && !session.mergedAt) {
          const git = ctx.createGitManager(capturedSessionDir);

          // Check if a PR already exists for this branch
          const prStatus = ctx.prStatusPoller.getStatus(capturedSessionId);
          if (prStatus) {
            // PR already exists — the poller handles updates via SSE
          } else {
            // No PR yet — auto-create if the setting is on and GitHub is
            // authenticated. The outer `commitHash` truthiness check guarantees
            // this turn produced a commit (i.e. files actually changed), and
            // the `prStatus` short-circuit above guarantees we won't double-
            // create when a PR is already open. So this fires after every
            // meaningful turn until a PR exists. See doc 099 for the rationale
            // behind dropping the previous `isNewSession` gate.
            const shouldAutoCreate = ctx.credentialStore.getAutoCreatePr()
              && ctx.githubAuthManager.authenticated;

            if (shouldAutoCreate) {
              // Auto-create PR: emit "creating" phase, then create the PR
              emitDone({
                type: "pr_lifecycle_update",
                sessionId: capturedSessionId,
                cardId: `pr-card-${capturedSessionId}`,
                phase: "creating",
              });

              try {
                const result = await quickCreatePr(
                  git,
                  ctx.githubAuthManager,
                  ctx.chatHistoryManager,
                  ctx.generateText,
                  capturedSessionId,
                  session.title ?? "",
                  capturedSessionDir,
                  session.remoteUrl,
                );

                // Track the new PR in the poller
                if (ctx.prStatusPoller && session.remoteUrl) {
                  ctx.prStatusPoller.trackSession(capturedSessionId, session.remoteUrl);
                }

                emitDone({
                  type: "pr_lifecycle_update",
                  sessionId: capturedSessionId,
                  cardId: `pr-card-${capturedSessionId}`,
                  phase: "open",
                  pr: {
                    number: result.number,
                    title: result.title,
                    body: result.body,
                    url: result.url,
                    baseBranch: result.baseBranch,
                    headBranch: result.headBranch,
                    insertions: result.insertions,
                    deletions: result.deletions,
                  },
                });
              } catch (err) {
                console.error("[pr-lifecycle] Auto-create PR failed:", getErrorMessage(err));
                emitDone({
                  type: "pr_lifecycle_update",
                  sessionId: capturedSessionId,
                  cardId: `pr-card-${capturedSessionId}`,
                  phase: "error",
                  errorMessage: getErrorMessage(err),
                });
              }
            } else {
              // Send a "ready" card with diff stats vs base branch
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
        }
      } catch (err) {
        console.error("[pr-lifecycle] Failed to compute diff stats:", getErrorMessage(err));
      }
    }

    // Notify via SSE for sidebar activity dots
    if (capturedSessionId && !(runner?.running ?? false)) {
      ctx.sseBroadcast("session_agent_finished", { sessionId: capturedSessionId });
      if (runner) runner.onAgentFinished();
      // docs/125 — clear the review allow-list now the turn is fully done and
      // no queued turn took over. (A queued turn that started already reset the
      // field for itself in runAgentWithMessage's turn-start block above.)
      if (runner) runner.activeReviewFilePath = null;
    }
  });

  // Auto-create-PR gate: drives the Stop-hook enforcement in the session
  // container (/etc/shipit/managed-settings.json) and the harness fallback in
  // post-turn.ts. The system-prompt nudge is unconditional — keeping the
  // prompt static preserves the Anthropic prompt cache across turns.
  const autoCreatePrActive = ctx.credentialStore.getAutoCreatePr()
    && ctx.githubAuthManager.authenticated;

  const agentInstructions = ctx.credentialStore.getAgentSystemInstructionsEnabled()
    ? buildAgentSystemInstructions({
        // docs/117 Phase 2 — teach the running agent when to reach for
        // `shipit session create`. The guidance differs per agent because
        // Claude has the in-process `Task` tool (the right fan-out primitive
        // for in-turn work) and Codex does not. `agentId` is fixed for the
        // session's lifetime, so this stays the only branching axis.
        agentId: currentAgent.agentId,
      })
    : undefined;
  const userSystemPrompt = await ctx.readSystemPrompt();
  let systemPrompt = [agentInstructions, userSystemPrompt].filter(Boolean).join("\n\n") || undefined;
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
  // Assemble the prompt from the user text plus optional file/image context.
  // The slash-command-aware ordering lives in `assembleAgentPrompt`.
  const activeDir = ctx.getActiveDir();
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  // Save images to the host uploads directory and reference them in the prompt.
  // This avoids sending large base64 payloads over HTTP to the session worker.
  const imageContext =
    images && images.length > 0 && activeDir ? saveImagesToUploadsDir(images, activeDir) : "";

  const prompt = assembleAgentPrompt({ userText, fileContext, imageContext });

  // Always point the Claude CLI at the baked managed-settings.json. It
  // registers two hooks: a PreToolUse branch-block hook (always active —
  // keeps the agent on the session branch) and a Stop hook that enforces
  // "open a PR before ending the turn". The Stop hook self-gates on the
  // SHIPIT_AUTO_CREATE_PR env var, which `autoCreatePr` below controls — so
  // PR enforcement stays opt-in even though the settings file is always
  // wired up. Claude-only; ignored by other adapters.
  // See docs/129-stop-hook-pr-enforcement and docs/130-block-branch-ops.
  const settingsPath = currentAgent.agentId === "claude"
    ? "/etc/shipit/managed-settings.json"
    : undefined;

  // docs/088: pass the enabled user MCP servers as UNRESOLVED config blobs
  // ($secret: placeholders intact). Raw secret values are NOT in this payload
  // — they reach the worker's process.env via 087's agent-env pipeline. The
  // worker resolves placeholders locally in generateMcpConfig().
  const mcpServers = Object.values(ctx.credentialStore.getAllMcpServers()).filter(
    (s) => s.enabled,
  );

  // docs/088 Phase 2: refresh any OAuth tokens whose access tokens are
  // within the safety margin of expiry, BEFORE collecting the env map.
  // Without this, the freshly-pushed env could carry a token that's about
  // to expire and the first MCP tool call would fail. Fault-tolerant by
  // design — refresh failures leave the stale token in place so the worker
  // emits a meaningful `failed` status rather than silently dropping the
  // server.
  await refreshExpiredMcpOAuthTokens({ credentialStore: ctx.credentialStore }).catch(
    (err: unknown) => {
      console.warn("[mcp-oauth] background refresh failed:", getErrorMessage(err));
    },
  );

  // docs/088: sequence the agent-env push ahead of `/agent/start` so the
  // worker's `process.env` carries the right keys before `generateMcpConfig()`
  // resolves `$secret:` / `$platform:` refs. The compose-vs-compose-less
  // decision lives in `selectAgentEnvForPush` (see its docstring); both
  // regimes are exercised in `agent-env-push.test.ts`.
  //
  // Previously only compose-less sessions were covered. Compose sessions
  // relied on a fire-and-forget push from the `secrets_status` listener at
  // activation, leaving an activation-time race where the agent's first turn
  // could start before the push landed. The per-turn awaited push closes
  // that gap.
  //
  // `tryPushAgentSecrets` is internally fault-tolerant — a transient HTTP
  // failure is logged worker-side and never throws — so awaiting it here
  // just sequences the push ahead of `/agent/start` without adding a
  // failure path.
  // docs/138 — pin the agent on the session's first turn. From here the agent
  // is fixed for the session's life and `set_agent` is rejected server-side.
  // For container sessions, also provision ONLY the pinned agent's credential
  // subtree into the session's private credentials dir — cross-agent isolation,
  // so the other agent's creds never land on disk in this session's container.
  // Write-once (skipped after `agentPinned` is set): re-copying would clobber
  // the CLI's in-place writes to `.claude`. Provisioning runs before
  // `/agent/start` so the freshly-copied creds are present when the CLI
  // authenticates; the per-session dir is already mounted, so the host-side
  // write is visible in the container immediately — no remount needed.
  if (capturedSessionId) {
    const session = ctx.sessionManager.get(capturedSessionId);
    if (session && !session.agentPinned) {
      if (runner instanceof ContainerSessionRunner) {
        try {
          provisionAgentCredentials(ctx.credentialsDir, capturedSessionId, currentAgent.agentId);
        } catch (err) {
          console.warn("[credentials] provisioning failed:", getErrorMessage(err));
        }
      }
      ctx.sessionManager.setAgentId(capturedSessionId, currentAgent.agentId);
      ctx.sessionManager.setAgentPinned(capturedSessionId);
    }
  }

  // docs/142 A — sync the freshest OAuth token from the orchestrator source into
  // this session's per-session credentials dir BEFORE the turn, so the CLI
  // starts from the latest token instead of a stale write-once copy. Runs every
  // turn (not just first), and only touches the token file. The matching
  // write-back happens post-turn (see the done / agent_result handlers).
  if (runner instanceof ContainerSessionRunner && capturedSessionId) {
    try {
      syncAgentTokenIn(ctx.credentialsDir, capturedSessionId, currentAgent.agentId);
    } catch (err) {
      console.warn("[credentials] token sync-in failed:", getErrorMessage(err));
    }
  }

  if (runner instanceof ContainerSessionRunner) {
    await runner.tryPushAgentSecrets(
      selectAgentEnvForPush({
        serviceManager: runner.serviceManager,
        credentialStore: ctx.credentialStore,
      }),
    );
  }

  if (existingAgent) {
    // docs/140 — persistent streaming agent reuse. The CLI is already alive
    // and was configured with this session's system prompt / model /
    // permission mode / MCP servers on its initial spawn. Carry the next
    // user message in via `sendUserMessage` (NDJSON on the existing stdin
    // for Claude streaming, `turn/steer`-style JSON-RPC for Codex) instead
    // of issuing another `/agent/start` — the worker would 409 against the
    // still-running process and the orchestrator would fall back to a
    // `/agent/kill` + `/agent/start` cycle (SIGTERM, exit 143).
    existingAgent.sendUserMessage(prompt);
  } else {
    currentAgent.run({
      prompt,
      sessionId: agentSessionId,
      systemPrompt,
      cwd: activeDir,
      permissionMode: effectivePermissionMode,
      model: ctx.getSelectedModel(),
      settingsPath,
      autoCreatePr: autoCreatePrActive,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      useStreaming,
    });
  }
  // "Agent process started" is now emitted from agent-listeners.ts
  // when the agent_init event arrives, so the log reflects an actual
  // successful start (worker accepted /agent/start) rather than every
  // attempt — duplicates rejected by the worker no longer pollute the
  // per-session log ring.
}
