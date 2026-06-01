import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";
import { resolveRunner } from "./resolve-runner.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "../session-runner.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  selectAgentEnvForPush,
} from "../session-agent-env.js";
import { buildAgentRunParams } from "../session-agent-run-params.js";
import { emitPrLifecycleAfterCommit } from "../services/pr-lifecycle.js";
import { executeAgentTurn } from "../turn-executor.js";

// docs/149 — re-export so existing `selectAgentEnvForPush` consumers (unit
// tests, secret-resolver coverage) keep their import path working while the
// canonical home moves to `session-agent-env.ts`.
export { selectAgentEnvForPush };

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
export function saveImagesToUploadsDir(images: ImageAttachment[], workspaceDir: string): string {
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
 * Flip the in-progress rows of an interrupted turn to `in_progress=0` so the
 * accumulated partial work survives the next turn's `replaceInProgress` wipe
 * (the "first turn erased from history" bug from docs/156).
 *
 * Best-effort: if the chatHistoryManager's DB has already been closed (which
 * happens when the agent's `done` event fires from a setTimeout callback
 * after app shutdown / test teardown — vitest's FakeClaudeProcess.interrupt()
 * schedules a 10ms delayed "done" emission, plenty long for the test fixture
 * to be torn down first), swallow the better-sqlite3 "database connection is
 * not open" error rather than crashing on an unhandled rejection. The partial
 * messages going unpersisted in this edge case is acceptable; corrupting the
 * process with an unhandled error is not.
 */
