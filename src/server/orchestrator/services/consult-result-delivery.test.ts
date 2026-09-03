/**
 * docs/287 — delivering a finished background consult to the agent that asked
 * for it.
 *
 * The defect these pin: on a ShipIt-started turn (a merge wake, a child report,
 * CI fix) the CLI runs one-shot, so it reaps its `Bash(run_in_background)` jobs
 * and exits at turn end and `agent_self_wake` is structurally impossible. The
 * consult finished, its card persisted, the user read the review in the
 * transcript — and the agent was never re-invoked. Observed twice in production
 * on 2026-09-03.
 *
 * So the tests are mostly about WHEN NOT to wake: a wake that fires while the
 * caller is still holding the HTTP call, or on top of a resident CLI that is
 * about to self-wake anyway, is a duplicate turn rather than a fix.
 *
 * Real `SessionManager` / `ChatHistoryManager` over an in-memory DB, with a fake
 * runner registry — the same shape `session-report.test.ts` uses, and for the
 * same reason: a non-container runner makes `wakeSessionWithTurn` skip the
 * worker-ready wait and land on a recorded `dispatch`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type {
  SessionRunnerInterface,
  SessionRunnerRegistry,
  AgentDispatchOptions,
} from "../session-runner.js";
import type { SubAgentConsultCard } from "../../shared/types.js";
import { TURN_COMPLETED, turnErrored } from "../turn-settlement.js";
import {
  deliverConsultResultByWake,
  type ConsultResultDeliveryDeps,
} from "./consult-result-delivery.js";

class FakeRunner {
  running = false;
  isStreamingActive = false;
  turnEpoch = 7;
  disposed = false;
  agentId = "claude" as const;
  queueLength = 0;
  dispatched: AgentDispatchOptions[] = [];
  /** Set by a test that wants the wake to fail at dispatch. */
  dispatchThrows: Error | null = null;
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): void {
    if (this.dispatchThrows) throw this.dispatchThrows;
    this.dispatched.push(opts);
  }
  emitMessage(): void {}
}

const CARD_ID = "card-1";
const SPAWN_ID = "spawn-abc";

function terminalCard(over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard {
  return {
    cardId: CARD_ID,
    spawnId: SPAWN_ID,
    subAgentId: "codex",
    roleName: "reviewer",
    status: "success",
    createdAt: "2026-09-03T06:04:31.000Z",
    outputMarkdown: "Looks fine.",
    ...over,
  };
}

function makeCtx() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  const runners = new Map<string, FakeRunner>();
  const runnerRegistry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string, dir: string) => {
      let r = runners.get(id);
      if (!r) {
        r = new FakeRunner(dir);
        runners.set(id, r);
      }
      return r as unknown as SessionRunnerInterface;
    },
    dispose: (id: string) => { runners.delete(id); },
  } as unknown as SessionRunnerRegistry;

  sessionManager.track("s1", "Ops session", "/ws/s1");

  const deps: ConsultResultDeliveryDeps = {
    sessionManager,
    runnerRegistry,
    chatHistoryManager,
    defaultAgentId: "claude",
  };
  return { db, sessionManager, chatHistoryManager, runners, runnerRegistry, deps };
}

/** Persist the terminal card exactly as `finalizeConsultCard` leaves it. */
function persistCard(ctx: ReturnType<typeof makeCtx>, card: SubAgentConsultCard): void {
  ctx.chatHistoryManager.append("s1", { role: "assistant", text: "", subAgentConsult: card });
}

function storedCard(ctx: ReturnType<typeof makeCtx>): SubAgentConsultCard | undefined {
  return ctx.chatHistoryManager.listSubAgentConsultCards("s1").find((c) => c.cardId === CARD_ID);
}

