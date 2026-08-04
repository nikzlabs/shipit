/**
 * Unit tests for upward / lateral session reports (docs/233, SHI-241).
 *
 * Covers the two halves of delivery — the persisted card in each recipient's
 * history and the queued system turn on its runner — plus the guards that make
 * a report safe to expose to an agent: recipients derived from the reporter's
 * own linkage (never agent input), archived peers skipped, validation, and the
 * runaway rate limit.
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
import {
  deliverSessionReport,
  resolveSessionCohort,
  clearSessionReportRateLimits,
  MAX_REPORTS_PER_WINDOW,
  MAX_REPORT_BODY_CHARS,
  type SessionReportDeps,
} from "./session-report.js";
import { ServiceError } from "./types.js";

/**
 * Fake runner recording dispatches + emitted WS messages. Deliberately NOT a
 * `ContainerSessionRunner`, so the wake path skips the worker-ready wait.
 */
class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  queueLength = 0;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): void {
    this.dispatched.push(opts);
  }
  emitMessage(msg: unknown): void {
    this.emitted.push(msg);
  }
}

function makeFakeRegistry(): { registry: SessionRunnerRegistry; runners: Map<string, FakeRunner> } {
  const runners = new Map<string, FakeRunner>();
  const registry = {
    get: (id: string) => runners.get(id) as unknown as SessionRunnerInterface | undefined,
    getOrCreate: (id: string, dir: string) => {
      let r = runners.get(id);
      if (!r) {
        r = new FakeRunner(dir);
        runners.set(id, r);
      }
      return r as unknown as SessionRunnerInterface;
    },
    dispose: (id: string) => {
      runners.delete(id);
    },
  } as unknown as SessionRunnerRegistry;
  return { registry, runners };
}

/** Parent with three children (the cohort from the SHI-241 report). */
function makeCohort() {
  const db = new DatabaseManager(":memory:");
  const sessionManager = new SessionManager(db);
  const chatHistoryManager = new ChatHistoryManager(db);
  const { registry, runners } = makeFakeRegistry();

  sessionManager.track("parent", "Spell catalogs", "/ws/parent");
  for (const [id, title] of [
    ["elementalist", "Elementalist catalog"],
    ["druid", "Druid catalog"],
    ["necromancer", "Necromancer catalog"],
  ]) {
    sessionManager.track(id, title, `/ws/${id}`);
    sessionManager.setParentSession(id, "parent");
    sessionManager.setBranch(id, `shipit/${id}`);
  }

  const deps: SessionReportDeps = {
    sessionManager,
    runnerRegistry: registry,
    chatHistoryManager,
    defaultAgentId: "claude",
  };
  return { db, sessionManager, chatHistoryManager, registry, runners, deps };
}

