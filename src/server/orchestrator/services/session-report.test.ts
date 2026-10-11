import { describe, it, expect, beforeEach, vi } from "vitest";
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
import { createTurnSettlement, type TurnHandle } from "../turn-settlement.js";
import { SessionInboxStore } from "../session-inbox-store.js";
import { SessionInbox } from "./session-inbox.js";

class FakeRunner {
  running = false;
  disposed = false;
  agentId = "claude" as const;
  queueLength = 0;
  dispatched: AgentDispatchOptions[] = [];
  emitted: unknown[] = [];
  constructor(public sessionDir: string) {}
  dispatch(opts: AgentDispatchOptions): TurnHandle {
    this.dispatched.push(opts);
    return createTurnSettlement();
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

  // The store is real, so a test reads what the parent's agent would read. Telling is
  // `session-inbox.test.ts`'s subject; here a report is stored and nothing more.
  const store = new SessionInboxStore(db);
  const deps: SessionReportDeps = {
    sessionManager,
    runnerRegistry: registry,
    chatHistoryManager,
    sessionInbox: {
      post: async (recipient, message) => {
        store.add(recipient.id, message);
        return { told: "later" };
      },
    },
  };
  return { db, sessionManager, chatHistoryManager, registry, runners, store, deps };
}

describe("deliverSessionReport (docs/233)", () => {
  let ctx: ReturnType<typeof makeCohort>;

  beforeEach(() => {
    clearSessionReportRateLimits();
    ctx = makeCohort();
  });

  it("delivers to the parent by default: a persisted card and a message in its inbox, and no turn", async () => {
    ctx.registry.getOrCreate("parent", "/ws/parent", "claude");
    const result = await deliverSessionReport(ctx.deps, "elementalist", {
      body: "The shared regen command deletes every catalog.",
      severity: "blocker",
      subject: "regen wipes data/catalogs",
    });

    expect(result.to).toBe("parent");
    expect(result.recipients).toEqual([
      { sessionId: "parent", title: "Spell catalogs", relation: "child", woken: true, told: "later" },
    ]);

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

    const parent = ctx.runners.get("parent");
    // docs/328-session-message-inbox req 1 — the report is not a turn of its own.
    expect(parent?.dispatched).toHaveLength(0);
    const [message] = ctx.store.all("parent");
    expect(ctx.store.all("parent")).toHaveLength(1);
    expect(message!.body).toContain("BLOCKER");
    expect(message!.body).toContain("The shared regen command deletes every catalog.");
    expect(message!.body).toContain("report from child");
    expect(message!.body.length).toBeLessThan(300);
    expect(message!.origin).toEqual({
      sessionId: "elementalist",
      sessionTitle: "Elementalist catalog",
      relation: "child",
    });

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
        { sessionId: "parent", title: "Spell catalogs", relation: "child", woken: true, told: "later" },
      ]);
      expect(ctx.chatHistoryManager.load("parent")[0].sessionReport?.severity).toBe(severity);
      expect(ctx.store.all("parent")[0]!.body).toContain(severity.toUpperCase());
      expect(ctx.store.all("druid")).toHaveLength(0);
      expect(ctx.store.all("necromancer")).toHaveLength(0);
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
    for (let i = 0; i < MAX_REPORTS_PER_WINDOW + 1; i++) {
      await expect(deliverSessionReport(ctx.deps, "elementalist", {
        body: "legacy retry",
        to: "cohort",
      })).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(deliverSessionReport(ctx.deps, "elementalist", { body: "" })).rejects.toThrow();

    for (let i = 0; i < MAX_REPORTS_PER_WINDOW; i++) {
      await deliverSessionReport(ctx.deps, "elementalist", { body: `report ${i}` });
    }
    await expect(
      deliverSessionReport(ctx.deps, "elementalist", { body: "one too many" }),
    ).rejects.toMatchObject({ statusCode: 429 });

    await expect(deliverSessionReport(ctx.deps, "druid", { body: "mine" })).resolves.toBeTruthy();
  });

  it("stores the report for a parent that cannot be started, and says so", async () => {
    ctx.db.db.prepare("UPDATE sessions SET workspace_dir = NULL WHERE id = ?").run("parent");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sessionInbox = new SessionInbox({
      store: ctx.store,
      sessionManager: ctx.sessionManager,
      runnerRegistry: ctx.registry,
      defaultAgentId: "claude",
    });

    const result = await deliverSessionReport({ ...ctx.deps, sessionInbox }, "elementalist", {
      body: "Heads up",
    });

    // Stored, so `woken` stays true for an older shim; `told` carries the truth.
    expect(result.recipients[0]).toMatchObject({
      woken: true,
      told: "failed",
      error: expect.stringMatching(/no workspace/i),
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("could not start parent"),
      expect.objectContaining({ message: expect.stringMatching(/no workspace/i) }),
    );
    expect(ctx.chatHistoryManager.load("parent").filter((m) => m.sessionReport)).toHaveLength(1);
    expect(ctx.store.owed("parent")).toMatchObject({ unread: 1 });
    errors.mockRestore();
  });
});

describe("resolveSessionCohort (docs/233 — `shipit session whoami`)", () => {
  let ctx: ReturnType<typeof makeCohort>;

  beforeEach(() => {
    clearSessionReportRateLimits();
    ctx = makeCohort();
  });

  it("resolves self and parent for a spawned session, and never its siblings", () => {
    const view = resolveSessionCohort(ctx.sessionManager, ctx.registry, "elementalist");

    expect(view.self).toMatchObject({ id: "elementalist", title: "Elementalist catalog", branch: "shipit/elementalist" });
    expect(view.parent).toMatchObject({ id: "parent", title: "Spell catalogs" });
    expect(view).not.toHaveProperty("siblings");
    expect(JSON.stringify(view)).not.toMatch(/druid|necromancer/);
    expect(view.children).toEqual([]);
  });

  it("projects transcript and PR onto self and children, but not onto the parent", () => {
    const projections = {
      chatHistoryManager: { loadLatestAssistantText: (id: string) => `latest from ${id}` },
      prStatusPoller: { getStatus: (id: string) => ({ prUrl: `https://example.test/${id}` }) },
    };

    const child = resolveSessionCohort(ctx.sessionManager, ctx.registry, "elementalist", projections);
    expect(child.self.latestAssistantMessage).toBe("latest from elementalist");
    expect(child.parent).not.toHaveProperty("latestAssistantMessage");
    expect(child.parent).not.toHaveProperty("prUrl");

    const parent = resolveSessionCohort(ctx.sessionManager, ctx.registry, "parent", projections);
    expect(parent.children.every((c) => c.latestAssistantMessage === `latest from ${c.id}`)).toBe(true);
  });

  it("resolves children for a parent, and reports no parent for a top-level session", () => {
    const view = resolveSessionCohort(ctx.sessionManager, ctx.registry, "parent");

    expect(view.parent).toBeUndefined();
    expect(view.children.map((c) => c.id).sort()).toEqual(["druid", "elementalist", "necromancer"]);
  });

  it("404s on an unknown session", () => {
    expect(() => resolveSessionCohort(ctx.sessionManager, ctx.registry, "nope")).toThrow(ServiceError);
  });
});
