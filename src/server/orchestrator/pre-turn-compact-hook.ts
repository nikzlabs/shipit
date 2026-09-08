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
 * ## It owns the agent SLOT, and is not a turn
 *
 * docs/295's plan.md left one thing unproven: whether a compaction could run in
 * a turn's *pre-spawn phase*. It took two answers.
 *
 * **A process spawned BESIDE the turn's agent cannot work.** In container mode
 * the SSE relay resolves every worker event against the proxy currently
 * installed in the runner's single `_agent` slot and drops the rest
 * (`container-session-runner.ts` `isStaleSpawnEvent` / the `(no _agent)` drop).
 * Such a process would receive no `agent_compacted`, no `done` and no `error` —
 * it would hang until a timeout, every time, in production but never in an
 * in-process test. So the compaction must OWN the slot.
 *
 * **But owning the slot does not make it a turn**, and conflating those two was
 * the mistake this file was first written around — see
 * {@link runCompactionOperation}, which carries the full account. It installs a
 * proxy, wires four narrow listeners, spawns, awaits its own latch, and clears
 * the slot. It cannot commit, push, drain, settle, announce readiness or publish
 * a delivery, by construction rather than by a flag.
 *
 * Admission for the whole surrounding phase is held by the CALLER, through
 * `pre-turn-hold.ts` — not here, and not by borrowing the executor's flags.
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

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentId, AgentProcess, CompactionCard } from "../shared/types.js";
import { isResetEligible, type ResetEligibleSignalDeps } from "./services/pre-turn-reset.js";
import {
  recheckMergeBeforeTurn,
  type MergeRecheckOutcome,
  type PreTurnMergeRecheckDeps,
} from "./services/pre-turn-merge-recheck.js";
import {
  emitNoticeInTurn,
  emitNoticePostTurn,
  type InProgressPersister,
} from "./chat-card-persistence.js";
import type { SessionRunnerInterface, SystemTurnDeps } from "./session-runner.js";
import { getAgentCapabilities } from "../shared/agent-registry.js";
import { detectMissingConversation } from "./missing-conversation.js";
import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";

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
   * The docs/282 merge recheck's answer, when this hook paid for it — hand it
   * straight to `applyPreTurnReset` as its `mergeRecheck`.
   *
   * Both gates read the same merge state, and inside the poll window that state
   * changes: without sharing one probe the compaction would see "not merged"
   * and skip while the reset, probing a moment later, discovered the merge and
   * moved the branch. The user would get a continuation that reset without
   * compacting, under a setting they were told governs both. Sharing the answer
   * is also what keeps it at ONE network probe per turn.
   *
   * Absent when this hook returned before probing (the cheap gates), in which
   * case the reset does its own as it always did.
   */
  mergeRecheck?: MergeRecheckOutcome;
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
  /**
   * docs/282's recheck deps, so this hook can refresh the merge state BEFORE it
   * decides — see {@link PreTurnCompactHookResult.mergeRecheck}. Optional: a
   * runtime that cannot probe (minimal test wiring) simply gates on the state
   * the poller last recorded, exactly as this hook did before.
   */
  mergeRecheckDeps?: Pick<PreTurnMergeRecheckDeps, "verifyPrState" | "awaitMergeHandling">;
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
  const { intent } = args;

  // Requirement 5 — the untick applies to this one message. Checked before
  // anything expensive: an unticked box must cost nothing, not merely change
  // nothing.
  if (intent === false) return NOT_APPLICABLE;

  // Admission is held by the CALLER, across the whole pre-turn phase
  // (`pre-turn-hold.ts`) — the merge probe and the eligibility check here, the
  // agent-slot resolution, and the branch reset after it. It was held in this
  // function once, and released one step too early: the destructive half of the
  // phase then ran with the session reading admissible again.
  return decideAndCompact(args);
}

/**
 * Attach a transcript notice to an outcome, on both delivery routes.
 *
 * `afterUserMessagePersisted` anchors it inside the fresh turn, right after the
 * user row; `ensureRecorded` is the `finally` fallback for a turn that died
 * before reaching that anchor. Latched, so exactly one of the two ever writes —
 * and the latch stays OPEN on a failed attempt, so the fallback can retry.
 */
