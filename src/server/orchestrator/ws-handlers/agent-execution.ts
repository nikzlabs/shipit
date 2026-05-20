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

  // Helper: emit to all viewers via runner, or fall back to ctx.send
  const emitDone = (msg: WsServerMessage) => {
    if (runner) {
      runner.emitMessage(msg);
    } else {
      ctx.send(msg);
    }
  };

  wireAgentListeners(ctx, currentAgent, {
    isNewSession,
    persistUserMessage,
    fallbackTitle: userText.slice(0, 80) || "New session",
    capturedSessionId,
    onError: () => drainNextQueuedMessage(ctx, runner, capturedSessionId, capturedSessionDir, emitDone),
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
    }
  });

  // Preview URL — compose services are accessed via the preview proxy
  const previewUrl: string | undefined = undefined;

  // Auto-create-PR gate: drives both the system-prompt nudge and the Stop-hook
  // enforcement that lives in the session container at
  // /etc/shipit/managed-settings.json. Single source of truth — the harness
  // fallback in post-turn.ts uses the same predicate.
  const autoCreatePrActive = ctx.credentialStore.getAutoCreatePr()
    && ctx.githubAuthManager.authenticated;

  // Build the system prompt, incorporating agent system instructions and conversation replay.
  // The auto-create-PR nudge is gated on the same `autoCreatePr` setting that drives the
  // harness-side fallback in post-turn.ts — so users who turn off auto-PR don't get the
  // prompt either. See docs/116-fake-gh-cli-shim/plan.md (Phase 2).
  const agentInstructions = ctx.credentialStore.getAgentSystemInstructionsEnabled()
    ? buildAgentSystemInstructions({
        previewUrl,
        autoCreatePr: autoCreatePrActive,
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
  if (runner instanceof ContainerSessionRunner) {
    await runner.tryPushAgentSecrets(
      selectAgentEnvForPush({
        serviceManager: runner.serviceManager,
        credentialStore: ctx.credentialStore,
      }),
    );
  }

  currentAgent.run({
    prompt,
    sessionId: agentSessionId,
    systemPrompt,
    cwd: activeDir,
    permissionMode,
    previewUrl,
    model: ctx.getSelectedModel(),
    settingsPath,
    autoCreatePr: autoCreatePrActive,
    mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
  });
  // "Agent process started" is now emitted from agent-listeners.ts
  // when the agent_init event arrives, so the log reflects an actual
  // successful start (worker accepted /agent/start) rather than every
  // attempt — duplicates rejected by the worker no longer pollute the
  // per-session log ring.
}
