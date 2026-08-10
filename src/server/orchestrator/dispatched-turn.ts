/**
 * Thin dispatch adapter over the shared `executeAgentTurn` (turn-executor.ts).
 *
 * Translates a server-dispatched message (quick / child / CI-fix / HTTP
 * dispatch / queue drain) into a normalized `TurnInput` and delegates. The only
 * dispatch-specific work left here is: acquire the agent (reuse a resident
 * streaming process when this turn streams and one is alive — docs/163 — else
 * spawn fresh; system turns never stream so they always spawn fresh), echo the
 * message via `emitUserEcho`, persist the user row (text-only), and supply the
 * queue-drain re-entry. Everything else — reset, env-prep, spawn, listeners,
 * post-turn commit/push/PR/drain — lives in the shared executor so this path
 * can't drift from the WS path.
 *
 * docs/163 — a child/quick-session dispatched turn runs as a *streaming* process
 * when live steering is on and the agent supports it (the same gate the WS path
 * uses), so a follow-up `shipit session message` arriving mid-turn is steered
 * into the running turn instead of being queued. See `useStreaming` below.
 *
 * Used by both SessionRunner.dispatch and ContainerSessionRunner.dispatch.
 *
 * docs/149 — async because env-prep + run-params assembly are async. Callers
 * fire-and-forget via `void runDispatchedTurn(...)`.
 */

import type { AgentId, AgentProcess, FileAttachment, ImageAttachment } from "../shared/types.js";
import { executeAgentTurn } from "./turn-executor.js";
import { releaseResidentOnSpawnChange } from "./resident-spawn-guard.js";
import { desiredSpawnIdentity } from "./service-routing.js";
import { buildTurnMessages, emitNoticePostTurn } from "./chat-card-persistence.js";
import { resolveFileAttachments, resolveUploadRefs, formatFileContext } from "./validation.js";
import { saveImagesToUploadsDir, assembleAgentPrompt } from "./prompt-assembly.js";
import type {
  SessionRunnerInterface,
  SystemTurnDeps,
} from "./session-runner.js";
import type { PreparedDispatch } from "./prepared-dispatch.js";
import { queuedMessageToDispatchOptions } from "./queue-drain.js";
import type { TurnOutcome } from "./turn-settlement.js";
import { formatAgentInterfacePrompt } from "../shared/agent-interface-sdk/protocol.js";
import { formatSessionMessagePrompt } from "./session-message-origin.js";

/**
 * How many times a dispatched first turn that exited WITHOUT producing a result
 * is auto-retried before we give up and surface a visible error. The known
 * manual workaround for the docs/163 "quick-session first turn never ran" bug
 * is resending the prompt — one automatic retry reproduces that workaround so
 * the user never has to. Bounded so a genuinely broken turn can't loop.
 */
const MAX_NO_RESULT_RETRIES = 1;

/**
 * planning#318 — settle the turn whose resident process this dispatch is about to
 * RETIRE, at the moment it is retired.
 *
 * `ContainerSessionRunner.supersedeDisplacedAgent` already covers a slot
 * REPLACEMENT (`setAgent(next)` over a still-installed proxy). Both retirement
 * blocks below take the other shape — `kill(); setAgent(null); createAgent()` —
 * so the incoming proxy is installed over an ALREADY-EMPTY slot and the
 * displacement hook has nothing to compare against. Nothing else then tells the
 * retired turn it is over: its own `agent_done` arrives with the previous
 * spawn's `runToken` and is dropped by the docs/146 stale-spawn guard (right for
 * the relay — emitting it would run the retired turn's teardown against the
 * live turn's slot), and neither `settleAsDropped` net applies (the runner is
 * alive, and the worker truthfully reports an agent running). The settlement
 * stayed pending forever.
 *
 * In production (2026-08-10, session 18d04568) that stranded a merge-wake turn
 * for PR #2104 at `merge-observed`: its `agent_result` had already arrived and
 * drained the NEXT wake turn off the queue, that wake retired the still-resident
 * process here, and the retired turn's `agent_done` was then dropped as stale.
 * Indistinguishable from a wake that never reached the session, so planning#260's
 * retry supervisor re-sent the identical prompt three minutes later — the
 * duplicate notification planning#318 exists to prevent.
 *
 * SETTLEMENT ONLY. The `superseded` handler in `turn-executor.ts` deliberately
 * runs no teardown: the turn being started here owns the runner, the agent slot
 * and the working tree. The outcome is whatever the retired turn earned —
 * `completed` when its `agent_result` had arrived (the production shape),
 * `interrupted` when it was cut short before producing one — never `no-result`,
 * which is the one the supervisor retries. A turn that already settled latches,
 * so this is a no-op for every ordinary retirement.
 */