function attachNotice(
  runner: SessionRunnerInterface,
  chatHistoryManager: InProgressPersister,
  outcome: CompactOutcome,
  notice: string,
): PreTurnCompactHookResult {
  let recorded = false;
  const record = (sid: string, anchored: boolean): void => {
    if (recorded) return;
    try {
      if (anchored) {
        emitNoticeInTurn(runner, sid, notice, chatHistoryManager, "warn");
      } else {
        emitNoticePostTurn((m) => runner.emitMessage(m), chatHistoryManager, sid, notice, "warn");
      }
      recorded = true;
    } catch (err) {
      // A missing notice is a regression; a notice that kills the turn is a
      // worse one. Same shape as the reset hook's.
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

async function decideAndCompact(
  args: PreTurnCompactHookArgs,
): Promise<PreTurnCompactHookResult> {
  const { deps, turnDeps, runner, agentId, sessionId, sessionDir, createAgent } = args;
  // Requirement 11 — the shared setting. Off means neither control is offered,
  // so a stale `compactContext: true` from a client that has not seen the
  // setting change still cannot compact.
  if (!deps.getAutoResetMergedBranch()) return NOT_APPLICABLE;
  // Requirement 10 — a backend that cannot compact is not asked to.
  if (!(getAgentCapabilities(agentId)?.supportsCompaction ?? false)) return NOT_APPLICABLE;

  // An armed conversation replay (a rewind, a fork, a docs/153 recovery) means
  // the CLI-side conversation is absent or must not be continued, and the user's
  // turn is about to start a fresh one seeded from ShipIt's own transcript.
  // There is nothing to compact — and compacting anyway would DESTROY the
  // replay, because `buildAgentRunParams` consumes it read-and-clear: this
  // spawn would take the seed, `/compact` a conversation that holds only that
  // seed, and hand the user's turn a summary of nothing. Peeked rather than
  // consumed, so the turn still gets it.
  if (turnDeps.listenerDeps.sessionManager.get(sessionId)?.conversationReplay) {
    return NOT_APPLICABLE;
  }

  // docs/282, shared with the reset (docs/295). Merge detection is poll-driven,
  // so a turn admitted inside the poll window reads a session that has not been
  // noticed as merged yet. Probing HERE rather than letting the reset probe a
  // moment later is what stops the two gates disagreeing: the compaction would
  // skip on the stale answer while the reset went on to move the branch, and
  // requirement 13 says a continuation compacts in the same conditions in which
  // its branch is reset. The answer is handed to the reset so it is one probe,
  // not two.
  let mergeRecheck: MergeRecheckOutcome | undefined;
  if (deps.mergeRecheckDeps) {
    mergeRecheck = await recheckMergeBeforeTurn(
      { ...deps, ...deps.mergeRecheckDeps },
      sessionId,
      sessionDir,
    );
  }
  /** Everything from here on must carry the probe's answer to the reset. */
  const withRecheck = (result: PreTurnCompactHookResult): PreTurnCompactHookResult =>
    mergeRecheck === undefined ? result : { ...result, mergeRecheck };

  // docs/282's one outcome that is a DECISION rather than a refresh: the merge
  // landed inside the probe but its bookkeeping did not finish. The reset stands
  // down on it (`pre-turn-reset-hook.ts`), and this must stand down with it —
  // sharing the probe is pointless if the two gates then act on it differently.
  //
  // The harm is specific and is req 7's: a session can read as merged here
  // (`mergedAt` stamped) while the reset returns an empty prefix, so on Codex
  // and OpenCode — which ignore the compaction instructions entirely — the turn
  // would run with a summarized context and NOTHING telling the agent its work
  // shipped. The next turn, against settled state, does both.
  if (mergeRecheck === "unsettled") return withRecheck(NOT_APPLICABLE);

  let eligible: boolean;
  try {
    eligible = await isResetEligible(deps, sessionId, sessionDir);
  } catch (err) {
    // `isResetEligible` is already fail-safe-false internally; this covers a
    // throw from constructing its deps. Either way "we could not tell" means
    // "do not compact", and it is not worth a notice — the user asked for a
    // compaction on a merge boundary we cannot prove exists.
    console.error(`[pre-turn-compact] eligibility check failed for ${sessionId}:`, err);
    return withRecheck(NOT_APPLICABLE);
  }
  if (!eligible) return withRecheck(NOT_APPLICABLE);

  // docs/260 req 13 — a resident process holding background work (a sub-agent
  // review, agent-started background tasks) may not be displaced by a system
  // turn: the fresh spawn retires it and the tokens already spent on that work
  // are lost. `dispatchOnRunner` enforces this by ENQUEUING such a system turn,
  // but this hook drives the executor directly and so bypasses that admission
  // check entirely. Enqueuing is not available here — the compaction has to
  // finish before the user's turn is assembled — so the answer is to skip it.
  // Losing one compaction is a far smaller harm than killing a running review.
  const backgroundWork = runner.getAgent() !== null ? runner.backgroundWorkDescriptions : [];
  if (backgroundWork.length > 0) {
    console.log(
      `[pre-turn-compact] skipping the compaction for ${sessionId}: the resident process holds `
      + `${backgroundWork.length} background task(s) that retiring it would lose`,
    );
    // Told, not swallowed. Every OTHER `not-applicable` above means the control
    // was never offered or the box was unticked — nothing to report. This one is
    // different: the box WAS on screen, the user left it ticked, and the action
    // they asked for did not happen. Silence there is the requirement-9 failure
    // shape in a case that is not, strictly, a failure of the compaction.
    return withRecheck(attachNotice(
      runner,
      deps.chatHistoryManager,
      { kind: "not-applicable" },
      `The context was not compacted before this message ran: the agent is still holding `
      + `${backgroundWork.length === 1 ? "background work" : `${backgroundWork.length} background tasks`} `
      + `(${backgroundWork.join(", ")}), and compacting would have discarded it. This turn continues `
      + `with the full conversation.`,
    ));
  }

  // Requirement 9 is that the user's message runs whatever happens here, so
  // NOTHING below may throw out of this function. `runCompactionTurn` creates an
  // agent and touches the runner before its own `try`, and a throw there (a
  // container that will not hand back a proxy) would reject the hook, skip both
  // callers' executors, and lose the user's message entirely — without even the
  // failure notice this outcome exists to carry.
  let outcome: CompactOutcome;
  try {
    outcome = await runCompactionOperation({
      deps, turnDeps, runner, agentId, sessionId, createAgent,
    });
  } catch (err) {
    outcome = { kind: "failed", detail: err instanceof Error ? err.message : String(err) };
  }

  if (outcome.kind === "compacted") {
    // The compaction card (docs/178) is the record, emitted and persisted by the
    // operation's own listener. Nothing to add.
    return withRecheck({ outcome });
  }
  // The operation stood down before spawning anything (a conversation replay
  // appeared during credential prep). Nothing ran, nothing was lost, and the
  // user's turn is about to replay its own transcript — so there is nothing to
  // report, exactly as for the gates that never got this far.
  if (outcome.kind === "not-applicable") return withRecheck({ outcome });

  // Requirement 9 — "the transcript says that the compaction did not succeed, so
  // a failure is never silent". The two shapes are deliberately distinguishable:
  // a user who reads "reported no compaction" knows the backend accepted the
  // request and did nothing, which is a different thing to report upstream than
  // a crash.
  return withRecheck(attachNotice(
    runner,
    deps.chatHistoryManager,
    outcome,
    outcome.kind === "failed"
      ? `The context could not be compacted before this message ran, so this turn continues with the `
        + `full conversation. ${outcome.detail}`
      : "The agent reported no compaction, so this turn continues with the full conversation.",
  ));
}

/**
 * Run exactly one compaction and report what it achieved.
 *
 * ## Why this is NOT `executeAgentTurn`
 *
 * The first shape of this hook drove the compaction through the turn executor
 * with `postTurn: "none"` + `systemTurn: true`, on the reasoning that a
 * compaction process must occupy the runner's `_agent` slot (true — the SSE
 * relay routes worker events through nothing else) and therefore had to be a
 * turn. That does not follow, and two rounds of review found the difference the
 * hard way: `executeAgentTurn` brings the whole TURN LIFECYCLE, and every part
 * of it is wrong for a maintenance step nested inside someone else's send.
 *
 * It publishes and then clears `activeDeliveryId`, so a dispatched
 * continuation's delivery reads as not-in-flight for the compaction's whole
 * duration. It clears `running`, announces `turn_result`, broadcasts
 * `session_agent_finished` and fires the runner's `idle` event — so `shipit
 * session wait` reports the session ready, and a redelivery supervisor reports
 * work delivered, before the user's message has run at all. It bumps the turn
 * epoch and resets the transcript accumulators, so the compaction's own card
 * lands as in-progress rows that the user's turn then replaces. Each of those
 * was patched individually, and each patch was another borrow-and-restore of
 * state that the executor owns and this operation has no business touching.
 *
 * So it owns the SLOT and nothing else. Everything it genuinely needs is
 * already factored: `prepareAgentEnv` for credentials, `buildRunParams` for the
 * spawn shape, the adapter's own `compact` mapping, and `emitChatCard` for the
 * docs/178 card. What it does not need — commit, push, drain, settlement,
 * readiness, delivery identity, transcript accumulation — it now cannot do by
 * construction, rather than by a flag that has to be remembered.
 *
 * `running` stays FALSE throughout, which is load-bearing twice over: no
 * completion signal is emitted for a turn that has not run, and `emitChatCard`
 * takes its already-final append path, so the compaction card is durable the
 * moment it is written instead of being an in-progress row awaiting a
 * finalization this operation would have to remember to do. Admission is held
 * by {@link SessionRunnerInterface.preTurnHold} instead — the same shape
 * docs/288's merge hold uses, and for the same reason.
 */
async function runCompactionOperation(args: {
  deps: PreTurnCompactHookDeps;
  turnDeps: SystemTurnDeps;
  runner: SessionRunnerInterface;
  agentId: AgentId;
  sessionId: string;
  createAgent: (agentId: AgentId) => AgentProcess;
}): Promise<CompactOutcome> {
  const { deps, turnDeps, runner, agentId, sessionId, createAgent } = args;

  // A resident streaming process cannot stay installed: the fresh
  // `/agent/start` below would 409 against it, and the incoming proxy would
  // displace its slot and orphan it. Settle it FIRST — its own late
  // `agent_done` arrives with the previous spawn's runToken and is dropped by
  // the docs/146 stale-spawn guard, so without this the retired turn's
  // settlement stays pending forever and a supervisor re-delivers it
  // (planning#318). Retiring one that holds background work is refused earlier,
  // by the caller.
  const outgoing = runner.getAgent();
  if (outgoing) {
    outgoing.emit("superseded");
    try { outgoing.removeAllListeners(); } catch { /* already bare */ }
    try { outgoing.kill(); } catch { /* already gone is the state we wanted */ }
    runner.setAgent(null);
    runner.isStreamingActive = false;
  }

  const agent = createAgent(agentId);
  runner.setAgent(agent);

  let sawCompaction = false;
  /**
   * Read by the spawn below, AFTER its awaits. The timeout does not reach into
   * `prepareAgentEnv`, so a credential round-trip that resolves late would
   * otherwise call `agent.run()` on a slot this operation has already handed
   * back — and in container mode a conflicting `/agent/start` retries and can
   * kill the worker's resident process, which by then is the user's own turn.
   */
  let finished = false;
  let settle: (outcome: CompactOutcome) => void = () => {};
  const settled = new Promise<CompactOutcome>((resolve) => {
    settle = (outcome) => {
      if (finished) return;
      finished = true;
      resolve(outcome);
    };
  });

  /**
   * docs/153 Fix 2 — the CLI could not resume the conversation we named, so the
   * id it reports next is a fresh, useless one. Writing it back would turn one
   * failed resume into a permanent one for the user's turn and every turn after
   * it. The turn listeners honour the same signal; this operation wires its own
   * listeners and so has to honour it itself.
   */
  let missingConversation = false;

  // The narrow listener set. `wireAgentListeners` is deliberately NOT used: it
  // accumulates a transcript, records usage, drives auth recovery and finalizes
  // in-progress rows — all of which belong to a turn. These four are what a
  // compaction actually produces.
  agent.on("event", (event: AgentEvent) => {
    if (event.type === "agent_compaction_started") {
      // Transient progress, emit-only. It has no place in the scrollback.
      runner.emitMessage({
        type: "compaction_status",
        sessionId,
        active: true,
        ...(event.trigger ? { trigger: event.trigger } : {}),
      });
      return;
    }
    if (event.type === "agent_compacted") {
      sawCompaction = true;
      const card: CompactionCard = {
        id: `compaction-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        trigger: "manual",
        ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      };
      // Emitted AND appended directly, rather than through `emitChatCard`.
      //
      // `emitChatCard` branches on `runner.running`, and both callers set that
      // true before this hook is reached (`send-message.ts` right before
      // `runAgentWithMessage`; `dispatchOnRunner` in the same synchronous tick
      // as the delivery). So it would take the IN-PROGRESS path and record the
      // card against a turn that has not started — which the user's turn then
      // deletes at its first `replaceInProgress`, exactly the docs/236 failure.
      // The card would render live and be gone on reload.
      //
      // This is the same direct-append route `emitNoticePostTurn` and the reset
      // hook's late trigger take, and for the same reason: a record created
      // OUTSIDE a turn has to be final when it is written, because there is no
      // turn boundary coming that will finalize it.
      runner.emitMessage({ type: "compaction_card", sessionId, card });
      deps.chatHistoryManager.append(sessionId, { role: "assistant", text: "", compaction: card });
      return;
    }
    if (event.type === "agent_result") {
      // The one piece of session state a compaction MUST write back: it can
      // leave the backend on a new agent session id, and a stale id would
      // resume the pre-compaction conversation and throw the whole compaction
      // away. `buildRunParams` reads this fresh from the database at spawn
      // time, so writing it here is what the user's turn picks up.
      //
      // Not when the resume failed, though — see `missingConversation`. A
      // doomed spawn emits a fresh id here too, and taking it would leave the
      // session pointing at a conversation that never existed.
      if (!missingConversation) {
        turnDeps.listenerDeps.sessionManager.setAgentSessionId(sessionId, event.sessionId);
      }
      // …and this is a TERMINAL event, not merely an informative one. Two of the
      // four backends end a compaction here and never emit `done`: OpenCode's
      // `runCompaction` settles the turn through a synthetic `agent_result`
      // because it spawns no long-lived process (`opencode/adapter.ts`), and
      // Codex does the same in compact-spawn mode (`codex-event-handler.ts`).
      // Waiting for `done` on those meant every successful compaction held the
      // user's message for the full 300 s and was then reported as a timeout
      // failure that had not happened.
      //
      // Safe for the other two: Claude and Grok both emit `agent_compacted`
      // from a stream event that PRECEDES their result, so settling here can
      // never mistake a real compaction for `no-compaction`.
      settle(
        sawCompaction
          ? { kind: "compacted" }
          : event.status === "error"
            ? { kind: "failed", detail: event.error ?? "the compaction reported an error" }
            : { kind: "no-compaction" },
      );
    }
  });
  agent.on("log", (source: string, text: string) => {
    if (detectMissingConversation(source, text)) missingConversation = true;
  });
  agent.on("done", () => {
    settle(
      sawCompaction
        ? { kind: "compacted" }
        : { kind: "no-compaction" },
    );
  });
  agent.on("error", (err: Error) => {
    // Outcome over exit code, in both directions (docs/276 req 2): a compaction
    // that HAPPENED counts however the process then ended — the history really
    // was replaced, and a failure notice for it would be false.
    settle(
      sawCompaction
        ? { kind: "compacted" }
        : { kind: "failed", detail: err.message },
    );
  });

  const timer = setTimeout(() => {
    settle(
      sawCompaction
        ? { kind: "compacted" }
        : {
            kind: "failed",
            detail: `The agent did not finish compacting within ${Math.round(COMPACTION_TIMEOUT_MS / 1000)}s.`,
          },
    );
  }, COMPACTION_TIMEOUT_MS);

  /** The route this spawn actually ran on, for the teardown's token write-back. */
  let spawnRoute: { kind: ProviderRouteKind; id: string } | undefined;

  try {
    // Started, deliberately NOT awaited. `prepareAgentEnv` and `buildRunParams`
    // are awaits the timer cannot interrupt, so sequencing them ahead of the
    // settle latch would park the user's message forever on a hung credential
    // round-trip while the timeout fired into a promise nobody was waiting on.
    // `settled` is the ONLY thing this function waits for; the spawn reaches it
    // through the agent's own events, or through this `catch` if it never gets
    // as far as starting one.
    void (async () => {
      // Credentials first, exactly as a turn's spawn does — the step that keeps
      // a subscription token fresh at the moment the CLI starts.
      const prep = await turnDeps.prepareAgentEnv?.(sessionId, agentId, {});
      spawnRoute = prep?.turnRoute;
      // The replay is checked BEFORE this step too, and has to be checked again
      // HERE, because this step is one of the things that arms one: the docs/153
      // leak repair runs inside credential prep, and on finding no resumable
      // conversation on disk it clears the id and arms a replay from ShipIt's own
      // transcript (`session-agent-env.ts` `armConversationReplay`).
      //
      // `buildRunParams` below would then CONSUME it — read-and-clear — and this
      // spawn would summarize a conversation holding nothing but that seed. If it
      // then failed, the user's turn would have neither the original conversation
      // nor the recovery replay: it would start from nothing, under a notice
      // saying it continues with the full conversation. Stand down instead; the
      // user's turn gets the replay it was armed for.
      if (turnDeps.listenerDeps.sessionManager.get(sessionId)?.conversationReplay) {
        console.log(
          `[pre-turn-compact] standing down for ${sessionId}: credential prep armed a conversation `
          + `replay, which this spawn would consume`,
        );
        settle({ kind: "not-applicable" });
        return;
      }
      // The route selection has to be threaded as a VALUE (docs/260 §1b) —
      // `buildAgentRunParams` cannot recover it from the session row, which no
      // longer records one. Dropping it made the compaction spawn against the
      // service's group credential rather than the account routing picked,
      // which can be an account routing had already set aside.
      const params = await turnDeps.buildRunParams(
        sessionId,
        agentId,
        `/compact ${POST_MERGE_COMPACTION_INSTRUCTIONS}`,
        prep?.turnRoute,
        { compact: true },
      );
      // The awaits above are the whole reason this check exists: by here the
      // operation may have timed out, given the slot back, and let the user's
      // turn install its own agent. Starting now would run a compaction the
      // caller stopped waiting for, into someone else's slot.
      if (finished || runner.getAgent() !== agent) {
        console.log(
          `[pre-turn-compact] abandoning the compaction spawn for ${sessionId}: `
          + `${finished ? "the operation already settled" : "the agent slot changed"} while it was starting`,
        );
        return;
      }
      agent.run(params);
    })().catch((err: unknown) => {
      settle({ kind: "failed", detail: err instanceof Error ? err.message : String(err) });
    });
    return await settled;
  } finally {
    clearTimeout(timer);
    // docs/149 — a CLI that rotated its OAuth token on the way out has written
    // it into the session's credential subtree, and only this call publishes it
    // back to the orchestrator source for sibling sessions to use. A turn's
    // executor does it through `trySyncToken`; this spawn has no executor, so a
    // token rotated by the compaction was stranded in the container.
    try {
      turnDeps.finalizeAgentEnv?.(sessionId, agentId, spawnRoute
        ? { providerRouteKind: spawnRoute.kind, providerRouteId: spawnRoute.id }
        : undefined);
    } catch (err) {
      console.error(`[pre-turn-compact] finalizing the agent environment for ${sessionId} failed:`, err);
    }
    // The transient indicator is cleared on EVERY exit, not just on
    // `agent_compacted`. A compaction that announced itself and then errored or
    // timed out left "Compacting…" up across the user's whole turn, with only a
    // client-side reset to take it down.
    runner.emitMessage({ type: "compaction_status", sessionId, active: false });
    // Hand the slot back empty, and take this process's listeners off first so
    // a late `done` from the kill cannot re-settle anything. Unconditional: on
    // the timeout path nothing else will end it, and left installed it would
    // own the SSE routing the user's turn is about to depend on.
    try { agent.removeAllListeners(); } catch { /* already bare */ }
    try { agent.kill(); } catch { /* already gone */ }
    if (runner.getAgent() === agent) runner.setAgent(null);
  }
}