describe("deliverSessionReport (docs/233)", () => {
  let ctx: ReturnType<typeof makeCohort>;

  beforeEach(() => {
    clearSessionReportRateLimits();
    ctx = makeCohort();
  });

  it("delivers to the parent by default: persisted card + queued system turn", async () => {
    // A runner already in the registry models an attached viewer — that's what
    // the live card broadcast below targets (a recipient with no runner gets the
    // persisted card only, and rehydrates it on switch).
    ctx.registry.getOrCreate("parent", "/ws/parent", "claude");
    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "The shared regen command deletes every catalog.",
      severity: "blocker",
      subject: "regen wipes data/catalogs",
    });

    expect(result.to).toBe("parent");
    expect(result.recipients).toEqual([
      { sessionId: "parent", title: "Spell catalogs", relation: "child", woken: true },
    ]);

    // Card persisted in the PARENT's transcript (survives a switch/reload).
    const card = ctx.chatHistoryManager.load("parent").find((m) => m.sessionReport)?.sessionReport;
    expect(card).toMatchObject({
      fromSessionId: "elementalist",
      fromTitle: "Elementalist catalog",
      fromBranch: "shipit/elementalist",
      relation: "child",
      severity: "blocker",
      subject: "regen wipes data/catalogs",
      body: "The shared regen command deletes every catalog.",
    });

    // Wake-turn queued on the parent's runner, carrying the report verbatim.
    const parent = ctx.runners.get("parent");
    expect(parent?.dispatched).toHaveLength(1);
    expect(parent?.dispatched[0].systemTurn).toBe(true);
    expect(parent?.dispatched[0].text).toContain("BLOCKER");
    expect(parent?.dispatched[0].text).toContain("The shared regen command deletes every catalog.");
    expect(parent?.dispatched[0].text).toContain("report from child");
    expect(parent?.dispatched[0].text.length).toBeLessThan(300);
    expect(parent?.dispatched[0].messageOrigin).toEqual({
      sessionId: "elementalist",
      sessionTitle: "Elementalist catalog",
      relation: "child",
    });

    // Live card broadcast to any attached viewer.
    expect(parent?.emitted).toContainEqual(
      expect.objectContaining({ type: "session_report_card", sessionId: "parent" }),
    );
  });

  it("--to cohort reaches the parent and every live sibling, but never the reporter", async () => {
    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "Heads up",
      to: "cohort",
      severity: "warn",
    });

    // Siblings arrive in the session manager's most-recently-used order, so
    // assert membership, not sequence.
    expect(result.recipients.map((r) => r.sessionId).sort()).toEqual(["druid", "necromancer", "parent"]);
    expect(result.recipients[0]).toMatchObject({ sessionId: "parent", relation: "child" });
    expect(result.recipients.slice(1).every((r) => r.relation === "sibling")).toBe(true);
    // The reporter never receives its own report.
    expect(ctx.chatHistoryManager.load("elementalist").filter((m) => m.sessionReport)).toHaveLength(0);
    // Each sibling is told the reporter is a SIBLING, not a child.
    expect(ctx.runners.get("druid")?.dispatched[0].text).toContain("report from sibling");
  });

  it("skips archived peers", async () => {
    ctx.sessionManager.archive("druid");

    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "Heads up",
      to: "cohort",
    });

    expect(result.recipients.map((r) => r.sessionId).sort()).toEqual(["necromancer", "parent"]);
    expect(ctx.chatHistoryManager.load("druid").filter((m) => m.sessionReport)).toHaveLength(0);
  });

  it("refuses when the reporting session has no parent (top-level or --detached)", async () => {
    ctx.sessionManager.track("solo", "Standalone", "/ws/solo");
    await expect(deliverSessionReport(ctx.deps, "solo", { body: "hi" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(deliverSessionReport(ctx.deps, "solo", { body: "hi" })).rejects.toThrow(/no parent/i);
  });

  it("refuses when every recipient is archived", async () => {
    ctx.sessionManager.archive("parent");
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "hi" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("validates body, severity, and target", async () => {
    await expect(deliverSessionReport(ctx.deps, "elementalist", { body: "  " })).rejects.toThrow(
      /body is required/i,
    );
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "x".repeat(MAX_REPORT_BODY_CHARS + 1) }),
    ).rejects.toThrow(/exceeds/i);
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "hi", severity: "urgent" }),
    ).rejects.toThrow(/Unknown severity/i);
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "hi", to: "everyone" }),
    ).rejects.toThrow(/Unknown report target/i);
  });

  it("rate-limits a runaway reporter, and a rejected call doesn't burn budget", async () => {
    // A rejected (invalid) call must not consume the reporter's allowance.
    await expect(deliverSessionReport(ctx.deps, "elementalist", { body: "" })).rejects.toThrow();

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i++) {
      await deliverSessionReport(ctx.deps, "elementalist", { body: `report ${i}` });
    }
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "one too many" }),
    ).rejects.toMatchObject({ statusCode: 429 });

    // The limit is per reporter — a sibling is unaffected.
    await expect(deliverSessionReport(ctx.deps, "druid", { body: "mine" })).resolves.toBeTruthy();
  });

  it("reports a recipient whose wake failed without dropping the others (card still posted)", async () => {
    // A session with no workspace can't be woken — `wakeSessionWithTurn` throws.
    ctx.sessionManager.track("no-workspace", "Broken sibling");
    ctx.sessionManager.setParentSession("no-workspace", "parent");

    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "Heads up",
      to: "cohort",
    });

    const broken = result.recipients.find((r) => r.sessionId === "no-workspace");
    expect(broken?.woken).toBe(false);
    expect(broken?.error).toMatch(/no workspace/i);
    // Its card is still persisted, and the healthy recipients were still woken.
    expect(ctx.chatHistoryManager.load("no-workspace").filter((m) => m.sessionReport)).toHaveLength(1);
    expect(result.recipients.filter((r) => r.woken).map((r) => r.sessionId).sort()).toEqual([
      "druid",
      "necromancer",
      "parent",
    ]);
  });
});

describe("resolveSessionCohort (docs/233 — `shipit session whoami`)", () => {
  let ctx: ReturnType<typeof makeCohort>;

  beforeEach(() => {
    clearSessionReportRateLimits();
    ctx = makeCohort();
  });

  it("resolves self, parent, and live siblings for a spawned session", () => {
    const view = resolveSessionCohort(ctx.sessionManager, ctx.registry, "elementalist");

    expect(view.self).toMatchObject({ id: "elementalist", title: "Elementalist catalog", branch: "shipit/elementalist" });
    expect(view.parent).toMatchObject({ id: "parent", title: "Spell catalogs" });
    expect(view.siblings.map((s) => s.id).sort()).toEqual(["druid", "necromancer"]);
    expect(view.children).toEqual([]);
  });

  it("resolves children for a parent, and reports no parent for a top-level session", () => {
    const view = resolveSessionCohort(ctx.sessionManager, ctx.registry, "parent");

    expect(view.parent).toBeUndefined();
    expect(view.siblings).toEqual([]);
    expect(view.children.map((c) => c.id).sort()).toEqual(["druid", "elementalist", "necromancer"]);
  });

  it("404s on an unknown session", () => {
    expect(() => resolveSessionCohort(ctx.sessionManager, ctx.registry, "nope")).toThrow(ServiceError);
  });
});
