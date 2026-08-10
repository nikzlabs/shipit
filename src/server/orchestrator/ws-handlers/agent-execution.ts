import type { WsServerMessage, ImageAttachment, FileAttachment, PermissionMode } from "../../shared/types.js";
import type { ConnectionCtx, RunnerCtx, AppCtx } from "./types.js";
import { getErrorMessage, resolveFileAttachments, resolveUploadRefs, formatFileContext } from "../validation.js";
import { buildTurnMessages, type AgentListenerDeps } from "./agent-listeners.js";
import { postTurnCommit } from "./post-turn.js";
import { resolveRunner } from "./resolve-runner.js";
import { emitResetEligible } from "../services/pre-turn-reset.js";
import { applyPreTurnReset, type PreTurnResetHookResult } from "../pre-turn-reset-hook.js";
import { routeVoiceNote } from "../voice/voice-note-router.js";
import type { SessionRunnerInterface, SystemTurnDeps, QueuedMessage } from "../session-runner.js";
import { startQueuedMessage } from "../queue-drain.js";
import {
  prepareSessionAgentEnvironment,
  finalizeSessionAgentEnvironment,
  repushSessionAgentToken,
  selectAgentEnvForPush,
} from "../session-agent-env.js";
import { buildAgentRunParams } from "../session-agent-run-params.js";
import { emitPrLifecycleAfterCommit } from "../services/pr-lifecycle.js";
import { detectAndReArmMergedSession, detectAndReArmResetSession } from "../services/pr-rearm.js";
import { reactToReleaseMarkers } from "../services/release-flow.js";
import { executeAgentTurn } from "../turn-executor.js";
import { releaseResidentOnSpawnChange } from "../resident-spawn-guard.js";
import { desiredSpawnIdentity, residentRouteNeedsRelease } from "../service-routing.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "../prompt-assembly.js";

// docs/149 — re-export so existing `selectAgentEnvForPush` consumers (unit
// tests, secret-resolver coverage) keep their import path working while the
// canonical home moves to `session-agent-env.ts`.
export { selectAgentEnvForPush };

// The prompt-assembly helpers moved to `../prompt-assembly.ts` so the dispatch
// path (`dispatched-turn.ts`) can reuse them without importing this ctx-heavy
// module. Re-exported here for the existing import sites (`send-message.ts`,
// `agent-prompt.test.ts`).
export { saveImagesToUploadsDir, assembleAgentPrompt };

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
 * a message off, and starts the new turn via `startQueuedMessage`.
 *
 * planning#257 — the re-entry below (`runAgentWithMessage`) can only express an
 * INTERACTIVE turn: text, attachments, permission mode. A server-dispatched
 * entry also carries `systemTurn`, `onTurnComplete`, `postTurn`, and `activity`,
 * which this path used to drop on the floor — a docs/196 wake-turn queued behind
 * a user turn ran as an ordinary turn and its merge watch never advanced. So the
 * dequeued entry is routed by `startQueuedMessage`: dispatched entries go back
 * through `runner.runDispatchedTurn` with the full option set, and only
 * interactive ones reach the narrower re-entry here.
 */
export async function drainNextQueuedMessage(
  ctx: FullCtx,
  runner: SessionRunnerInterface | null,
  capturedSessionId: string | undefined,
  capturedSessionDir: string | null | undefined,
  emit: (msg: WsServerMessage) => void,
): Promise<void> {
  if (!runner) return;

  // planning#338 — a system flow (the rebase driver) grabbed the session while this
  // turn's post-turn work was still finishing (the window between `tryDrain`
  // clearing `running` and this drain running is an await on the local commit).
  // Starting a queued turn now would displace the flow's agent slot mid-rebase.
  // Leave the queue alone: the flow's `finally` releases it when it settles.
  // This drain only ever runs off an interactive turn, which never owns the flag.
  if (runner.systemTurnInProgress) return;

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

  await startQueuedMessage(runner, next, (queued) =>
    runQueuedInteractiveMessage(ctx, runner, capturedSessionId, capturedSessionDir, emit, queued),
  ).catch((err: unknown) => {
    console.error("[queue] Error processing queued message:", getErrorMessage(err));
    runner.running = false;
  });
}

