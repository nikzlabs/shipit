import fs from "node:fs/promises";
import type { WsClientMessage, ImageAttachment, FileAttachment, FileContextRef, UploadRef } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { validateImages, imageAttachmentRefusal, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { modelSelectionOf } from "../session-agent-env.js";
import { graduateSession } from "../services/graduate-session.js";
import { pinIssueSeededSession } from "../services/issue-seeded-session.js";
import { markIssueStartedFromSeed } from "../issue-lifecycle.js";
import { recordSteeredMessage, persistTurnInProgress } from "./agent-listeners.js";
import { runAgentWithMessage, saveImagesToUploadsDir, assembleAgentPrompt } from "./agent-execution.js";
import { resolveRunner } from "./resolve-runner.js";
import { shouldSteerMessage } from "../dispatch-steering.js";
import { resetSubAgentSpawnBudget } from "../session-runner.js";
import { settleNetworkModeWrites } from "../services/network-mode-writes.js";
import { prepareDispatch } from "../prepared-dispatch.js";
import { agentAdmissionError } from "../services/agent-auth-gate.js";
import { imageHash, imageUrl } from "../transcript-projection.js";

// Re-export all public symbols from sub-modules for backwards compatibility
export { CONTEXT_WINDOW_TOKENS, wireAgentListeners, extractToolResults } from "./agent-listeners.js";
export { runAgentWithMessage } from "./agent-execution.js";
export { postTurnCommit } from "./post-turn.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type FullCtx = ConnectionCtx & RunnerCtx & AppCtx;

type WsSendMessage = Extract<WsClientMessage, { type: "send_message" }>;
type WsAnswerQuestion = Extract<WsClientMessage, { type: "answer_question" }>;

/**
 * docs/178 §4 — recognize the `/compact` composer command, with optional
 * custom-compaction args (`/compact <instructions>`, which Claude's CLI
 * honors). Matches a leading `/compact` token only (so `/compactfoo` is not a
 * match). Returns the trimmed instructions when present. Recognizing the arg
 * form matters for correctness, not just Claude parity: without it a
 * `/compact <args>` on Codex would fall through and be sent as a literal
 * `turn/start` prompt — a no-op — instead of routing to its compaction RPC.
 */
function parseCompactCommand(text: string): { match: boolean; instructions?: string } {
  const m = /^\/compact(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!m) return { match: false };
  const instructions = m[1]?.trim();
  return instructions ? { match: true, instructions } : { match: true };
}

function ensureActiveAgentAuthenticated(ctx: FullCtx): boolean {
  const activeAgentId = ctx.getActiveAgentId();

  // docs/150 — AgentRegistry's auth check is backed by ProviderAccountManager,
  // so it sees every connected subscription account. The former Claude-only
  // gate consulted the legacy singleton AuthManager and rejected a turn before
  // routing whenever the usable credential lived in an added account row.
  // docs/252 phase 9 — `agentAdmissionError` also refuses a harness this
  // deployment did not install, which is the only gate the effective-agent paths
  // (a pre-existing pin, a stale browser selection, Quick Capture) all pass
  // through.
  const refusal = agentAdmissionError(ctx.agentRegistry, activeAgentId);
  if (refusal) {
    ctx.send({ type: "error", message: refusal });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Exported handlers
// ---------------------------------------------------------------------------

export async function handleSendMessage(
  ctx: FullCtx,
  msg: WsSendMessage,
): Promise<void> {
  // Check auth before spawning — some CLIs hang if not authenticated.
  if (!ensureActiveAgentAuthenticated(ctx)) return;

  // docs/178 — `/compact` interception. When the active agent supports
  // compaction, route the command to the agent's compaction trigger instead of
  // sending the literal text to the model: a fresh spawn runs `run({ compact:
  // true })` (Claude → `claude -p "/compact"`; Codex → `thread/compact/start`),
  // and a live in-flight turn injects via `agent.compact()`. Gated on the
  // capability so an unsupported backend just sends the text (and the `/`
  // autocomplete never offered it anyway).
  const compactCapable =
    ctx.agentRegistry.get(ctx.getActiveAgentId())?.capabilities.supportsCompaction ?? false;
  const compactParsed = parseCompactCommand(msg.text);
  const isCompactRequest = compactParsed.match && compactCapable;

  // Validate images if provided (do this before queue check so we reject bad images immediately)
  const images: ImageAttachment[] | undefined = msg.images && msg.images.length > 0 ? msg.images : undefined;
  if (images) {
    const imageError = validateImages(images);
    if (imageError) {
      ctx.send({ type: "error", message: imageError });
      return;
    }
  }

  // planning#460 — refuse an image outright when this session is pinned to a
  // model the catalogue knows is text-only, before a turn is spent going blind.
  // Placed beside `validateImages` deliberately: the same "reject a bad
  // attachment immediately" moment, ahead of the queue check, steering and every
  // disk read. `msg.uploads` is checked too — that, not `images`, is the shape
  // the browser composer sends.
  //
  // `msg.sessionId ?? getActiveAppSessionId()` is the SAME target the handler
  // resolves further down as `effectiveSessionId`, and asking it twice with two
  // rules is how a frame explicitly aimed at session B gets admitted against
  // session A's model — which could refuse a vision-capable target because the
  // connection's own session happens to be text-only. A wrong refusal is the one
  // outcome this design must never produce.
  const targetSessionId = msg.sessionId ?? ctx.getActiveAppSessionId();
  const targetSession = targetSessionId ? ctx.sessionManager.get(targetSessionId) : undefined;
  const visionRefusal = imageAttachmentRefusal(
    targetSession ? modelSelectionOf(targetSession) : undefined,
    images,
    msg.uploads,
  );
  if (visionRefusal) {
    ctx.send({ type: "error", message: visionRefusal });
    return;
  }

  // If Claude is already processing, queue this message and return.
  // Resolve runner via registry — survives WS disconnect.
  const runnerForQueue = resolveRunner(ctx);
  // docs/243 — interactive paths preflight through the exact same runner-owned
  // admission used by dispatch(), before steering, attachment reads, warm
  // graduation, persistence, or process mutation.
  if (runnerForQueue) runnerForQueue.assertCanDispatch();
  // planning#338 — `systemTurnInProgress` counts as busy even while `running` is
  // false: a system FLOW (the rebase driver) holds the session between its own
  // turns — the executor clears `running` at `agent_result`, and the driver
  // keeps running git (stage / `rebase --continue` / force-push) after each
  // resolution turn settles. A message started in that gap displaced the
  // resolution agent's slot in production and stranded the workspace
  // mid-rebase. The dispatch fall-through below enqueues it instead; the flow
  // releases the queue when it settles.
  // docs/288 req 6 — a `gh pr merge --auto` request being carried out counts as
  // busy for the same reason: this turn would push behind a merge already in
  // flight. The executor clears the hold and calls `releaseQueuedTurn`, which is
  // what starts the message queued here.
  const heldByMerge = runnerForQueue?.mergeHold === true;
  if (runnerForQueue?.running || runnerForQueue?.systemTurnInProgress || heldByMerge) {
    // Verify with the worker that an agent is actually running. The local
    // `running` flag can get stranded `true` if the orchestrator missed a
    // terminal SSE event (drop mid-turn, container restart, /agent/kill
    // race). Without this check, the new message would be queued forever
    // and the user sees: "agent starts briefly, nothing happens".
    // Skipped under a merge hold: the executor took it only because the session
    // was idle, so there is no phantom turn to recover, and the recovery's own
    // `releaseQueuedTurn` refuses under the hold anyway.
    const actuallyRunning = heldByMerge ? false : await runnerForQueue.verifyRunningState();
    // planning#282 — the recovery inside `verifyRunningState` may have released a
    // queue entry the phantom turn was blocking, which claims the runner
    // synchronously. Re-read `running` rather than trusting the return value, or
    // this message falls through and spawns a second agent against the one the
    // released turn is already starting — the two-paths-one-`_agent`-slot race
    // that produced the phantom turn in the first place. Re-entering the block
    // queues this message behind the entry that was there first (steering and
    // `/compact` both fall through to the queue: the released turn has no
    // resident streaming process yet).
    if (
      actuallyRunning || runnerForQueue.running || runnerForQueue.systemTurnInProgress
      || runnerForQueue.mergeHold
    ) {
      // docs/178 — `/compact` while a turn is in flight: trigger compaction on
      // the resident live process (streaming Claude injects `/compact`; live
      // Codex sends `thread/compact/start`) rather than queuing the literal text.
      // The compaction events (started → card) flow through the active turn's
      // listeners. If there's no resident agent, fall through to the normal
      // queue path. compact() is a best-effort no-op when the resident process
      // can't compact (e.g. a one-shot PTY mid-turn).
      if (isCompactRequest) {
        const compactAgent = runnerForQueue.getAgent();
        if (compactAgent?.compact) {
          compactAgent.compact(compactParsed.instructions);
          const compactSessionId = ctx.getActiveAppSessionId();
          if (compactSessionId) {
            runnerForQueue.emitMessage({
              type: "compaction_status",
              sessionId: compactSessionId,
              active: true,
              trigger: "manual",
            });
          }
        }
        return;
      }
      // Live steering: inject the message mid-turn if capability + setting active.
      //
      // docs/140 — also require `runner.isStreamingActive`. `supportsSteering` is
      // a static fact about the adapter (Claude can stream), but the currently-
      // resident process may not actually be a `StreamingClaudeProcess` (e.g.
      // the agent spawned while the toggle was off and the user flipped it on
      // mid-turn — see plan §"Post-stabilization cleanup"). Without this gate
      // we'd call `sendUserMessage` on a one-shot PTY `ClaudeProcess` whose
      // adapter silently no-ops, and the steer would vanish.
      const agentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
      const steeringCapable = agentInfo?.capabilities.supportsSteering ?? false;
      const liveSteering = ctx.credentialStore.getLiveSteering();
      const streamingActive = runnerForQueue.isStreamingActive;
      // docs/146 — suppress live steering when a system-driven turn is in
      // flight (auto-resolve rebase-resolution turn, etc.). Steering an
      // unrelated user message into the conflict-resolution prompt would
      // derail the agent; the message lands in the queue instead and drains
      // when the system turn finishes (the rebase-driver's drain hook).
      const systemTurnInProgress = runnerForQueue.systemTurnInProgress;

      // docs/163 — single shared steer-or-queue predicate. The dispatch path
      // (`runner.dispatch` → `trySteerDispatch`) consults the identical
      // `shouldSteerMessage` so the WS and programmatic paths can't diverge.
      if (shouldSteerMessage({
        steeringCapable,
        liveSteering,
        streamingActive,
        systemTurnInProgress,
      })) {
        // Steer the running agent — inject message mid-turn
        const steeringAgent = runnerForQueue.getAgent();
        // docs/140 diag — pin the gate state at the moment of steer dispatch.
        // If a future repro shows "message appears in chat, agent doesn't
        // react", check this log: streamingActive=false means the gate
        // upstream (this.gate or agentInfo) was lying; agent=null means we
        // tried to steer with no resident process; both fall through to the
        // queue branch below today.
        console.log(
          `[steer-send] runner=${runnerForQueue.sessionId} steeringCapable=${steeringCapable} liveSteering=${liveSteering} streamingActive=${streamingActive} agent=${steeringAgent ? "yes" : "null"} text=${JSON.stringify(msg.text.slice(0, 80))}`,
        );
        if (steeringAgent) {
          const capturedSessionId = ctx.getActiveAppSessionId();

          // Resolve uploads + files now so the steered message can carry the
          // same attachment context a fresh turn would. Without this, attached
          // images never reach the agent (only `msg.text` would be injected)
          // and never reach chat history (the steered bubble would reload as
          // text-only after a session switch).
          const steerDir = ctx.getActiveSessionDir() ?? ctx.workspaceDir;
          let steerFiles: FileAttachment[] = [];
          if (msg.files && msg.files.length > 0) {
            const result = await resolveFileAttachments(msg.files, steerDir);
            if (result.error) {
              ctx.send({ type: "error", message: result.error });
              return;
            }
            steerFiles = result.files;
          }
          let steerImages: ImageAttachment[] | undefined = images;
          if (msg.uploads && msg.uploads.length > 0) {
            const uploadResult = await resolveUploadRefs(msg.uploads, steerDir);
            if (uploadResult.error) {
              ctx.send({ type: "error", message: uploadResult.error });
              return;
            }
            steerFiles = [...steerFiles, ...uploadResult.files];
            if (uploadResult.images.length > 0) {
              steerImages = [...(steerImages ?? []), ...uploadResult.images];
            }
          }
          const steerUploadPaths = msg.uploads && msg.uploads.length > 0
            ? msg.uploads.map((u) => u.path)
            : undefined;

          // Same prompt assembly as runAgentWithMessage: save images to
          // /uploads/, reference them as a text block, then prepend file +
          // image context to the user text (or append for slash invocations).
          // The model reads each `/uploads/...` path with its Read tool.
          const fileContext = steerFiles.length > 0 ? formatFileContext(steerFiles) : "";
          const imageContext = steerImages && steerImages.length > 0
            ? saveImagesToUploadsDir(steerImages, steerDir)
            : "";
          const steerPrompt = assembleAgentPrompt({
            userText: msg.text,
            fileContext,
            imageContext,
            // docs/144 — a dictated message steered into a running turn needs
            // the transcription hint just as much as one that starts a turn.
            dictated: msg.dictated,
          });
          // docs/138 + docs/140 — the streaming CLI keeps its spawn-time
          // `--permission-mode` for life, so a steered message inherits plan
          // mode unless we push a `set_permission_mode` control_request first.
          // This mirrors turn-executor's reuseExistingAgent branch: it's the
          // path that lets "Accept & Execute" actually leave plan mode while
          // live steering is on (the approval is steered into the running
          // turn, never through executeAgentTurn). `undefined` is honored too
          // (toggling back to the CLI's no-flag "auto" default). Skip the push
          // when the mode already matches so we don't spam redundant requests.
          if (
            runnerForQueue.appliedPermissionMode !== msg.permissionMode &&
            steeringAgent.setPermissionMode
          ) {
            steeringAgent.setPermissionMode(msg.permissionMode);
            runnerForQueue.appliedPermissionMode = msg.permissionMode;
          }
          steeringAgent.sendUserMessage(steerPrompt);

          // docs/144 — a steered message is a NEW human instruction, so it
          // refills the sub-agent spawn budget the way starting a turn does.
          //
          // Without this the budget has no refill point on this path at all:
          // steering deliberately does not start an orchestrator turn, so
          // `resetRunnerTurnState` never runs, and every message the user types
          // while the agent is mid-turn keeps drawing on the budget of whichever
          // turn happened to be running. A session where the agent is usually
          // busy — the ordinary shape once it backgrounds consults, which is
          // exactly what ShipIt's guidance tells it to do — then exhausts the
          // cap and refuses every later `shipit agent run` with "cap reached for
          // this turn", on a turn the user experiences as brand new.
          //
          // Only the budget is refilled, never `resetRunnerTurnState`: clearing
          // the accumulator mid-turn would destroy the running turn's chat
          // history (docs/237).
          //
          // The trigger is deliberately a WS message from a browser client — a
          // human keystroke, which no agent can emit — so this cannot weaken the
          // forgery-resistant fan-out bound (docs/144 §5). Programmatic steers
          // (`trySteerDispatch`: parent→child messages, agent-interface pages,
          // CI) are agent-reachable and deliberately do NOT refill.
          resetSubAgentSpawnBudget(runnerForQueue);

          // Shapes match PersistedMessage so the same payload feeds chat
          // history persistence and the message_steered broadcast.
          const historyImages = steerImages?.map((img) => ({
            data: img.data,
            mediaType: img.mediaType,
          }));
          const historyFiles = steerFiles.length > 0
            ? steerFiles.map((f) => ({
                path: f.path,
                contentPreview: f.content.slice(0, 200),
                startLine: f.startLine,
                endLine: f.endLine,
              }))
            : undefined;

          // Persist the steered message to chat history. Anchor it after the
          // assistant groups that exist *now* and fold it into the in-progress
          // set, so on reload it stays at the spot the user sent it instead of
          // collapsing up next to the turn's first user message (docs/140).
          if (capturedSessionId) {
            recordSteeredMessage(runnerForQueue, msg.text, {
              images: historyImages,
              files: historyFiles,
              uploadPaths: steerUploadPaths,
              // docs/140 — the CLI echoes this exact prompt; storing it lets the
              // delivery-ack matcher confirm the steer landed, and lets a steer
              // that fell into the turn-end gap be re-queued instead of lost.
              assembledPrompt: steerPrompt,
            });
            persistTurnInProgress(ctx.chatHistoryManager, runnerForQueue, capturedSessionId);
          }
          // Broadcast message_steered so all viewers (including other tabs) see it.
          //
          // docs/244 / planning#299 — the echo goes out projected: base64 payloads are
          // replaced by the same `/images/:hash` URLs `projectMessagesForWire`
          // builds, so a steered screenshot doesn't cross the wire twice (once
          // here, once on every later history load). Safe by ordering rather than
          // by assumption — `recordSteeredMessage` + `persistTurnInProgress`
          // above have already written the row this URL resolves against, which
          // is the invariant every strip in this feature turns on.
          if (capturedSessionId) {
            runnerForQueue.emitMessage({
              type: "message_steered",
              text: msg.text,
              sessionId: capturedSessionId,
              images: historyImages?.map((img) => ({
                mediaType: img.mediaType,
                src: imageUrl(capturedSessionId, imageHash(img.data)),
              })),
              files: historyFiles,
              uploadPaths: steerUploadPaths,
            });
          }
          return;
        }
      }

      // Not steering (or no active agent ref): delegate to runner.dispatch
      // (docs/150). The runner owns the send-or-queue rule; here we're in
      // the "running" branch so dispatch will enqueue and broadcast
      // message_queued via runner.emitMessage (every attached viewer sees
      // it, not just this socket).
      runnerForQueue.dispatch(prepareDispatch({
        text: msg.text,
        agentInterface: undefined,
        // planning#257 — a user-typed message: when this queues behind the running
        // turn, the drain must reproduce an INTERACTIVE turn (the client already
        // rendered an optimistic bubble, so the dispatched executor's
        // `system_user_message` echo would double it).
        execution: "interactive",
        images: msg.images,
        files: msg.files,
        uploads: msg.uploads,
        permissionMode: msg.permissionMode,
        activity: undefined,
        postTurn: undefined,
        systemTurn: undefined,
        onTurnComplete: undefined,
        deliveryId: undefined,
        // docs/144 — rides the queue so the hint survives the drain.
        dictated: msg.dictated,
      }));
      return;
    }
    // Worker reports no agent — verifyRunningState already reset the flag
    // and emitted a recovery `session_status`. Fall through to start a new
    // turn for this message.
  }

  // Kill any stale process (safety net — normally null if not running).
  //
  // docs/140 — EXCEPT for persistent streaming agents (live steering): the
  // runner intentionally keeps its agent reference across turns so the next
  // top-level turn can carry its message in via `sendUserMessage` (the
  // `existingAgent` reuse branch in `runAgentWithMessage`). Killing it here
  // would tear down the process the next turn is about to talk to and force
  // the new send back through the 409 → `/agent/kill` → SIGTERM recovery
  // path. Crash / error / auth paths in `agent-listeners.ts` still clear
  // the ref, so a genuinely stale ref here can only appear when streaming
  // is off.
  const staleAgent = runnerForQueue?.getAgent() ?? null;
  if (staleAgent) {
    const staleAgentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
    // docs/140 — also require `runner.isStreamingActive` so we don't preserve a
    // resident non-streaming agent under a steering-capable adapter (which would
    // strand a one-shot PTY process the next turn can't talk to via NDJSON).
    const persistentStreaming = (staleAgentInfo?.capabilities.supportsSteering ?? false)
      && ctx.credentialStore.getLiveSteering()
      && (runnerForQueue?.isStreamingActive ?? false);
    if (!persistentStreaming) {
      staleAgent.kill();
    }
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
    // docs/285 — wait out an in-flight network-mode write for this session.
    //
    // Changing an ungraduated session's mode REBUILDS its container, and the
    // composer that issued the write is barred for its duration — but another
    // viewer's composer is not, because it only learns of the change from the
    // invalidation broadcast at the end. Without this, that viewer sends the
    // session's first message into the container being torn down.
    //
    // An await, deliberately not a claim. A claim marks the session busy, which
    // sends the losing message to a queue that nothing drains; waiting costs the
    // losing Send the rebuild's duration and then lets it proceed normally. It
    // cannot deadlock — the write never waits on a turn — and it costs one map
    // lookup when nothing is in flight, which is almost always.
    await settleNetworkModeWrites(effectiveSessionId);
    await ctx.activateSession(effectiveSessionId);
    const session = ctx.sessionManager.get(effectiveSessionId);
    // Only resume if we have a real Claude CLI session ID
    agentSessionId = session?.agentSessionId;

    // Graduate warm session on first message.
    // graduate-session.ts owns the warm → active transition (docs/156). Do
    // not inline setWarm / track / setBranchRenamed / scheduleSessionNaming /
    // repoStore.touch / sseBroadcast("session_list") here.
    if (session?.warm) {
      // planning#322 — this message is the first one of a session the Issues tab
      // started from an issue, so the issue reaches ShipIt here rather than at
      // creation. Pin the branch to the pointer (docs/248-declared-issue-trackers req 22) BEFORE
      // graduating: the pins are what stop AI naming from deriving a branch
      // slug from this very text, which opens with the issue's title.
      const issuePins = msg.issueRef
        ? await pinIssueSeededSession(
          { sessionManager: ctx.sessionManager, createGitManager: ctx.createGitManager },
          effectiveSessionId,
          msg.issueRef,
        )
        : undefined;

      graduateSession(
        {
          sessionManager: ctx.sessionManager,
          runnerRegistry: ctx.getRunnerRegistry(),
          repoStore: ctx.repoStore,
          createGitManager: ctx.createGitManager,
          prStatusPoller: ctx.prStatusPoller,
          sseBroadcast: ctx.sseBroadcast,
          ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
          // docs/150 — AI naming runs on the account a turn would use.
          ...(ctx.providerAccountManager ? { providerAccountManager: ctx.providerAccountManager } : {}),
          ...(ctx.credentialsDir ? { credentialsDir: ctx.credentialsDir } : {}),
          // docs/252 phase 7 (req 9) — naming's own model, its usage row, and
          // the durable failure notice.
          credentialStore: ctx.credentialStore,
          chatHistoryManager: ctx.chatHistoryManager,
          usageManager: ctx.usageManager,
        },
        {
          sessionId: effectiveSessionId,
          userText,
          agentId: session.agentId ?? ctx.getActiveAgentId(),
          ...(issuePins ? { explicitBranch: issuePins.branch, explicitTitle: issuePins.title } : {}),
        },
      );

      // planning#322 / docs/194 — seed path → started. The headless route fires this
      // at creation from the same pointer; the in-app path's "creation" is this
      // first message, so it fires here. Fire-and-forget and fully best-effort:
      // a tracker that isn't connected must never delay or fail the turn.
      if (msg.issueRef) {
        void markIssueStartedFromSeed(
          {
            credentialStore: ctx.credentialStore,
            ...(ctx.trackerFetchImpl ? { trackerFetchImpl: ctx.trackerFetchImpl } : {}),
            githubAuthManager: ctx.githubAuthManager,
            sessionManager: ctx.sessionManager,
            chatHistoryManager: ctx.chatHistoryManager,
            runnerRegistry: ctx.getRunnerRegistry(),
          },
          effectiveSessionId,
          msg.issueRef,
        ).catch((err: unknown) => {
          console.warn("[send-message] seed 'started' failed:", err);
        });
      }

      // Warm-graduation is the only surface that doesn't reach graduation via
      // `claimSessionService.claim`, so the warm pool's single warm clone was
      // just consumed but no one re-warmed it. Refill inline. The other three
      // surfaces inherit re-warming from `claim-session.ts:rewarmPool`.
      if (session.remoteUrl) {
        void ctx.warmSessionForRepo(session.remoteUrl);
      }
    }

    // If a session has a workspaceDir but its on-disk clone was deleted, we
    // can't recreate it here (the clone holds the session's branch + commits).
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
    ...(msg.userReview ? { userReview: msg.userReview } : {}),
    ...(msg.resetMergedBranch !== undefined ? { resetMergedBranch: msg.resetMergedBranch } : {}),
    ...(msg.dictated ? { dictated: true } : {}),
    compact: isCompactRequest,
    // Echo the message to every attached viewer. The sending tab dedupes on its
    // own `requestId`; a second tab (or the desktop, while this arrived from the
    // user's phone) has no optimistic bubble and needs the echo to render the
    // message at all.
    userEcho: { ...(msg.requestId ? { clientRequestId: msg.requestId } : {}) },
  });
}

export async function handleAnswerQuestion(ctx: FullCtx, msg: WsAnswerQuestion): Promise<void> {
  // Prefer the client-formatted text (unambiguous when answers contain
  // commas) and fall back to joining the answers map for older clients
  // that predate the `text` field.
  const answerText = msg.text?.trim()
    ? msg.text
    : Object.values(msg.answers).join(", ");

  if (!answerText.trim()) {
    ctx.send({ type: "error", message: "Answer cannot be empty" });
    return;
  }

  // An AskUserQuestion answer is, by construction, the *next turn* of a session
  // whose previous turn already ended: the agent emitted the tool_use, the
  // orchestrator interrupted it (`agent.interrupt()` in agent-listeners.ts),
  // and the resulting `agent_result` flipped `running=false`. So the answer is
  // handled exactly like a normal user message — delegate to
  // `runAgentWithMessage`, which owns the canonical turn machinery:
  // `resetRunnerTurnState`, `existingAgent.removeAllListeners()` before
  // re-wiring, and a fresh `streamingPostTurnFired` closure.
  //
  // The previous implementation hand-rolled a steering branch that called
  // `existingAgent.sendUserMessage(answerText)` directly, bypassing all of
  // that. Because the interrupted turn's listeners stayed attached, the
  // answered turn's `agent_result` hit the *previous* turn's
  // `streamingPostTurnFired` guard (already `true`) and short-circuited —
  // skipping the queue drain, auto-commit, PR card, and
  // `session_agent_finished`. Symptom: "the answer pastes into chat but the
  // agent never starts." Routing through `runAgentWithMessage` makes the reset
  // + re-wire unconditional, which is the fix.
  const runnerEarly = resolveRunner(ctx);
  if (runnerEarly) runnerEarly.assertCanDispatch();

  // docs/288 req 6 — a FOURTH turn-start path, and the one most easily missed:
  // this handler does not go through `dispatch`, it sets `running = true` and
  // calls `runAgentWithMessage` itself. An answer arriving while ShipIt is
  // merging would start a turn that pushes behind a merge in flight. Queue it
  // through `dispatch`, which is what the hold makes enqueue; the executor's
  // `releaseQueuedTurn` starts it when the merge is done.
  if (runnerEarly?.mergeHold) {
    runnerEarly.dispatch(prepareDispatch({
      text: answerText,
      agentInterface: undefined,
      execution: "interactive",
      images: undefined,
      files: undefined,
      uploads: undefined,
      permissionMode: undefined,
      activity: undefined,
      postTurn: undefined,
      systemTurn: undefined,
      onTurnComplete: undefined,
      deliveryId: undefined,
      dictated: msg.dictated,
    }));
    return;
  }

  // planning#338 — while a system flow (rebase resolution, CI fix) holds the
  // session, the resident agent is the flow's own turn. The stale-kill below
  // would classify it non-reusable (`!systemTurnInProgress` in the
  // persistent-streaming gate), kill it, and clear its slot — the awaited
  // resolution turn then never settles and the flow's hold wedges the session.
  // A pending question can only be stale here (a system turn's AskUserQuestion
  // interrupt settles the turn — and clears this flag — before the card is
  // answerable), so refuse rather than queue an answer to a question the next
  // turn won't be asking.
  if (runnerEarly?.systemTurnInProgress) {
    ctx.send({
      type: "error",
      message: "The agent is busy with a system operation (rebase or CI fix). Try again once it finishes.",
    });
    return;
  }

  // Preserve the session's permission mode across the answer. An AskUserQuestion
  // answer is a fresh `--resume` turn; if we don't re-pin the mode, a session
  // asked a clarifying question *in plan mode* resumes the CLI in default mode
  // and the agent starts implementing — silently exiting plan mode the user
  // never approved (only ExitPlanMode should do that). Prefer the client-sent
  // mode (the chip the user sees), and fall back to the runner's last-applied
  // mode captured NOW — before the stale-kill below calls `setAgent(null)`,
  // which resets `appliedPermissionMode` to undefined.
  const capturedPermissionMode = msg.permissionMode ?? runnerEarly?.appliedPermissionMode;

  // Kill any stale resident agent before the new turn — EXCEPT a persistent
  // streaming agent we can reuse. Mirrors `handleSendMessage`'s stale-kill
  // (docs/140): a steering-capable adapter with `liveSteering` on and a still-
  // streaming process is the one case `runAgentWithMessage` carries the answer
  // in via `sendUserMessage` rather than respawning. `!systemTurnInProgress`
  // preserves the old "don't steer into a system-driven turn" guard (docs/146).
  // Every other resident ref (liveSteering off, a stranded non-streaming
  // process under a steering adapter) must be killed so the delegated turn
  // spawns a fresh `--resume` agent instead of writing to a process that can't
  // receive the message.
  const staleAgent = runnerEarly?.getAgent() ?? null;
  if (staleAgent) {
    const staleAgentInfo = ctx.agentRegistry.get(ctx.getActiveAgentId());
    const persistentStreaming =
      (staleAgentInfo?.capabilities.supportsSteering ?? false) &&
      ctx.credentialStore.getLiveSteering() &&
      (runnerEarly?.isStreamingActive ?? false) &&
      !(runnerEarly?.systemTurnInProgress ?? false);
    if (!persistentStreaming) {
      staleAgent.kill();
      if (runnerEarly?.getAgent() === staleAgent) {
        runnerEarly.setAgent(null);
        runnerEarly.isStreamingActive = false;
        // The AskUserQuestion interrupt already cleared `running`; reset
        // defensively so the duplicate guard below doesn't strand the answer
        // if a race left it true.
        runnerEarly.running = false;
      }
    }
  }

  // Defensive duplicate guard: a still-running runner here means a parallel
  // answer / turn is already in flight (UI double-click, two tabs, or a
  // genuinely-not-interrupted turn). The worker would reject the duplicate
  // /agent/start with 409 anyway, but dropping early avoids a misleading
  // setup flow. After the stale-kill above this only stays true for a reused
  // persistent-streaming agent whose turn really is still active.
  if (runnerEarly?.running) {
    console.warn(
      `[answer_question] Runner ${runnerEarly.sessionId} already running — dropping duplicate answer (text="${answerText.slice(0, 60)}")`,
    );
    return;
  }

  if (!ensureActiveAgentAuthenticated(ctx)) return;

  // Ensure a runner exists for this session and attach to it.
  {
    const answerActiveId = ctx.getActiveAppSessionId();
    const answerActiveDir = ctx.getActiveSessionDir();
    if (answerActiveId && answerActiveDir && !ctx.getRunner()) {
      const registry = ctx.getRunnerRegistry();
      const answerRunner = registry.getOrCreate(answerActiveId, answerActiveDir, ctx.getActiveAgentId());
      ctx.attachToRunner(answerRunner);
    }
  }

  const capturedSessionId = ctx.getActiveAppSessionId();
  const session = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  const agentSessionId = session?.agentSessionId ?? capturedSessionId ?? undefined;

  // `runAgentWithMessage` does not flip `running` or emit `session_status` —
  // its WS callers do (see handleSendMessage). Mark running + announce BEFORE
  // delegating so the chat panel shows "Thinking..." and a reconnecting viewer
  // replays the running state (index.ts gates the replay on `runner.running`).
  const turnRunner = resolveRunner(ctx, capturedSessionId);
  if (turnRunner) turnRunner.running = true;
  if (turnRunner && capturedSessionId) {
    turnRunner.emitMessage({
      type: "session_status",
      sessionId: capturedSessionId,
      running: true,
      queueLength: turnRunner.queueLength,
    });
  }

  await runAgentWithMessage(ctx, {
    userText: answerText,
    validatedFiles: [],
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    ...(capturedPermissionMode !== undefined ? { permissionMode: capturedPermissionMode } : {}),
    // docs/144 — an "Other" answer dictated into the question card is a
    // transcript like any other; the answer IS the next turn's prompt.
    ...(msg.dictated ? { dictated: true } : {}),
    isNewSession: false,
    // Same reason as handleSendMessage: the answering tab rendered the answer
    // bubble optimistically, every other viewer did not.
    userEcho: { ...(msg.requestId ? { clientRequestId: msg.requestId } : {}) },
  });
}