describe("deliverConsultResultByWake (docs/287)", () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  /**
   * The incident itself: the originating turn is a ShipIt-started one-shot that
   * has already ended, nothing is running, and no resident CLI exists to notice
   * the finished job. Nobody would ever tell the agent.
   */
  it("wakes an idle session with a self-describing prompt naming the run id", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    const runner = ctx.runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: true });
    expect(runner.dispatched).toHaveLength(1);
    const dispatched = runner.dispatched[0];
    expect(dispatched.systemTurn).toBe(true);
    // Self-describing: it may run much later, so it must name the run rather
    // than lean on conversation context — and it points at `shipit agent result`
    // instead of carrying a second copy of the output (planning#247).
    expect(dispatched.text).toContain(SPAWN_ID);
    expect(dispatched.text).toContain("shipit agent result");
    expect(dispatched.text).toContain("reviewer");
    expect(dispatched.text).not.toContain("Looks fine.");
    // The attempt is recorded on the durable card, not just in memory.
    expect(storedCard(ctx)?.wakeDelivery?.outcome).toBe("queued");
  });

  /**
   * A FOREGROUND consult: the caller is blocked inside `shipit agent run`, which
   * is what is holding this very HTTP call open, and gets the text on stdout.
   * Waking would run a second turn to announce something the agent already has.
   */
  it("does not wake while the originating turn is still in flight", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    const runner = ctx.runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;
    runner.running = true;
    runner.turnEpoch = 7;

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: false, reason: "originating-turn-live" });
    expect(runner.dispatched).toHaveLength(0);
    expect(storedCard(ctx)?.wakeDelivery).toBeUndefined();
  });

  /**
   * …but a LATER turn running is not the same fact, and gating on `running`
   * alone would lose the result all over again. A second child PR merging while
   * the first consult is still going is an ordinary shape in an orchestrating
   * session; `dispatch` enqueues behind the live turn.
   */
  it("wakes when some LATER turn is running, so the result is queued rather than dropped", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    const runner = ctx.runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;
    runner.running = true;
    runner.turnEpoch = 9;

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: true });
    expect(runner.dispatched).toHaveLength(1);
  });

  /**
   * The path that already works: a resident streaming CLI turns the finished
   * background job into `agent_self_wake` (docs/235) and `turn-executor` re-arms
   * it into a real turn. A wake on top of that is a duplicate.
   */
  it("stands down when a resident streaming process will self-wake", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    const runner = ctx.runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;
    runner.isStreamingActive = true;

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: false, reason: "resident-cli-delivers" });
    expect(runner.dispatched).toHaveLength(0);
  });

  /**
   * A disposed runner (idle reclaim, container restart) is exactly the case the
   * old shape lost silently — and `wakeSessionWithTurn` exists to resume it.
   */
  it("wakes a session whose runner is gone entirely", async () => {
    const card = terminalCard();
    persistCard(ctx, card);

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: true });
    expect(ctx.runners.get("s1")?.dispatched).toHaveLength(1);
  });

  /**
   * `cancelled` means ShipIt took the session away from the run — a teardown, a
   * forced dispose, the boot reconcile. There is no result to act on, and waking
   * would boot a container that was just stopped.
   */
  it("does not wake for a cancelled consult", async () => {
    const card = terminalCard({ status: "cancelled", statusDetail: "container torn down" });
    persistCard(ctx, card);

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: false, reason: "cancelled-status", detail: "cancelled" });
    expect(ctx.runners.size).toBe(0);
  });

  /** An `error`/`timeout` consult still owes the agent the fact that it ended. */
  it("wakes for an errored consult, which the agent still has to react to", async () => {
    const card = terminalCard({ status: "error", outputMarkdown: undefined });
    persistCard(ctx, card);

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: true });
    expect(ctx.runners.get("s1")?.dispatched[0].text).toContain("status error");
  });

  /** Fire-once, read from the durable card rather than from process memory. */
  it("does not wake twice for one run", async () => {
    const card = terminalCard();
    persistCard(ctx, card);

    await deliverConsultResultByWake(ctx.deps, { sessionId: "s1", card, originatingTurnEpoch: 7 });
    const second = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(second).toEqual({ woken: false, reason: "already-delivered" });
    expect(ctx.runners.get("s1")?.dispatched).toHaveLength(1);
  });

  /**
   * docs/240 — only `completed` counts as delivered. The stamp is what stops the
   * card claiming a hand-over that never happened.
   */
  it("records the settled outcome on the card", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    await deliverConsultResultByWake(ctx.deps, { sessionId: "s1", card, originatingTurnEpoch: 7 });

    const dispatched = ctx.runners.get("s1")!.dispatched[0];
    dispatched.onTurnComplete!(TURN_COMPLETED);
    expect(storedCard(ctx)?.wakeDelivery?.outcome).toBe("delivered");
  });

  it("records a failed settlement instead of claiming delivery", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    await deliverConsultResultByWake(ctx.deps, { sessionId: "s1", card, originatingTurnEpoch: 7 });

    const dispatched = ctx.runners.get("s1")!.dispatched[0];
    dispatched.onTurnComplete!(turnErrored("agent crashed"));
    expect(storedCard(ctx)?.wakeDelivery).toMatchObject({
      outcome: "failed",
      detail: "agent crashed",
    });
  });

  /**
   * The whole module is best-effort: result delivery, the card, and `shipit
   * agent result` all have to keep working when the wake cannot run.
   */
  it("never throws when the wake fails, and says so on the card", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    const runner = ctx.runnerRegistry.getOrCreate("s1", "/ws/s1", "claude") as unknown as FakeRunner;
    runner.dispatchThrows = new Error("container could not be resumed");

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toMatchObject({ woken: false, reason: "wake-failed" });
    expect(storedCard(ctx)?.wakeDelivery).toMatchObject({ outcome: "failed" });
  });

  it("stands down for an archived session rather than resurrecting it", async () => {
    const card = terminalCard();
    persistCard(ctx, card);
    ctx.sessionManager.archive("s1");

    const decision = await deliverConsultResultByWake(ctx.deps, {
      sessionId: "s1",
      card,
      originatingTurnEpoch: 7,
    });

    expect(decision).toEqual({ woken: false, reason: "no-session" });
    expect(ctx.runners.size).toBe(0);
  });
});