/**
 * The WS transport's own queue re-entry: resolve the entry's attachments and
 * start an interactive turn. Reached ONLY for `execution: "interactive"` entries
 * (see `startQueuedMessage`) — a server-dispatched entry would lose its
 * `systemTurn` / `onTurnComplete` here.
 */
async function runQueuedInteractiveMessage(
  ctx: FullCtx,
  runner: SessionRunnerInterface,
  capturedSessionId: string | undefined,
  capturedSessionDir: string | null | undefined,
  emit: (msg: WsServerMessage) => void,
  next: QueuedMessage,
): Promise<void> {
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
      // docs/144 — the hint rode the queue with the message; keep it attached
      // now the message finally becomes a turn.
      ...(next.dictated ? { dictated: true } : {}),
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
   * Set when the turn was started by the "Send comments" action on a file
   * preview. Persisted onto the initiating user row so the bubble rehydrates as
   * a `UserReviewCard` (file list + comment count) instead of degrading to a
   * plain text bubble on reload. The prompt text remains the source of truth.
   */
  userReview?: { filePaths: string[]; commentCount: number };
  /**
   * docs/178 — this turn is a context-compaction request (`/compact`). The
   * prompt is `/compact`; for Claude the CLI honors it as a slash command, and
   * the flag is forwarded to Codex so it issues `thread/compact/start` instead
   * of a normal turn. Set by the `/compact` interception in send-message.ts.
   */
  compact?: boolean;
  /**
   * docs/218 — per-send intent for the auto-reset-merged-branch control. `false`
   * = user unticked it for this message (skip); `true`/undefined = follow the
   * global setting. Non-sticky.
   */
  resetMergedBranch?: boolean;
  /**
   * docs/144 — the user dictated this message by voice, so `userText` is a
   * machine transcription. Adds the `<dictated_input>` context block to the
   * assembled prompt; the persisted user row keeps the verbatim text.
   */
  dictated?: boolean;
}): Promise<void> {
  const { userText, images, validatedFiles, permissionMode, isNewSession, uploadPaths, userReview } = opts;

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
  // docs/260 — a resident streaming process holds its spawn-time credential in
  // memory, so a turn that selection would route to a DIFFERENT credential has
  // to kill it. Env-prep owns the switch, but it runs inside
  // `executeAgentTurn`, by which point this function has already handed the
  // executor an agent to write into — killing it there would leave
  // `sendUserMessage` addressing a dead process. So release it here, before it
  // can be captured; with no resident agent the turn simply spawns fresh
  // against the newly-selected credentials. Never fires while the process
  // holds background work (req 13) — the turn then runs on the resident
  // credential instead (`requireResidentRoute` in the executor).
  const failoverSession = capturedSessionId ? ctx.sessionManager.get(capturedSessionId) : undefined;
  if (
    useStreaming &&
    residentRouteNeedsRelease(failoverSession, agentId, runner, {
      credentialStore: ctx.credentialStore,
      ...(ctx.providerAccountManager ? { providerAccountManager: ctx.providerAccountManager } : {}),
    })
  ) {
    const resident = runner?.getAgent() ?? null;
    if (resident) {
      // planning#318 — settle the retired turn FIRST, for the reason spelled out in
      // `resident-spawn-guard.ts`: this block clears the slot, so the fresh
      // spawn below installs over an empty one and the displacement hook never
      // fires, while the retired turn's own `agent_done` is dropped as a stale
      // spawn. It has to run before `removeAllListeners()`, since the
      // settlement travels on one of those listeners. Settlement only; a turn
      // that already settled latches, so this is a no-op for the ordinary case.
      resident.emit("superseded");
      // Drop the previous turn's listeners BEFORE killing — same reason as
      // `releaseResidentOnSpawnChange`: the kill's late `done`/`error` (an
      // SSE exit, or an in-flight worker HTTP call rejecting locally on the
      // proxy) must not re-run that turn's terminal flow. Left attached, a
      // late local `error` ran the listener teardown against THIS turn's
      // fresh accumulators and finalized its env-prep failover notice into a
      // permanent duplicate row.
      try {
        resident.removeAllListeners();
      } catch {
        // Best-effort: an adapter without listeners is already the state we want.
      }
      try {
        resident.kill();
      } catch {
        // Already gone is the state we wanted.
      }
      runner?.setAgent(null);
    }
  }
  // A resident streaming process keeps its spawn-time shaping for life — model,
  // endpoint and credential alike — so reusing one after the user picked
  // something different would silently run the old one (and report it back into
  // the picker's trigger label, contradicting the dropdown). Release it here —
  // before it can be captured below — so this turn spawns fresh. Same shape as
  // the failover release above; see `resident-spawn-guard.ts`.
  if (useStreaming && capturedSessionId) {
    releaseResidentOnSpawnChange(
      runner,
      desiredSpawnIdentity(ctx.sessionManager, capturedSessionId, agentId),
    );
  }
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
      // Persist the "Send comments" card metadata so the user bubble rehydrates
      // as a UserReviewCard instead of a raw prompt bubble on reload.
      ...(userReview ? { userReview } : {}),
    });
  };

  // docs/218 — pre-turn auto-reset of a MERGED session's branch to the latest
  // base, BEFORE the turn runs. The decision, the git move, the "branch updated"
  // card and the planning#297 skip notice all live in the shared hook, which the
  // dispatch path calls too (planning#333) — so a message from the Agent Interface
  // SDK, `shipit session message`, or a wake turn continues on the same fresh
  // base a typed message would. Fully fail-safe: a skip/throw leaves the branch
  // un-moved and the turn runs normally.
  //
  // Skip entirely for a `/compact` request (docs/178): compaction is a
  // maintenance command, not a continuation of work, so it must NOT trigger the
  // destructive branch move — and the `[System] …PR was merged…` prefix the
  // reset prepends would derail the compaction (the agent reacts to the merge
  // notice instead of compacting). The reset still runs on the user's next real
  // turn, where it belongs.
  let resetHook: PreTurnResetHookResult = { agentPrefix: "" };
  if (capturedSessionId && capturedSessionDir && runner && !opts.compact) {
    resetHook = await applyPreTurnReset({
      deps: {
        sessionManager: ctx.sessionManager,
        prStatusPoller: ctx.prStatusPoller,
        createGitManager: ctx.createGitManager,
        sseBroadcast: ctx.sseBroadcast,
        chatHistoryManager: ctx.chatHistoryManager,
        getAutoResetMergedBranch: () => ctx.credentialStore.getAutoResetMergedBranch(),
      },
      runner,
      sessionId: capturedSessionId,
      sessionDir: capturedSessionDir,
      // The per-send tick box (Phase 3): `false` = unticked for this message.
      ...(opts.resetMergedBranch !== undefined ? { intent: opts.resetMergedBranch } : {}),
    });
  }
  const resetAgentPrefix = resetHook.agentPrefix;

  // docs/221 — drain the pending out-of-band notice. The docs/218 reset above
  // both moves the branch and speaks to the agent in the same breath because it
  // runs INSIDE the turn it describes; a manual "Sync with <base>" cannot — it
  // runs from an HTTP route while no turn exists (`runRebaseFlow` refuses to
  // start one), so it leaves the sentence here for the next turn to deliver.
  // Consume-and-clear is transactional, so it is delivered exactly once.
  //
  // Skipped for `/compact` for the same reason the reset is (docs/178): a
  // maintenance command must not be handed a "your branch moved" instruction to
  // react to. Leaving the notice pending means the user's next real turn still
  // gets it.
  const pendingAgentNotice =
    capturedSessionId && !opts.compact
      ? ctx.sessionManager.consumePendingAgentNotice(capturedSessionId) ?? ""
      : "";

  // Assemble the prompt from user text plus optional file/image context. Images
  // are saved to the host uploads dir and referenced by path (avoids large
  // base64 payloads over HTTP to the worker). The notices ride in front so the
  // agent sees them this turn only (the pending one is already cleared; the
  // reset prefix was never persisted). Chronological order: the out-of-band sync
  // happened before this turn, the reset happened moments ago.
  const activeDir = ctx.getActiveDir();
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && activeDir ? saveImagesToUploadsDir(images, activeDir) : "";
  const agentPrefix = [pendingAgentNotice, resetAgentPrefix].filter(Boolean).join("\n\n");
  const prompt =
    (agentPrefix ? `${agentPrefix}\n\n` : "") +
    assembleAgentPrompt({ userText, fileContext, imageContext, dictated: opts.dictated });

  // docs/218 — the persisted "branch updated" card (or the planning#297 skip notice)
  // is emitted right after the resumed user row, from inside the executor via
  // the `afterUserMessagePersisted` hook, so it lands in the FRESH turn (post
  // `resetRunnerTurnState`) at its true transcript anchor. The closure comes
  // back from `applyPreTurnReset`, which owns the durability + throw-guard.
  const afterUserMessagePersisted = resetHook.afterUserMessagePersisted;

  // Listener deps — same shape the runner-registry builds for system turns.
  const listenerDeps: AgentListenerDeps = {
    sessionManager: ctx.sessionManager,
    chatHistoryManager: ctx.chatHistoryManager,
    usageManager: ctx.usageManager,
    sseBroadcast: ctx.sseBroadcast,
    broadcastLog: ctx.broadcastLog,
    getSelectedModel: ctx.getSelectedModel,
    recordAgentRateLimits: ctx.recordAgentRateLimits,
    getSubscriptionLimitsSnapshot: ctx.getSubscriptionLimitsSnapshot,
    markSessionAccountExhausted: ctx.markSessionAccountExhausted,
    nudgeClaudeOAuthRefresh: ctx.nudgeClaudeOAuthRefresh,
    onAgentAuthRequired: ctx.onAgentAuthRequired,
    deliverVoiceNote: (payload, runner, source) =>
      void routeVoiceNote(payload, {
        runner,
        sessionId: runner.sessionId,
        credentialStore: ctx.credentialStore,
        source,
        chatHistoryManager: ctx.chatHistoryManager,
      }),
  };

  // Build the shared executor deps from ctx — mirrors runner-registry-factory's
  // system-turn wiring so the WS turn and the dispatched turn consume one shape.
  const deps: SystemTurnDeps = {
    agentFactory: (id) => ctx.agentFactory(id),
    // docs/179 — token healer for the runtime-401 auto-retry.
    ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
    autoCommit: async (sessionDir, summary) => {
      const git = ctx.createGitManager(sessionDir);
      const parentHash = await git.getHeadHash();
      const { commitHash, conflictedFiles, rebaseInProgress, secretFindings } = await git.autoCommit(summary);
      return { commitHash, parentHash, conflictedFiles, rebaseInProgress, secretFindings };
    },
    // Only used by the fallback commit path; the WS path always uses commitTurn
    // (which drives its own push via postTurnCommit → ctx.scheduleAutoPush).
    scheduleAutoPush: (sessionDir) => ctx.scheduleAutoPush(ctx.createGitManager(sessionDir)),
    listenerDeps,
    buildRunParams: async (sessionId, id, p, turnRoute) => {
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
          getSelectedReasoning: ctx.getSelectedReasoning,
          ...(ctx.runParamsPreps ? { runParamsPreps: ctx.runParamsPreps } : {}),
        },
        sessionId,
        agentId: id,
        prompt: p,
        ...(turnRoute ? { turnRoute } : {}),
        sessionDir: activeDir,
        ...(session?.agentSessionId !== undefined ? { agentSessionId: session.agentSessionId } : {}),
        ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
        ...(opts.compact ? { compact: true } : {}),
      });
    },
    prepareAgentEnv: async (sessionId, id, envOpts) => {
      return prepareSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        // docs/150 req 13 — this IS the turn's pre-spawn step, so an
        // unroutable turn fails here rather than spawning against an
        // exhausted account.
        enforceAccountRouting: true,
        ...(envOpts?.reusingResidentAgent ? { reusingResidentAgent: true } : {}),
        ...(envOpts?.excludeRouteIds ? { excludeRouteIds: envOpts.excludeRouteIds } : {}),
        ...(envOpts?.residentRoute ? { residentRoute: envOpts.residentRoute } : {}),
        ...(envOpts?.requireResidentRoute ? { requireResidentRoute: true } : {}),
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
          chatHistoryManager: ctx.chatHistoryManager,
          ...(ctx.ensureAgentTokenFresh ? { ensureAgentTokenFresh: ctx.ensureAgentTokenFresh } : {}),
        },
      });
    },
    // docs/260 req 10 — labels for attempt notices, in the user's own words.
    routeLabel: (routeId) =>
      ctx.providerAccountManager?.getByRouteId(routeId)?.label
      ?? ctx.credentialStore.getCredentialRoute(routeId)?.label,
    finalizeAgentEnv: (sessionId, id, capturedRoute) => {
      finalizeSessionAgentEnvironment(runner, {
        sessionId,
        agentId: id,
        ...(capturedRoute ? { capturedRoute } : {}),
        deps: {
          credentialsDir: ctx.credentialsDir,
          credentialStore: ctx.credentialStore,
          sessionManager: ctx.sessionManager,
          providerAccountManager: ctx.providerAccountManager,
        },
      });
    },
    // docs/179 — the runtime-401 recovery's unconditional token push. Only the
    // recovery path calls it; the ordinary per-turn sync-in stays guarded.
    repushSessionAgentToken: (sessionId, id) => {
      repushSessionAgentToken(runner, {
        sessionId,
        agentId: id,
        deps: { credentialsDir: ctx.credentialsDir, sessionManager: ctx.sessionManager },
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
      // docs/202 — detect a rebase-then-progress on a merged session and re-arm
      // it (clear merged + record superseded PR + SSE session_list) BEFORE the
      // card emit, so `emitPrLifecycleAfterCommit` sees an un-merged session and
      // threads the breadcrumb through.
      await detectAndReArmMergedSession({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          createGitManager: ctx.createGitManager,
          sseBroadcast: ctx.sseBroadcast,
        },
        sessionId,
        sessionDir,
      });
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
    postTurnReArmReset: async (sessionId, sessionDir, emit) => {
      // docs/216 — re-arm a merged session whose branch was reset to a clean
      // base (no commit, so the commit-gated postTurnPrFlow above misses it).
      await detectAndReArmResetSession({
        deps: {
          sessionManager: ctx.sessionManager,
          prStatusPoller: ctx.prStatusPoller,
          createGitManager: ctx.createGitManager,
          sseBroadcast: ctx.sseBroadcast,
        },
        sessionId,
        sessionDir,
        emit,
      });
      // docs/218 — recompute + push the composer's reset-eligibility signal
      // after every turn. A turn that reset the branch (or committed new work)
      // flips it false → the control disappears; an unticked send leaves it
      // eligible → the control reappears. Safety-only; the client ANDs the
      // global setting. Best-effort — never blocks the post-turn flow.
      try {
        await emitResetEligible(
          {
            getSession: (id) => ctx.sessionManager.get(id),
            getPrStatus: (id) => ctx.sessionManager.getPrStatus(id),
            createGitManager: ctx.createGitManager,
          },
          { sessionId, sessionDir, origin: "post-turn", emit },
        );
      } catch (err) {
        console.error(`[pre-turn-reset] post-turn eligibility signal failed for ${sessionId}:`, err);
      }
    },
    postTurnReleaseFlow: async (sessionId, sessionDir, turnText) => {
      await reactToReleaseMarkers({
        deps: {
          releaseStatusPoller: ctx.releaseStatusPoller,
          sessionManager: ctx.sessionManager,
        },
        sessionId,
        sessionDir,
        turnText,
      });
    },
  };

  // Preserve a partial interrupted turn (flip in-progress rows to persisted).
  const onInterruptedTurn = (): void => {
    if (!runner || !capturedSessionId) return;
    const partial = buildTurnMessages(runner.chatMessageGroups, runner.steeredMessages ?? [], runner.recordedCards ?? [], { inProgress: false });
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

  // docs/218 — a branch that moved must leave a record even if the turn dies
  // before it reaches the anchor (`afterUserMessagePersisted`). `ensureRecorded`
  // is latched against that hook, so exactly one of them writes the card.
  try {
    await executeAgentTurn(runner, deps, currentAgent, {
      agentId,
      sessionId,
      prompt,
      userText,
      ...(effectivePermissionMode !== undefined ? { permissionMode: effectivePermissionMode } : {}),
      // The client already rendered an optimistic bubble — don't echo.
      emitUserEcho: false,
      persistUserMessage,
      ...(afterUserMessagePersisted ? { afterUserMessagePersisted } : {}),
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
  } finally {
    if (sessionId) resetHook.ensureRecorded?.(sessionId);
  }
}
