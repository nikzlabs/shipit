/**
 * docs/295 — the per-turn WIRING of the merged-session context compaction,
 * shared by every transport that starts a turn.
 *
 * A session whose pull request merged continues with a clean *tree*
 * ([pre-turn-reset-hook.ts](./pre-turn-reset-hook.ts), docs/218) and a stale
 * *context*: the conversation still describes work that has shipped, and a tree
 * that no longer exists in that form. This step compacts it, immediately before
 * the reset, so the next slice starts clean on both counts.
 *
 * ## It is a TURN, not a bare spawn — and that is not an implementation detail
 *
 * docs/295's plan.md left one thing unproven: whether a compaction could run in
 * a turn's *pre-spawn phase*, as a spawn the turn executor never sees. It cannot,
 * and two shipped mechanisms say so independently:
 *
 *  - **Events reach an agent only through the runner's single `_agent` slot.**
 *    In container mode the SSE relay resolves every worker event against the
 *    proxy currently installed there and drops anything else
 *    (`container-session-runner.ts` `isStaleSpawnEvent` / the `(no _agent)`
 *    drop). A compaction process spawned *beside* the turn's agent would receive
 *    no `agent_compacted`, no `done` and no `error` — it would hang until a
 *    timeout, every time, in production but not in an in-process test.
 *  - **The executor's terminal sequence is not opt-out-able per spawn.** Every
 *    terminal path runs drain → commit → finished
 *    (`turn-executor.ts`), and `tryDrain` starts a QUEUED turn. A compaction
 *    settling there would begin a queued user message *concurrently* with the
 *    turn we are about to spawn.
 *
 * So the compaction goes through `executeAgentTurn` like everything else, in the
 * mode the codebase already has for exactly this shape: `postTurn: "none"` +
 * `systemTurn: true` — "a step inside a larger operation the driver owns", the
 * mode the docs/146 rebase driver runs its resolution turns in. That mode is
 * what makes the sequencing safe, and each half is load-bearing:
 *
 *  - `postTurn: "none"` elides the auto-commit, the push, the PR / re-arm /
 *    release flows AND the queue drain (`turn-executor.ts` `tryDrain` and
 *    `runCommitAndPrInner` both return early on it). Without it, the compaction
 *    would commit the user's un-run turn under the summary "Compacting context"
 *    and drain a queued message on top of the turn we are about to start.
 *  - `systemTurn: true` holds `systemTurnInProgress` for the compaction's
 *    duration, so a message that arrives mid-compaction is QUEUED rather than
 *    steered into it (`drainNextQueuedMessage` stands down on the same flag).
 *
 * It also inherits the exclusion that mode already carries on the dispatch path:
 * `dispatched-turn.ts` skips the docs/218 reset for `postTurn: "none"`, so the
 * compaction turn cannot trigger a branch move or a skip notice of its own.
 *
 * ## One gate, not two
 *
 * Eligibility is {@link isResetEligible} — the SAME predicate that drives the
 * composer's `reset_eligible` signal, and therefore the same predicate that put
 * the tick box in front of the user. Requirements 1 and 3 say the second control
 * is offered whenever the first is; requirement 13 says a continuation the user
 * did not type compacts "in the same conditions in which its branch is reset".
 * Asking the same function is how those hold, rather than a second, weaker gate
 * that can disagree with the first — the failure `pre-turn-reset-hook.ts` calls
 * out for the reset itself.
 *
 * Requirement 6 is why the gate is *this* and not "did the reset move the
 * branch": the two controls are independent, so unticking "start from the latest
 * base" must not silently disable the compaction. Running BEFORE the reset is
 * what keeps the predicate answerable — after the branch moves, HEAD is at the
 * base and the session is eligible for nothing.
 */

