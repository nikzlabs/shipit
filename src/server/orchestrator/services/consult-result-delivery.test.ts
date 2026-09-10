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
    expect(dispatched.text).toContain(SPAWN_ID);
    expect(dispatched.text).toContain("shipit agent result");
    expect(dispatched.text).toContain("reviewer");
    expect(dispatched.text).not.toContain("Looks fine.");
    expect(storedCard(ctx)?.wakeDelivery?.outcome).toBe("queued");
  });

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