function supersedeRetiredTurn(outgoing: AgentProcess): void {
  outgoing.emit("superseded");
}

export async function runDispatchedTurn(
  runner: SessionRunnerInterface,
  deps: SystemTurnDeps,
  agentId: AgentId,
  opts: PreparedDispatch,
  createAgent: (agentId: AgentId) => AgentProcess,
): Promise<void> {
  // Re-check on queue drain / recovered-turn execution, not only when the item
  // first entered dispatch. This is currently defense in depth (there is no
  // trust-revoke UI), and makes later revocation fail closed.
  runner.assertCanDispatch();
  const { text, activity } = opts;

  // docs/163 — a child/quick-session dispatched turn must run as a *streaming*
  // process when live steering is on and the agent supports it, EXACTLY as a
  // user-typed WS turn does (agent-execution.ts computes the same gate). The
  // child's own first turn is started through THIS path, so if it spawns
  // non-streaming the resident process is one-shot, `runner.isStreamingActive`
  // stays false, and a follow-up `shipit session message` arriving mid-turn
  // fails `shouldSteerMessage` and is QUEUED instead of injected — the "spawn a
  // session, then message it, and the message just sits in the queue" bug. With
  // streaming on, the running turn's agent is steerable, so `trySteerDispatch`
  // injects the message via `sendUserMessage`, i.e. it behaves as if the user
  // typed it. System turns (rebase resolution, CI-fix) are explicitly never
  // steered (`systemTurnInProgress` blocks it), so they stay non-streaming and
  // keep their fresh-agent-per-turn / one-shot post-turn semantics.
  const steer = opts.systemTurn ? undefined : deps.steerInputs?.();
  const useStreaming = steer ? steer.liveSteering && steer.steeringCapable : false;

  // Fold any attachments into the prompt EXACTLY as the WS path does
  // (agent-execution.ts:runAgentWithMessage). A quick / child session dispatch
  // carries `uploads` (saved into the session's uploads dir by
  // `createHeadlessSession` before this turn fires) and may carry `files` /
  // inline `images`. Without resolving them here, `executeAgentTurn` would
  // receive a text-only prompt and the agent would never see the attached
  // image — the file sits on disk, unreferenced. We resolve upload refs to
  // ImageAttachments / FileAttachments, save images to the uploads dir
  // (referenced in place via `existingPath`), and assemble the slash-aware
  // prompt. `uploadPaths` is persisted on the user row so the bubble rehydrates
  // with its image/file chips and `hydrateUploads` sees the upload as sent.
  const sessionDir = runner.sessionDir;
  let validatedFiles: FileAttachment[] = [];
  let images: ImageAttachment[] | undefined =
    opts.images && opts.images.length > 0 ? opts.images : undefined;
  let uploadPaths: string[] | undefined;
  if (sessionDir) {
    if (opts.files && opts.files.length > 0) {
      const result = await resolveFileAttachments(opts.files, sessionDir);
      if (result.error) {
        emitNoticePostTurn(
          (m) => runner.emitMessage(m),
          deps.listenerDeps.chatHistoryManager,
          runner.sessionId,
          `Some attached files couldn't be read: ${result.error}`,
          "warn",
        );
      } else {
        validatedFiles = result.files;
      }
    }
    if (opts.uploads && opts.uploads.length > 0) {
      const uploadResult = await resolveUploadRefs(opts.uploads, sessionDir);
      if (uploadResult.error) {
        emitNoticePostTurn(
          (m) => runner.emitMessage(m),
          deps.listenerDeps.chatHistoryManager,
          runner.sessionId,
          `Some attached uploads couldn't be read: ${uploadResult.error}`,
          "warn",
        );
      } else {
        validatedFiles = [...validatedFiles, ...uploadResult.files];
        if (uploadResult.images.length > 0) {
          images = [...(images ?? []), ...uploadResult.images];
        }
        // Record the original `/uploads/...` paths even when the upload was a
        // non-image file, so the user bubble rehydrates with its chips.
        uploadPaths = opts.uploads.map((u) => u.path);
      }
    }
  }
  const fileContext = validatedFiles.length > 0 ? formatFileContext(validatedFiles) : "";
  const imageContext =
    images && images.length > 0 && sessionDir ? saveImagesToUploadsDir(images, sessionDir) : "";
  const surfacedText = opts.agentInterface ? formatAgentInterfacePrompt(text, opts.agentInterface) : text;
  const agentText = opts.messageOrigin
    ? formatSessionMessagePrompt(surfacedText, opts.messageOrigin)
    : surfacedText;

  // docs/218 + planning#333 — auto-reset a MERGED session's branch onto the latest
  // base BEFORE this turn's prompt is assembled, exactly as the interactive path
  // does. A dispatched message is a continuation of the session's work — an
  // Agent Interface SDK click, a `shipit session message`, a wake turn — and
  // without this it ran on a branch still sitting on already-merged commits.
  //
  // No per-send intent is passed: the tick box is a composer control, so a
  // dispatch follows the global `autoResetMergedBranch` setting (which is what
  // the box reflects when it is ticked). The hook is fail-safe and its own
  // safety gate decides — see `SystemTurnDeps.preTurnReset`.
  //
  // Runs ONCE per dispatched message, outside `runOnce`, so a no-result retry
  // neither re-resets nor re-emits the transcript card.
  //
  // `postTurn: "none"` is excluded, and it is the ONE exclusion — the same kind
  // the interactive path makes for `/compact`: about what the turn *is*, not
  // about which transport carried it. It marks a turn that is a STEP INSIDE a
  // git operation the driver owns (docs/146 rebase-conflict resolution, which
  // commits via `rebase --continue` and force-pushes at the end), not a
  // continuation of the session's work. No reset could fire there anyway — the
  // gate refuses a conflicted tree — but the planning#297 skip machinery would
  // still fire, persisting "this branch still sits on the already-merged
  // commits" and telling the agent to consider `shipit branch reset-to-base`
  // while its actual job is to edit the conflicted files. Note the clause it
  // would report is `dirty-tree`, NOT `rebase-in-progress`: `computeResetBlocker`
  // checks `isClean()` first, and a conflicted rebase has an unclean tree. So
  // the exclusion is load-bearing, not belt-and-braces.
  const reset = sessionDir && opts.postTurn !== "none"
    ? await deps.preTurnReset?.(runner, runner.sessionId, sessionDir)
    : undefined;

  // The `[System] …` prefix rides in FRONT of the assembled prompt, exactly as
  // the interactive path places it: the branch moved (or conspicuously did not)
  // moments ago, so the agent has to read that before the message it is acting on.
  const prompt =
    (reset?.agentPrefix ? `${reset.agentPrefix}\n\n` : "") +
    assembleAgentPrompt({
      userText: agentText,
      fileContext,
      imageContext,
      // docs/144 — set only by a human-dictated dispatch (a quick-capture prompt
      // spoken into the overlay); server-composed turns never carry it.
      dictated: opts.dictated,
    });

  // Chat-history metadata for the persisted user row — mirrors the WS path so a
  // reload shows the same inline image / file chips on the dispatched bubble.
  const historyImages = images?.map((img) => ({ data: img.data, mediaType: img.mediaType }));
  const historyFiles =
    validatedFiles.length > 0
      ? validatedFiles.map((f) => ({
          path: f.path,
          contentPreview: f.content.slice(0, 200),
          startLine: f.startLine,
          endLine: f.endLine,
        }))
      : undefined;

  // planning#257 — this drain runs EVERY entry (interactive or dispatched) on the
  // dispatched executor via the shared `queuedMessageToDispatchOptions`, which
  // is the superset conversion: nothing can be narrowed away here. The WS drain
  // (`ws-handlers/agent-execution.ts`), whose re-entry is narrower, routes
  // through `startQueuedMessage` instead so a dispatched entry lands back here.
  const drainNext = async (): Promise<void> => {
    // planning#338 — a rebase flow grabbed the session during this turn's post-turn
    // window (after `tryDrain` cleared `running`, while the local commit was
    // still being awaited). Dequeuing now would start a turn against a
    // mid-rebase tree — or double-drain against the flow's own post-flow
    // release. `!opts.systemTurn` keeps a SYSTEM turn's own drain working: its
    // per-turn flag is still set at drain time (`finishTurn` clears it after),
    // and the flow can't have grabbed the hold mid-turn (`runRebaseFlow`
    // refuses while the flag is up).
    if (runner.systemTurnInProgress && !opts.systemTurn) return;
    if (runner.queueLength === 0) return;
    const next = runner.dequeue();
    if (!next) return;
    runner.emitMessage({ type: "queue_updated", queue: runner.getQueueSnapshot() });
    await runDispatchedTurn(runner, deps, agentId, queuedMessageToDispatchOptions(next), createAgent);
  };

  // Tracks no-result retries across the recursive `runOnce` calls for THIS
  // dispatched message (a queue drain re-enters `runDispatchedTurn`, which gets
  // its own fresh counter — each message is retried independently).
  let noResultRetries = 0;

  // planning#262 — ONE settlement for the whole logical turn, spanning every
  // no-result attempt.
  //
  // The old code passed `onTurnComplete` only to attempt zero, reasoning that a
  // retry re-enters `runOnce` and would otherwise fire it twice. The guard did
  // prevent a double fire — by firing it ZERO times: when attempt zero exits
  // with no result and no partial work, the executor returns through its
  // "handled" branch WITHOUT calling `finishTurn`, so neither the retry's
  // success nor its failure ever reached the caller. A notify-on-merge wake-turn
  // that no-result-retried therefore never settled its watch, and (worse, under
  // planning#260's supervisor) the runner stayed live so the `inFlight` marker looked
  // healthy forever.
  //
  // Retries are attempts WITHIN one settlement instead. Every attempt is wired
  // to `settleAttempt`, and a double fire is not expressible: `settled` latches,
  // and an attempt superseded by a retry is filtered by `currentAttempt`, so the
  // outcome that reaches the caller is the LAST attempt's — including `errored`.
  let currentAttempt = 0;
  let settled = false;
  const settleAttempt = (attempt: number, outcome: TurnOutcome): void => {
    // A retry took over this logical turn; the superseded attempt's terminal
    // teardown must not settle it.
    if (attempt !== currentAttempt) return;
    if (settled) return;
    settled = true;
    opts.onTurnComplete?.(outcome);
  };

  const runOnce = async (attempt: number): Promise<void> => {
    // docs/150 — credential switching happens later in env prep, after this
    // adapter has chosen its agent. Retire a resident process here, before
    // capture, so we neither steer the turn into the outgoing account nor let
    // env prep kill the newly-created incoming agent.
    if (deps.needsAccountFailover?.(runner.sessionId, agentId)) {
      const outgoing = runner.getAgent();
      if (outgoing) {
        // Settle first — see `supersedeRetiredTurn`. It has to run BEFORE the
        // listeners come off, since the settlement travels on one of them.
        supersedeRetiredTurn(outgoing);
        // Drop the previous turn's listeners BEFORE killing — same as the WS
        // path's failover release and `releaseResidentOnSpawnChange`: the
        // kill's late `done`/`error` (an SSE exit, or an in-flight worker HTTP
        // call rejecting locally on the proxy) must not re-run that turn's
        // terminal flow against the turn this dispatch is about to start.
        try { outgoing.removeAllListeners(); } catch { /* already bare */ }
        try { outgoing.kill(); } catch { /* already gone */ }
        runner.setAgent(null);
      }
    }
    // docs/140 + docs/163 — when a resident streaming process from a previous
    // turn is still alive, REUSE it (carry the message in via `sendUserMessage`)
    // exactly as the WS path does, rather than spawning a fresh agent. Spawning
    // fresh while the worker still holds the old streaming process would 409 the
    // `/agent/start` and trigger a kill+restart (SIGTERM 143) — the respawn-noise
    // bug docs/140 fixed for the WS path.
    //
    // docs/146 follow-up (prod dispatched-turn race): the reuse decision must
    // NOT be gated on THIS turn's recomputed `useStreaming`. When a streaming
    // process is resident (`isStreamingActive`) but this dispatch happens to
    // compute `useStreaming === false` (live-steering toggled off, or
    // `steerInputs` momentarily reporting not-capable), the old code spawned a
    // fresh one-shot `claude -p <prompt>` via `createAgent`. That fresh proxy
    // DISPLACES the live streaming proxy in the runner's single `_agent` slot
    // and orphans it; when the one-shot later exits with no result it nulls the
    // slot, and the still-running streaming process's assistant/tool_result/
    // result events are then sse-dropped `(no _agent)` — the whole turn vanishes
    // from the UI. A live streaming process is fed via `sendUserMessage`, never
    // re-spawned. So reuse whenever one is resident, independent of
    // `useStreaming`. System turns (rebase / CI-fix) keep their fresh-spawn /
    // one-shot semantics — they are never steered and must not adopt the
    // resident process. Only the FIRST attempt can reuse; a no-result retry
    // always spawns fresh (the resident ref was cleared by the `done` handler
    // when the process exited without a result).
    // Same spawn-drift release the WS path performs: a resident process runs the
    // model, endpoint and credential it was spawned with, so reusing one after
    // the session's selection changed would run the old ones behind the user's
    // back. Both paths derive the identity from the session row, which is what
    // their run params read too.
    if (!opts.systemTurn) {
      releaseResidentOnSpawnChange(
        runner,
        desiredSpawnIdentity(deps.listenerDeps.sessionManager, runner.sessionId, agentId),
      );
    }
    const resident =
      !opts.systemTurn && attempt === 0 && runner.isStreamingActive ? runner.getAgent() : null;
    const reuse = resident !== null;
    // docs/179 §4 (issue criterion 3) — a system turn declines to ADOPT the
    // resident process, but declining does not make it go away: it is still
    // running in the worker, and env prep (a few lines below, inside
    // `executeAgentTurn`) is about to rewrite the credential subtree it reads
    // from on every request. `reusingResidentAgent: false` is the honest answer
    // to "will this turn reuse it", so the repair correctly believes it may
    // run — which leaves exactly the window this doc exists to close.
    //
    // Retire it here instead, before env prep, mirroring the account-failover
    // block above. "Topology changes only at a spawn boundary" is only true if
    // the boundary is real, and it is real once the old process is gone. This
    // is also strictly tidier than the status quo: `createAgent` would displace
    // the slot and orphan the process anyway, and the worker's `/agent/start`
    // would then 409 into a kill+restart (the SIGTERM-143 noise docs/140 fixed
    // elsewhere). Only reachable with no turn in flight — `dispatchOnRunner`
    // enqueues while `running` — so nothing live is interrupted.
    if (opts.systemTurn && !reuse) {
      const outgoing = runner.getAgent();
      if (outgoing) {
        supersedeRetiredTurn(outgoing);
        try { outgoing.kill(); } catch { /* already gone */ }
        runner.setAgent(null);
        runner.isStreamingActive = false;
      }
    }
    const agent = resident ?? createAgent(agentId);
    // A reused process IS the resident streaming process, so this turn streams
    // (and the post-turn handler must key on streaming) even if `useStreaming`
    // was recomputed false for this dispatch. Otherwise `executeAgentTurn` would
    // set `isStreamingActive = false` and route the post-turn flow through the
    // non-streaming branch, clearing the resident flag mid-turn.
    const turnStreams = useStreaming || reuse;
    // Drop the previous turn's per-turn listeners off a reused process before the
    // executor wires its own, else they fire N times after N turns (mirrors the
    // WS path's `existingAgent.removeAllListeners()`).
    if (reuse) agent.removeAllListeners();

    await executeAgentTurn(runner, deps, agent, {
      agentId,
      sessionId: runner.sessionId,
      prompt,
      userText: text,
      ...(activity !== undefined ? { activity } : {}),
      // Only set the key when streaming so a non-steerable dispatch keeps the
      // exact run-params shape it had before (turn-executor leaves `useStreaming`
      // out of the run params when this is undefined — see its spawn branch).
      // `turnStreams` (not `useStreaming`) so a turn that reuses a resident
      // streaming process is treated as streaming end-to-end.
      ...(turnStreams ? { useStreaming: true } : {}),
      // Carry the message into the resident streaming process via
      // `sendUserMessage` instead of a fresh `/agent/start` (turn-executor's
      // reuse branch).
      ...(reuse ? { reuseExistingAgent: true } : {}),
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      // docs/169 — post-turn policy + system-turn marker + completion signal.
      ...(opts.postTurn !== undefined ? { postTurn: opts.postTurn } : {}),
      ...(opts.systemTurn !== undefined ? { systemTurn: opts.systemTurn } : {}),
      // planning#266 — the durable delivery identity travels with every attempt: a
      // no-result retry is the SAME delivery, so it publishes the same id and
      // the worker records it on the fresh spawn too.
      ...(opts.deliveryId !== undefined ? { deliveryId: opts.deliveryId } : {}),
      // planning#262 — EVERY attempt reports its terminal outcome; `settleAttempt`
      // owns "exactly once" and discards superseded attempts. The old
      // "attempt zero only" guard is deleted, not corrected.
      onTurnComplete: (outcome) => settleAttempt(attempt, outcome),
      // Server-initiated message → emit a bubble (no client-side optimistic
      // one). A retry must NOT re-echo the bubble or re-append the user row —
      // both already happened on the first attempt — so only the first run does.
      emitUserEcho: attempt === 0,
      ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
      ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
      // docs/218 — the "branch updated" card (or the planning#297 skip notice) lands
      // right after the user row, inside the fresh turn. Attempt 0 only: a
      // no-result retry re-enters the executor with the user row already
      // written, and firing the hook again would duplicate the card.
      ...(attempt === 0 && reset?.afterUserMessagePersisted
        ? { afterUserMessagePersisted: reset.afterUserMessagePersisted }
        : {}),
      persistUserMessage:
        attempt === 0
          ? (sid) =>
              deps.listenerDeps.chatHistoryManager.append(sid, {
                role: "user",
                text,
                ...(opts.agentInterface ? { agentInterface: opts.agentInterface } : {}),
                ...(opts.messageOrigin ? { messageOrigin: opts.messageOrigin } : {}),
                ...(historyImages ? { images: historyImages } : {}),
                ...(historyFiles ? { files: historyFiles } : {}),
                ...(uploadPaths && uploadPaths.length > 0 ? { uploadPaths } : {}),
              })
          : () => { /* user row already persisted on the first attempt */ },
      isNewSession: false,
      fallbackTitle: text.slice(0, 80) || "Agent",
      turnStartHeadHash: null,
      drainNext,
      emit: (m) => runner.emitMessage(m),
      // The masking-bug fix (docs/163): a dispatched first turn that exits
      // without an `agent_result` is NOT a completed turn. Auto-retry once
      // (the user's known "resend the prompt" workaround), then surface a
      // visible error so the failure can never silently vanish again.
      onNoResultExit: async (code, stderrDetail) => {
        // A turn that streamed visible work (assistant text / tool calls) before
        // exiting WITHOUT an `agent_result` — the OOM/SIGHUP case (exit 137/129
        // under memory pressure) — DID run, and must NOT be retried:
        //   1. Re-running re-executes an already-partially-applied prompt.
        //   2. The retry's `resetRunnerTurnState` clears `runner.chatMessageGroups`
        //      in memory while the streamed rows are still `in_progress=1` in the
        //      DB. When the retry then also exits without a result, the surfaced
        //      error rebuilds chat history from the now-EMPTY groups, so
        //      `replaceInProgress([])` deletes the partial turn's rows. Across a
        //      long memory-pressured session these unfinalized `in_progress=1`
        //      rows accumulate and vanish in one wipe — "the agent did the work
        //      but the turns disappeared", while the diffs survive in git.
        // So only the genuinely-empty "never ran" exit (docs/163) is retried; a
        // partial-work exit surfaces the error immediately, while the groups are
        // still intact, so the `agent.error` handler FINALIZES the partial turn
        // (`replaceInProgress` + `finalizeInProgress`) instead of deleting it.
        // The WS path preserves partial turns the same way via `onInterruptedTurn`;
        // dispatch must not retry away from that guarantee.
        const producedPartialWork =
          buildTurnMessages(
            runner.chatMessageGroups,
            runner.steeredMessages ?? [],
            runner.recordedCards ?? [],
            { inProgress: false },
          ).length > 0;

        if (!producedPartialWork && noResultRetries < MAX_NO_RESULT_RETRIES) {
          noResultRetries++;
          // Claim the logical turn for the next attempt BEFORE it starts, so
          // this (now superseded) attempt's terminal teardown can't settle it.
          currentAttempt = attempt + 1;
          console.warn(
            `[turn] dispatched turn for ${runner.sessionId} exited (code ${code}) with no result — ` +
              `retrying (attempt ${noResultRetries}/${MAX_NO_RESULT_RETRIES})`,
          );
          emitNoticePostTurn(
            (m) => runner.emitMessage(m),
            deps.listenerDeps.chatHistoryManager,
            runner.sessionId,
            "The agent didn't start on the first attempt — retrying…",
            "warn",
          );
          await runOnce(attempt + 1);
          return true;
        }
        console.error(
          `[turn] dispatched turn for ${runner.sessionId} exited with no result ` +
            `(partialWork=${producedPartialWork}, retries=${noResultRetries}) — surfacing error`,
        );
        // Route through the agent's `error` event so the failure surfaces
        // exactly like any other turn error — a chat error row, a
        // `session_status` reset, `session_agent_finished`, and a queue drain —
        // instead of being swallowed as a completed turn. When the turn streamed
        // partial work before dying, the error handler FINALIZES those still-intact
        // groups (so the visible work is preserved on reload); phrase the message
        // as "stopped before finishing" rather than "without running", which only
        // fits the genuinely-empty case.
        const summary = producedPartialWork
          ? (code !== null && code !== 0
              ? `The agent stopped before finishing (exit ${code}). The work so far is preserved — send your message again to continue.`
              : "The agent stopped before finishing. The work so far is preserved — send your message again to continue.")
          : (code !== null && code !== 0
              ? `The agent exited with code ${code} without running. Please send your message again.`
              : "The agent stopped without doing any work. Please send your message again.");
        // Name the cause when the CLI left one on stderr — same reason the WS
        // path appends it (`turn-executor.ts`): without it, every distinct way a
        // dispatched turn can die reads as the same exit code. Already redacted
        // and length-bounded by `agent-stderr-tail.ts`.
        agent.emit("error", new Error(stderrDetail ? `${summary} (${stderrDetail})` : summary));
        return true;
      },
    });
  };

  // docs/218 — a branch that moved must leave a record even if the turn dies
  // before reaching the anchor (`afterUserMessagePersisted`) — an admission
  // refusal, a spawn failure, a throw in env prep. `ensureRecorded` is latched
  // against that hook, so exactly one of the two writes the card.
  try {
    await runOnce(0);
  } finally {
    reset?.ensureRecorded?.(runner.sessionId);
  }
}