import type { AgentEvent, AgentId, AgentProcess } from "../shared/types.js";
import { isResetEligible, type ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import { emitNoticeInTurn, emitNoticePostTurn, type InProgressPersister } from "./chat-card-persistence.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { executeAgentTurn } from "./turn-executor.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";

/**
 * What the compaction turn actually achieved. Requirement 9 forbids reporting
 * completion in place of an outcome, so `no-compaction` is deliberately its own
 * value rather than folded into `compacted`: docs/276 req 2 is the precedent —
 * a trigger that exits successfully while doing nothing is not a compaction and
 * must never be rendered as one.
 */
export type CompactOutcome =
  /** Nothing was asked for, or nothing was eligible. Silent by design. */
  | { kind: "not-applicable" }
  | { kind: "compacted" }
  /** The turn ran and the backend reported no compaction at all. */
  | { kind: "no-compaction" }
  | { kind: "failed"; detail: string };

export interface PreTurnCompactHookResult {
  outcome: CompactOutcome;
  /**
   * Pass through as `TurnInput.afterUserMessagePersisted` so a failure notice
   * lands right after the user row, inside the fresh turn. Undefined when there
   * is nothing to say (the ordinary success and not-applicable cases).
   */
  afterUserMessagePersisted?: (sessionId: string) => void;
  /**
   * Safety net — call from a `finally` around the turn, exactly as the reset
   * hook's namesake is called. A user who ticked the box and got no compaction
   * must be told even if the turn then died before persisting its user row.
   * Latched with the hook above, so exactly one of the two ever writes.
   */
  ensureRecorded?: (sessionId: string) => void;
}

const NOT_APPLICABLE: PreTurnCompactHookResult = { outcome: { kind: "not-applicable" } };

/**
 * Upper bound on how long a user's turn may be held behind the compaction.
 *
 * Requirement 9 is that the turn is never lost, and an unbounded await is
 * exactly how it would be: a backend that accepts the trigger and then neither
 * settles nor exits would park the message forever with the composer showing a
 * running turn. docs/178 measured 27.7 s on a 22k-token context and OpenCode's
 * own summarize window is 300 s, so this is roughly an order of magnitude above
 * the slowest shape either has been seen to take.
 */
const COMPACTION_TIMEOUT_MS = 300_000;

/**
 * The post-merge summarization brief.
 *
 * A default summary ends with the shipped work's next steps, which is precisely
 * the wrong emphasis for a session whose work just merged — that is the context
 * this compaction exists to drop. Two of the four harnesses honour it (Claude
 * passes it to `/compact <instructions>`; Grok lifts it into `user_context` —
 * probed at 1.0.12, docs/276); Codex's `thread/compact/start` and OpenCode's
 * `summarize` route have no slot for instructions and ignore it.
 *
 * That asymmetry is why docs/295 req 7 is a requirement rather than a nicety:
 * on the other two harnesses the docs/218 merge prefix is the ONLY thing telling
 * the agent not to re-apply shipped work, and it rides the user's turn — never
 * this one.
 */
export const POST_MERGE_COMPACTION_INSTRUCTIONS =
  "The pull request for the work in this conversation has been merged, so that work is finished "
  + "and is already in the base branch. Summarize for a session that is about to start NEW work in "
  + "the same repository: keep the user's standing preferences and instructions, the repository "
  + "conventions established here, and any question still unresolved. Reduce the shipped work to a "
  + "short statement of what it changed, and drop its step-by-step implementation detail.";

export interface PreTurnCompactHookDeps extends ResetEligibleSignalDeps {
  chatHistoryManager: InProgressPersister;
  /** The shared docs/218 setting. Requirement 11: one switch governs both actions. */
  getAutoResetMergedBranch: () => boolean;
}

export interface PreTurnCompactHookArgs {
  deps: PreTurnCompactHookDeps;
  /** Everything the compaction TURN needs — the same shape both transports build. */
  turnDeps: SystemTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  sessionDir: string;
  createAgent: (agentId: AgentId) => AgentProcess;
  /**
   * The composer's per-send tick box. `false` = unticked for this message →
   * skip. Absent on every programmatic path (there is no box), so those follow
   * the global setting — requirement 13.
   */
  intent?: boolean;
}

/**
 * Run the docs/295 pre-turn compaction for a turn that is about to start.
 *
 * Fail-safe throughout: requirement 9 is that the user's message runs whatever
 * happens here, so every failure resolves to an outcome plus a notice rather
 * than a throw.
 */
export async function applyPreTurnCompaction(
  args: PreTurnCompactHookArgs,
): Promise<PreTurnCompactHookResult> {
  const { deps, turnDeps, runner, agentId, sessionId, sessionDir, createAgent, intent } = args;

  // Requirement 5 — the untick applies to this one message. Checked before
  // anything expensive: an unticked box must cost nothing, not merely change
  // nothing.
  if (intent === false) return NOT_APPLICABLE;
  // Requirement 11 — the shared setting. Off means neither control is offered,
  // so a stale `compactContext: true` from a client that has not seen the
  // setting change still cannot compact.
  if (!deps.getAutoResetMergedBranch()) return NOT_APPLICABLE;
  // Requirement 10 — a backend that cannot compact is not asked to.
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return NOT_APPLICABLE;

  let eligible: boolean;
  try {
    eligible = await isResetEligible(deps, sessionId, sessionDir);
  } catch (err) {
    // `isResetEligible` is already fail-safe-false internally; this covers a
    // throw from constructing its deps. Either way "we could not tell" means
    // "do not compact", and it is not worth a notice — the user asked for a
    // compaction on a merge boundary we cannot prove exists.
    console.error(`[pre-turn-compact] eligibility check failed for ${sessionId}:`, err);
    return NOT_APPLICABLE;
  }
  if (!eligible) return NOT_APPLICABLE;

  // docs/260 req 13 — a resident process holding background work (a sub-agent
  // review, agent-started background tasks) may not be displaced by a system
  // turn: the fresh spawn retires it and the tokens already spent on that work
  // are lost. `dispatchOnRunner` enforces this by ENQUEUING such a system turn,
  // but this hook drives the executor directly and so bypasses that admission
  // check entirely. Enqueuing is not available here — the compaction has to
  // finish before the user's turn is assembled — so the answer is to skip it.
  // Losing one compaction is a far smaller harm than killing a running review.
  if (runner.getAgent() !== null && runner.backgroundWorkDescriptions.length > 0) {
    console.log(
      `[pre-turn-compact] skipping the compaction for ${sessionId}: the resident process holds `
      + `${runner.backgroundWorkDescriptions.length} background task(s) that retiring it would lose`,
    );
    return NOT_APPLICABLE;
  }

  // Requirement 9 is that the user's message runs whatever happens here, so
  // NOTHING below may throw out of this function. `runCompactionTurn` creates an
  // agent and touches the runner before its own `try`, and a throw there (a
  // container that will not hand back a proxy) would reject the hook, skip both
  // callers' executors, and lose the user's message entirely — without even the
  // failure notice this outcome exists to carry.
  let outcome: CompactOutcome;
  try {
    outcome = await runCompactionTurn({ turnDeps, runner, agentId, sessionId, createAgent });
  } catch (err) {
    outcome = { kind: "failed", detail: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.kind === "compacted") {
    // The compaction card (docs/178) is the record, emitted and persisted by the
    // turn's own listeners. Nothing to add.
    return { outcome };
  }

  // Requirement 9 — "the transcript says that the compaction did not succeed, so
  // a failure is never silent". The two shapes are deliberately distinguishable:
  // a user who reads "reported no compaction" knows the backend accepted the
  // request and did nothing, which is a different thing to report upstream than
  // a crash.
  const notice = outcome.kind === "failed"
    ? `The context could not be compacted before this message ran, so this turn continues with the `
      + `full conversation. ${outcome.detail}`
    : "The agent reported no compaction, so this turn continues with the full conversation.";

  let recorded = false;
  const record = (sid: string, anchored: boolean): void => {
    if (recorded) return;
    try {
      if (anchored) {
        emitNoticeInTurn(runner, sid, notice, deps.chatHistoryManager, "warn");
      } else {
        emitNoticePostTurn(
          (m) => runner.emitMessage(m),
          deps.chatHistoryManager,
          sid,
          notice,
          "warn",
        );
      }
      recorded = true;
    } catch (err) {
      // Same shape as the reset hook's: a missing notice is a regression, a
      // notice that kills the turn is a worse one. The latch stays OPEN on a
      // failed attempt so the `finally` route can retry.
      console.error(
        `[pre-turn-compact] notice failed for ${sid}`
          + `${anchored ? " (will retry on the post-turn fallback)" : ""}:`,
        err,
      );
    }
  };

  return {
    outcome,
    afterUserMessagePersisted: (sid) => { record(sid, true); },
    ensureRecorded: (sid) => { record(sid, false); },
  };
}

/**
 * Run exactly one compaction turn and report what it achieved.
 *
 * Mirrors `dispatched-turn.ts`'s system-turn spawn discipline, because the
 * hazards are the same ones: a resident streaming process left installed would
 * make the fresh `/agent/start` 409 into a kill+restart, and retiring it without
 * settling it strands a turn the notify-on-merge supervisor then re-delivers
 * (planning#318).
 */
async function runCompactionTurn(args: {
  turnDeps: SystemTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  createAgent: (agentId: AgentId) => AgentProcess;
}): Promise<CompactOutcome> {
  const { turnDeps, runner, agentId, sessionId, createAgent } = args;

  // ── Turn ownership, borrowed and given back ───────────────────────────────
  //
  // The executor OWNS the runner's turn-lifecycle state, and it releases that
  // state when the turn it is running ends — which here is the compaction, not
  // the user's message. Three pieces have to be shielded, and each one was a
  // live defect before this block existed:
  //
  //  1. `systemTurnInProgress`. `finishTurn` clears it, and the caller then
  //     spends seconds in the branch reset (a `git fetch`, a force-push) before
  //     the user's turn claims the runner. A message arriving in that window
  //     reads the session as idle and is ADMITTED — two agents, one slot, one
  //     working tree. Held across the whole nested turn INCLUDING the settle
  //     gap (`tryDrain` clears `running` several awaits before `onTurnComplete`
  //     fires), because the WS send handler queues on exactly this flag.
  //  2. `activeDeliveryId`. The executor assigns it unconditionally, including
  //     to `undefined`, so the compaction erases the delivery a dispatched
  //     continuation is running on behalf of — and `hasDelivery` then answers
  //     false for a delivery that is very much in flight, which is what a
  //     merge-watch retry supervisor reads before re-sending.
  //  3. `running`, on the way out. Restored to true rather than to its prior
  //     value: the caller is mid-send and owns the session until its own
  //     executor takes over a few statements later. Its `finally` and the
  //     `verifyRunningState` reconciler are the backstops if it never does.
  const priorSystemTurn = runner.systemTurnInProgress;
  const priorDeliveryId = runner.activeDeliveryId;
  runner.systemTurnInProgress = true;

  // A system turn never adopts the resident streaming process, and declining to
  // adopt does not make it go away — it is still running in the worker, and the
  // fresh spawn below would displace its slot and orphan it. Retire it, settling
  // it first so its own late `agent_done` (dropped as a stale spawn) is not the
  // only thing that would have ended it.
  const outgoing = runner.getAgent();
  if (outgoing) {
    outgoing.emit("superseded");
    try { outgoing.kill(); } catch { /* already gone is the state we wanted */ }
    runner.setAgent(null);
    runner.isStreamingActive = false;
  }

  const agent = createAgent(agentId);
  runner.setAgent(agent);

  // The one thing the turn's own listeners cannot tell us. They emit and persist
  // the compaction card on `agent_compacted`, but a turn that produced no such
  // event completes exactly like one that did — which is the false success
  // docs/276 req 2 exists to rule out.
  let sawCompaction = false;
  agent.on("event", (event: AgentEvent) => {
    if (event.type === "agent_compacted") sawCompaction = true;
  });

  let settle: (outcome: CompactOutcome) => void = () => {};
  const settled = new Promise<CompactOutcome>((resolve) => {
    let done = false;
    settle = (outcome) => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
  });

  const timer = setTimeout(() => {
    settle({
      kind: "failed",
      detail: `The agent did not finish compacting within ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s.`,
    });
    // Nothing else will end this process: it never settled, so the executor's
    // terminal paths have not run. Left alive it holds the agent slot the user's
    // turn is about to take, and every event it emits would land on that turn.
    try { agent.kill(); } catch { /* already gone */ }
    if (runner.getAgent() === agent) runner.setAgent(null);
  }, COMPACTION_TIMEOUT_MS);

  try {
    // Deliberately NOT awaited — see the `return await settled` below.
    void executeAgentTurn(runner, turnDeps, agent, {
      agentId,
      sessionId,
      prompt: `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`,
      // Never rendered — `emitUserEcho` is false and no user row is persisted.
      // Kept honest anyway: it is what the CLI was actually given.
      userText: `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`,
      activity: "Compacting context",
      // ShipIt started this, not the user. A `/compact` bubble here would show a
      // command nobody typed; the compaction card is the record.
      emitUserEcho: false,
      persistUserMessage: () => {},
      isNewSession: false,
      fallbackTitle: "",
      turnStartHeadHash: null,
      // `postTurn: "none"` returns before the drain, so this is unreachable —
      // present because `TurnInput` requires it, and a no-op is the only correct
      // body: the user's turn has not started, so there is nothing to drain onto.
      drainNext: async () => {},
      emit: (msg) => runner.emitMessage(msg),
      // The two flags that make this a step inside the user's turn rather than a
      // turn of its own. See this module's header.
      postTurn: "none",
      systemTurn: true,
      compact: true,
      // Outcome over exit code (docs/276 req 2), in BOTH directions. A turn that
      // emitted `agent_compacted` compacted, however its process then ended —
      // the history really was replaced, and reporting that as a failure would
      // put a false notice in the transcript. And a turn that ended cleanly
      // without the event did NOT compact, however clean its exit.
      onTurnComplete: (turnOutcome) => {
        settle(
          sawCompaction
            ? { kind: "compacted" }
            : turnOutcome.status === "completed"
              ? { kind: "no-compaction" }
              : {
                  kind: "failed",
                  detail: turnOutcome.detail
                    ?? `The compaction turn ended as “${turnOutcome.status}”.`,
                },
        );
      },
    }).catch((err: unknown) => {
      // A throw out of `executeAgentTurn` itself (env prep, run-param assembly)
      // means the turn never started, so `onTurnComplete` will never fire.
      settle({ kind: "failed", detail: err instanceof Error ? err.message : String(err) });
    });
    // `settled` is the ONLY thing this function waits for, and the executor's
    // promise is deliberately not part of that wait.
    //
    // Awaiting the executor first would make the timeout unable to end a setup
    // that stalls INSIDE it: `prepareAgentEnv` and `buildRunParams` are awaits
    // the timer cannot interrupt, so a hung credential round-trip parked the
    // user's message forever while the timer fired into a promise nobody was
    // waiting on. The executor reaches this latch by its own routes instead —
    // `onTurnComplete` on every terminal path, the `catch` above if it throws
    // before starting a turn at all — so nothing is dropped by not awaiting it.
    return await settled;
  } finally {
    clearTimeout(timer);
    // Hand the slot back empty. The user's turn resolves its own agent right
    // after this returns, and a spent compaction proxy left installed would take
    // that turn's `superseded` settlement (harmless) and, in container mode, own
    // the SSE routing its events depend on (not harmless).
    if (runner.getAgent() === agent) runner.setAgent(null);
    // Give back what was borrowed above. In a `finally` because the timeout path
    // reaches here WITHOUT the executor's terminal sequence having run, so this
    // is the only thing that puts `systemTurnInProgress` back — left set, it
    // suppresses live steering for the rest of the session and makes the WS
    // queue drain stand down, stranding every later message.
    runner.systemTurnInProgress = priorSystemTurn;
    runner.activeDeliveryId = priorDeliveryId;
    // The caller is still mid-send and owns the session until its own executor
    // claims the runner; until then nothing else may be admitted.
    runner.running = true;
  }
}
