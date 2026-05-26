import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { AgentEvent } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { wireAgentListeners, buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";
import { resolveRunner } from "./resolve-runner.js";
import { resetRunnerTurnState } from "../session-runner.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  selectAgentEnvForPush,
} from "../session-agent-env.js";
import { buildAgentRunParams } from "../session-agent-run-params.js";
import { emitPrLifecycleAfterCommit } from "../services/pr-lifecycle.js";

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
  const { userText, images, validatedFiles, permissionMode, isNewSession, uploadPaths, agentSessionId } = opts;

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

  // Reset turn-scoped state directly on the runner — shared with the system-
  // dispatched and rebase flows so all three paths start from a clean slate
  // (no stale chatMessageGroups bleeding across turns).
  //
  // docs/125 — `reviewFilePath` authorizes the chat-native review tool for
  // exactly this turn's file (or clears the allow-list for a normal turn).
  // Setting it at turn start — the same point sessionId is captured — means
  // a queued review message is authorized only when it actually starts
  // running. Subagent tool calls happen inline within the parent's turn, so
  // the value is still set when `submit_review_comments` lands.
  if (runner) resetRunnerTurnState(runner, { reviewFilePath: opts.reviewFilePath ?? null });
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

  // docs/142 A / docs/149 — after the turn, write the CLI's refreshed OAuth
  // token back to the orchestrator source if it advanced (expiry-guarded), so
  // the source and future sessions stay fresh. Safe to call on every post-turn
  // path; no-op outside container mode or when nothing rotated.
  const syncTokenBackAfterTurn = () => {
    if (!runner || !capturedSessionId) return;
    finalizeSessionAgentEnvironment(runner, {
      sessionId: capturedSessionId,
      agentId: currentAgent.agentId,
      deps: {
        credentialsDir: ctx.credentialsDir,
        credentialStore: ctx.credentialStore,
        sessionManager: ctx.sessionManager,
        providerAccountManager: ctx.providerAccountManager,
      },
    });
  };

  // Sync-back has the same lost-signal hazard as the queue drain: `agent_done`
  // can be missed (SSE drop in the narrow window between `agent_result` and
  // process-exit, worker clearing its agent ref via a race) and was the
  // exclusive trigger for the token write-back. When it was missed, a token
  // the CLI just rotated stayed stranded in the per-session dir; the source
  // never advanced and within an OAuth refresh cycle every fresh session
  // bootstrapped with a dead refresh token → 401. So we fire on `agent_result`
  // (the canonical turn-end signal) too, guarded so the first signal wins and
  // the other becomes a no-op. Mirrors the `postTurnDrainFired` pattern below.
  // Non-streaming only — the streaming block below has its own `syncTokenBackAfterTurn`
  // call alongside `streamingPostTurnFired`.
  let postTurnTokenSyncFired = false;
  const trySyncTokenBack = (): void => {
    if (postTurnTokenSyncFired) return;
    postTurnTokenSyncFired = true;
    syncTokenBackAfterTurn();
  };

  // Guard the post-turn drain so whichever signal arrives first — `agent_result`
  // (the canonical turn-ended event) or `agent_done` (process exit) — advances
  // the queue, and the other becomes a no-op. Previously the drain only hung
  // off `done`, so a missed `agent_done` (SSE drop between agent_result and
  // process-exit, worker clearing its agent ref via a race, etc.) stranded the
  // queue at "1 message queued" forever. Non-streaming only — the streaming
  // post-turn block below has its own `streamingPostTurnFired` guard and
  // performs commit/PR work alongside the drain, so it stays self-contained.
  let postTurnDrainFired = false;
  const tryPostTurnDrain = async (): Promise<void> => {
    if (postTurnDrainFired) return;
    postTurnDrainFired = true;
    stopRunner(runner);
    await drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone);
  };

  const listenerDeps: AgentListenerDeps = {
    sessionManager: ctx.sessionManager,
    chatHistoryManager: ctx.chatHistoryManager,
    usageManager: ctx.usageManager,
    authManager: ctx.authManager,
    sseBroadcast: ctx.sseBroadcast,
    broadcastLog: ctx.broadcastLog,
    getSelectedModel: ctx.getSelectedModel,
    recordAgentRateLimits: ctx.recordAgentRateLimits,
    getSubscriptionLimitsSnapshot: ctx.getSubscriptionLimitsSnapshot,
    nudgeClaudeOAuthRefresh: ctx.nudgeClaudeOAuthRefresh,
  };
  wireAgentListeners(currentAgent, runner, listenerDeps, {
    isNewSession,
    persistUserMessage,
    fallbackTitle: userText.slice(0, 80) || "New session",
    capturedSessionId,
    requestedPermissionMode: effectivePermissionMode,
    onError: () => drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone),
    useStreaming,
  });

  // Track whether we got a result event, and (for non-streaming) sync the
  // token + drain the queue immediately — don't wait for `agent_done`, which
  // can be lost. Sync-back must run BEFORE the next queued turn starts so the
  // next turn's sync-in pulls the just-rotated token instead of the stale
  // source.
  currentAgent.on("event", async (event: AgentEvent) => {
    if (event.type !== "agent_result") return;
    receivedResult = true;
    if (!useStreaming) {
      trySyncTokenBack();
      await tryPostTurnDrain();
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
            runner,
          });
        }
      } catch (err) {
        console.error("[git] streaming auto-commit failed:", getErrorMessage(err));
      }

      // PR lifecycle card (docs/149 — shared helper, identical to done branch).
      if (commitHash && capturedSessionId && capturedSessionDir) {
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
          sessionId: capturedSessionId,
          sessionDir: capturedSessionDir,
          commitHash,
          emit: emitDone,
        });
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
    // Only clear the runner's agent ref if it still points to us. The
    // agent_result-triggered drain above may have already started a new turn
    // and called `runner.setAgent(NEW)`; clobbering it back to null here
    // would strand the new agent and the next event from it would log
    // `[sse-drop] ... dropped (no _agent)`.
    if (runner?.getAgent() === currentAgent) runner.setAgent(null);

    // Capture any OAuth token the CLI refreshed during this turn (non-streaming
    // path; the streaming path does this in the agent_result handler above).
    // Idempotent via `trySyncTokenBack` — if `agent_result` arrived first, the
    // sync already ran and this is a no-op; if `agent_done` arrived alone
    // (SSE-drop scenario where `agent_result` was lost too, plus the
    // process-exit-only crash path), this fires it for the first time.
    if (!useStreaming) trySyncTokenBack();

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
      // Preserve the partial turn when an interrupt (user-typed Stop, or the
      // AskUserQuestion auto-interrupt in agent-listeners) ends the agent
      // without an `agent_result`. The listener's replaceInProgress writes
      // accumulated rows with in_progress=1, and the NEXT turn's first
      // replaceInProgress would wipe them — that's the "first turn erased
      // from history" bug. Flip them to in_progress=0 here so they persist.
      if (capturedSessionId && !receivedResult && runner?.wasInterrupted) {
        const partial = buildTurnMessages(
          runner.chatMessageGroups,
          runner.steeredMessages ?? [],
          { inProgress: false },
        );
        persistInterruptedTurn(ctx, capturedSessionId, partial);
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

    // Mirror the streaming branch: preserve in-progress rows when an interrupt
    // ends the agent without `agent_result`. Without this, the next turn's
    // replaceInProgress wipes the interrupted turn's accumulated work.
    if (capturedSessionId && !receivedResult && runner?.wasInterrupted) {
      const partial = buildTurnMessages(
        runner.chatMessageGroups,
        runner.steeredMessages ?? [],
        { inProgress: false },
      );
      persistInterruptedTurn(ctx, capturedSessionId, partial);
    }

    // Process the message queue FIRST so the client clears queued visual state
    // immediately, before the (potentially slow) post-turn git commit work.
    // Idempotent — `agent_result` above may already have triggered the drain,
    // in which case this is a no-op (and `runner.running` may have been re-set
    // to true by the new turn, which `tryPostTurnDrain` deliberately leaves
    // alone via its early-return).
    await tryPostTurnDrain();

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
          runner,
        });
      }
    } catch (err) {
      console.error("[git] auto-commit failed:", getErrorMessage(err));
    }

    // Emit PR lifecycle card after commit (docs/149 — shared helper, identical
    // to the streaming branch above).
    if (commitHash && capturedSessionId && capturedSessionDir) {
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
        sessionId: capturedSessionId,
        sessionDir: capturedSessionDir,
        commitHash,
        emit: emitDone,
      });
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

  // Assemble the prompt from the user text plus optional file/image context.
  // The slash-command-aware ordering lives in `assembleAgentPrompt`.
  const activeDir = ctx.getActiveDir();
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  // Save images to the host uploads directory and reference them in the prompt.
  // This avoids sending large base64 payloads over HTTP to the session worker.
  const imageContext =
    images && images.length > 0 && activeDir ? saveImagesToUploadsDir(images, activeDir) : "";

  const prompt = assembleAgentPrompt({ userText, fileContext, imageContext });

  // docs/149 — env prep (cred provisioning, OAuth sync-in, MCP refresh,
  // agent-env push) is now factored into a single idempotent helper. The
  // helper subsumes the previous inline blocks at lines 798–833 and the
  // first-turn `agentPinned` flip.
  if (capturedSessionId) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: capturedSessionId,
      agentId: currentAgent.agentId,
      deps: {
        credentialsDir: ctx.credentialsDir,
        credentialStore: ctx.credentialStore,
        sessionManager: ctx.sessionManager,
        providerAccountManager: ctx.providerAccountManager,
      },
    });
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
    // docs/149 — assemble the full AgentRunParams via the shared helper so
    // the WS path and the system-turn path produce identical shapes (system
    // prompt, managed-settings, model, MCP, autoCreatePr).
    const runParams = await buildAgentRunParams({
      deps: {
        credentialStore: ctx.credentialStore,
        githubAuthManager: ctx.githubAuthManager,
        sessionManager: ctx.sessionManager,
        readSystemPrompt: ctx.readSystemPrompt,
        getSelectedModel: ctx.getSelectedModel,
      },
      sessionId: capturedSessionId ?? "",
      agentId: currentAgent.agentId,
      prompt,
      sessionDir: activeDir,
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
    });
    currentAgent.run({ ...runParams, useStreaming });
  }
  // "Agent process started" is now emitted from agent-listeners.ts
  // when the agent_init event arrives, so the log reflects an actual
  // successful start (worker accepted /agent/start) rather than every
  // attempt — duplicates rejected by the worker no longer pollute the
  // per-session log ring.
}