function persistInterruptedTurn(
  ctx: FullCtx,
  sessionId: string,
  partial: ReturnType<typeof buildTurnMessages>,
): void {
  try {
    ctx.chatHistoryManager.replaceInProgress(sessionId, partial);
    ctx.chatHistoryManager.finalizeInProgress(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("database connection is not open")) return;
    throw err;
  }
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
 * Core WS agent execution — now a thin transport adapter over the shared
 * `executeAgentTurn` (turn-executor.ts). Shared between send_message and
 * home_send_with_repo handlers. Session state (activeAppSessionId,
 * activeSessionDir) must already be set before calling this.
 *
 * The adapter's job is the genuinely WS-specific work: capture per-connection
 * session state at turn start (immune to mid-turn session switches), resolve
 * the registry-backed runner, apply the guarded-mode downgrade, decide live
 * streaming + acquire/reuse the agent process, resolve attachments and assemble
 * the slash-aware prompt, and build the `SystemTurnDeps`/`TurnInput` the
 * executor consumes. Everything from there — reset, env-prep, spawn, listener
 * wiring, and post-turn commit/push/PR/drain — runs in the shared executor, so
 * the WS turn and the dispatched turn can't drift apart.
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

  // Capture the session context at turn start. These values must NOT be read
  // from ctx later because the user may switch sessions while the agent runs.
  const capturedSessionId = ctx.getActiveAppSessionId();
  const capturedSessionDir = ctx.getActiveSessionDir();
  const turnStartHeadHash = capturedSessionDir
    ? await ctx.createGitManager(capturedSessionDir).getHeadHash()
    : null;

  // Bump `last_used_at` at turn *start* (the post-merge auto-archive prune ranks
  // merged sessions by most-recent activity).
  if (capturedSessionId) ctx.sessionManager.track(capturedSessionId);

  // Resolve the runner via the registry (by session ID) so it survives WS
  // disconnects — critical for queue-drained turns that finish after the
  // originating socket is gone.
  const runner = resolveRunner(ctx, capturedSessionId);

  const agentId = ctx.getActiveAgentId();

  // docs/138 — if a previous turn found guarded mode unavailable, silently
  // downgrade `guarded` → `auto` (omit) so we don't keep re-requesting it.
  const effectivePermissionMode: PermissionMode | undefined =
    permissionMode === "guarded" && (runner?.guardedUnavailable ?? false) ? undefined : permissionMode;

  // Live steering (docs/140): use streaming when enabled and the agent supports
  // it, reusing the resident streaming process across turns rather than spawning
  // a new one.
  const agentInfo = ctx.agentRegistry.get(agentId);
  const useStreaming = ctx.credentialStore.getLiveSteering() && (agentInfo?.capabilities.supportsSteering ?? false);
  const existingAgent = useStreaming ? (runner?.getAgent() ?? null) : null;
  const currentAgent = existingAgent ?? ctx.agentFactory(agentId);
  if (!existingAgent && runner) runner.setAgent(currentAgent);

  // Broadcast to all viewers via the runner; fall back to the per-connection
  // socket when there's no registry-backed runner (workspace-less session).
  const emit = (m: WsServerMessage): void => {
    if (runner) runner.emitMessage(m);
    else ctx.send(m);
  };
  // Session id the executor uses for run-params / persistence / SSE.
  const sessionId = capturedSessionId ?? runner?.sessionId ?? "";
  // docs/140 — drop the previous turn's per-turn listeners off a reused process
  // before the executor re-wires its own, else they fire N times after N turns.
  if (existingAgent) existingAgent.removeAllListeners();

  // Chat-history metadata for the persisted user row (inline base64 images +
  // path/preview for files).
  const historyImages = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
  const historyFiles = validatedFiles.length > 0
    ? validatedFiles.map((f) => ({
        path: f.path,
        contentPreview: f.content.slice(0, 200),
        startLine: f.startLine,
        endLine: f.endLine,
      }))
    : undefined;
  const persistUserMessage = (sessionId: string): void => {
    ctx.chatHistoryManager.append(sessionId, {
      role: "user",
      text: userText,
      images: historyImages,
      files: historyFiles,
      uploadPaths: uploadPaths && uploadPaths.length > 0 ? uploadPaths : undefined,
    });
  };

  // Assemble the prompt from user text plus optional file/image context. Images
  // are saved to the host uploads dir and referenced by path (avoids large
  // base64 payloads over HTTP to the worker).
  const activeDir = ctx.getActiveDir();
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && activeDir ? saveImagesToUploadsDir(images, activeDir) : "";
  const prompt = assembleAgentPrompt({ userText, fileContext, imageContext });

  // Listener deps — same shape the runner-registry builds for system turns.
  const listenerDeps: AgentListenerDeps = {
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

  // Build the shared executor deps from ctx — mirrors runner-registry-factory's
  // system-turn wiring so the WS turn and the dispatched turn consume one shape.
  const deps: SystemTurnDeps = {
    agentFactory: (id) => ctx.agentFactory(id),
    autoCommit: async (sessionDir, summary) => {
      const git = ctx.createGitManager(sessionDir);
      const parentHash = await git.getHeadHash();
      const { commitHash, conflictedFiles, rebaseInProgress } = await git.autoCommit(summary);
      return { commitHash, parentHash, conflictedFiles, rebaseInProgress };
    },
    // Only used by the fallback commit path; the WS path always uses commitTurn
    // (which drives its own push via postTurnCommit → ctx.scheduleAutoPush).
    scheduleAutoPush: (sessionDir) => ctx.scheduleAutoPush(ctx.createGitManager(sessionDir)),
    listenerDeps,
    buildRunParams: async (sessionId, id, p) => {
      // Read agentSessionId fresh from the DB — env-prep's docs/153 leak repair
      // (run by the executor immediately before this) updates it there.
      const session = ctx.sessionManager.get(sessionId);
      return buildAgentRunParams({
        deps: {
          credentialStore: ctx.credentialStore,
          githubAuthManager: ctx.githubAuthManager,
          sessionManager: ctx.sessionManager,
          readSystemPrompt: ctx.readSystemPrompt,
          getSelectedModel: ctx.getSelectedModel,
          ...(ctx.runParamsPreps ? { runParamsPreps: ctx.runParamsPreps } : {}),
        },
        sessionId,
        agentId: id,
        prompt: p,
        sessionDir: activeDir,
        ...(session?.agentSessionId !== undefined ? { agentSessionId: session.agentSessionId } : {}),
        ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
      });
    },
    prepareAgentEnv: async (sessionId, id) => {
      await prepareSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
        },
      });
    },
    finalizeAgentEnv: (sessionId, id) => {
      finalizeSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
        },
      });
    },
    commitTurn: ({ sessionDir, sessionId, summary, turnStartHeadHash: tsh, runner: r, emit }) =>
      postTurnCommit(ctx, {
        sessionDir,
        sessionId,
        emit,
        turnSummary: summary,
        turnStartHeadHash: tsh,
        runner: r,
      }),
    postTurnPrFlow: async (sessionId, sessionDir, commitHash, emit) => {
      await emitPrLifecycleAfterCommit({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          githubAuthManager: ctx.githubAuthManager,
          credentialStore: ctx.credentialStore,
          chatHistoryManager: ctx.chatHistoryManager,
          generateText: ctx.generateText,
          createGitManager: ctx.createGitManager,
        },
        sessionId,
        sessionDir,
        commitHash,
        emit,
      });
    },
  };

  // Preserve a partial interrupted turn (flip in-progress rows to persisted).
  const onInterruptedTurn = (): void => {
    if (!runner || !capturedSessionId) return;
    const partial = buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages ?? [], { inProgress: false });
    persistInterruptedTurn(ctx, capturedSessionId, partial);
    // docs/163 — the interrupted turn is now finalized into chat history, so
    // clear the turn-event replay buffer. Otherwise the buffer stays dirty
    // (lastPersistedBufferIndex only advances on tool-result / agent_result
    // boundaries, neither of which fires on an interrupt without a result) and
    // a later WS reconnect re-emits the turn on top of the persisted copy,
    // duplicating it on reload. Mirrors the clean-completion (`agent_result`)
    // and error paths.
    runner.clearTurnEventBuffer();
  };

  // Queue-drain re-entry — resolves the next message's attachments and recurses
  // into this adapter, so the executor's post-turn drain funnels back through
  // the WS path's attachment handling.
  const drainNext = (): Promise<void> =>
    drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emit);

  await executeAgentTurn(runner, deps, currentAgent, {
    agentId,
    sessionId,
    prompt,
    userText,
    ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
    ...(opts.reviewFilePath !== undefined ? { reviewFilePath: opts.reviewFilePath } : {}),
    // The client already rendered an optimistic bubble — don't echo.
    emitUserEcho: false,
    persistUserMessage,
    isNewSession,
    fallbackTitle: userText.slice(0, 80) || "New session",
    turnStartHeadHash,
    drainNext,
    emit,
    useStreaming,
    reuseExistingAgent: existingAgent !== null,
    emitErrorOnNoResult: true,
    onInterruptedTurn,
  });
}
