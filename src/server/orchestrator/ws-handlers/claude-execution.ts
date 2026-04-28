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
/**
 * Save base64 images to the session's uploads directory on the host.
 * Returns a prompt prefix referencing the saved files (container paths).
 * The agent reads them with the Read tool, which natively supports images.
 */
function saveImagesToUploadsDir(images: ImageAttachment[], workspaceDir: string): string {
  const uploadsDir = path.join(path.dirname(workspaceDir), "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const containerPaths: string[] = [];
  for (const img of images) {
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
  /** Original upload paths consumed by this message (for sent-state tracking on reload). */
  uploadPaths?: string[];
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

  // Reset turn-scoped state directly on the runner.
  if (runner) {
    runner.clearTurnEventBuffer();
    runner.turnSummary = "";
    runner.accumulatedText = "";
    runner.accumulatedToolUse = [];
    runner.chatMessageGroups = [];
    runner.needsNewMessageGroup = true;
    runner.wasInterrupted = false;
  }
  let receivedResult = false;
  const currentAgent = ctx.agentFactory(ctx.getActiveAgentId());
  if (runner) runner.setAgent(currentAgent);

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
      uploadPaths: uploadPaths && uploadPaths.length > 0 ? uploadPaths : undefined,
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

    // Process the message queue FIRST so the client clears queued visual state
    // immediately, before the (potentially slow) post-turn git commit work.
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
        dequeued: next.text,
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
          // Use the captured runner directly — ctx.setIsClaudeRunning() goes
          // through `attachedRunner` which is null after WS disconnect, which
          // would strand `running=true` and prevent future cleanup.
          if (runner) runner.running = false;
          return;
        }
        nextValidatedFiles = fileResult.files;
      }
      // Resolve upload refs for the queued message — image uploads become ImageAttachments
      let allNextImages = nextImages;
      const nextUploadRefs = next.uploads && next.uploads.length > 0 ? next.uploads : undefined;
      if (nextUploadRefs) {
        const dir = capturedSessionDir ?? ctx.workspaceDir;
        const uploadResult = await resolveUploadRefs(nextUploadRefs, dir);
        if (uploadResult.error) {
          emitDone({ type: "error", message: uploadResult.error });
          // Use the captured runner directly — see comment above.
          if (runner) runner.running = false;
          return;
        }
        nextValidatedFiles = [...nextValidatedFiles, ...uploadResult.files];
        if (uploadResult.images.length > 0) {
          allNextImages = [...(allNextImages ?? []), ...uploadResult.images];
          for (const p of uploadResult.imageHostPaths) {
            fs.promises.unlink(p).catch(() => {});
          }
        }
      }
      const nextSession = capturedSessionId
        ? ctx.sessionManager.get(capturedSessionId)
        : undefined;
      try {
        await runClaudeWithMessage(ctx, {
          userText: next.text,
          images: allNextImages,
          validatedFiles: nextValidatedFiles,
          agentSessionId: nextSession?.agentSessionId,
          permissionMode: next.permissionMode,
          isNewSession: false,
          uploadPaths: nextUploadRefs?.map((u) => u.path),
        });
      } catch (err) {
        console.error("[queue] Error processing queued message:", getErrorMessage(err));
        if (runner) runner.running = false;
      }
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
            // No PR yet — check if auto-create PR is enabled for new sessions
            const shouldAutoCreate = isNewSession
              && ctx.credentialStore.getAutoCreatePr()
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
    }
  });

  // Preview URL — compose services are accessed via the preview proxy
  const previewUrl: string | undefined = undefined;

  // Build the system prompt, incorporating agent system instructions and conversation replay
  const agentInstructions = ctx.credentialStore.getAgentSystemInstructionsEnabled()
    ? buildAgentSystemInstructions(previewUrl)
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
  // Prepend file context to the prompt if files are attached
  let prompt = userText;
  if (validatedFiles.length > 0) {
    const context = formatFileContext(validatedFiles);
    prompt = `${context}\n\n${prompt}`;
  }

  // Save images to the host uploads directory and reference them in the prompt.
  // This avoids sending large base64 payloads over HTTP to the session worker.
  const activeDir = ctx.getActiveDir();
  if (images && images.length > 0 && activeDir) {
    const imageContext = saveImagesToUploadsDir(images, activeDir);
    prompt = `${imageContext}\n\n${prompt}`;
  }

  currentAgent.run({
    prompt,
    sessionId: agentSessionId,
    systemPrompt,
    cwd: activeDir,
    permissionMode,
    previewUrl,
    model: ctx.getSelectedModel(),
  });
  ctx.broadcastLog("server", "Agent process started");
}
