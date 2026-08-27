/**
 * Unit tests for upward session reports (docs/233, planning#243).
 *
 * Covers the two halves of delivery — the persisted card in each recipient's
 * history and the queued system turn on its runner — plus the guards that make
 * a report safe to expose to an agent: recipients derived from the reporter's
 * own parent linkage (never agent input), sibling delivery refusal, validation,
 * and the runaway rate limit.
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

/** Parent with three children (the cohort from the planning#243 report). */
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

  it.each(["fyi", "warn", "blocker"] as const)(
    "delivers %s reports only to the parent",
    async (severity) => {
      const result = await deliverSessionReport(ctx.deps, "elementalist", {
        body: `${severity} finding`,
        severity,
      });

      expect(result.recipients).toEqual([
        { sessionId: "parent", title: "Spell catalogs", relation: "child", woken: true },
      ]);
      expect(ctx.chatHistoryManager.load("parent")[0].sessionReport?.severity).toBe(severity);
      expect(ctx.runners.get("parent")?.dispatched[0].text).toContain(severity.toUpperCase());
      expect(ctx.chatHistoryManager.load("druid")).toHaveLength(0);
      expect(ctx.chatHistoryManager.load("necromancer")).toHaveLength(0);
    },
  );

  it("rejects sibling/cohort delivery before any card, runner, or wake is created", async () => {
    await expect(deliverSessionReport(ctx.deps, "elementalist", {
      body: "Heads up",
      to: "cohort",
      severity: "warn",
    })).rejects.toMatchObject({ statusCode: 400 });

    for (const sessionId of ["parent", "elementalist", "druid", "necromancer"]) {
      expect(ctx.chatHistoryManager.load(sessionId).filter((m) => m.sessionReport)).toHaveLength(0);
    }
    expect(ctx.runners.size).toBe(0);
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
    ).rejects.toThrow(/only to their parent/i);
  });

  it("rate-limits a runaway reporter, and a rejected call doesn't burn budget", async () => {
    // An old shim can retry the removed target without consuming the reporter's
    // allowance for later valid parent reports.
    for (let i = 0; i < MAX_REPORTS_PER_WINDOW + 1; i++) {
      await expect(deliverSessionReport(ctx.deps, "elementalist", {
        body: "legacy retry",
        to: "cohort",
      })).rejects.toMatchObject({ statusCode: 400 });
    }
    // Other rejected validation calls also do not consume the allowance.
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

  it("reports a parent whose wake failed while keeping the persisted card", async () => {
    // A parent with no workspace can't be woken — `wakeSessionWithTurn` throws.
    ctx.db.db.prepare("UPDATE sessions SET workspace_dir = NULL WHERE id = ?").run("parent");

    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "Heads up",
    });

    const broken = result.recipients[0];
    expect(broken?.woken).toBe(false);
    expect(broken?.error).toMatch(/no workspace/i);
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.sessionReport)).toHaveLength(1);
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
