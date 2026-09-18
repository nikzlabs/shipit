import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createPreviewErrorReporter } from "../preview-proxy.js";
import { markStackUp, forgetStackUp } from "../preview-timing.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { WsServerMessage } from "../../shared/types.js";

function makeFakeRunner(sessionId: string): {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
} {
  const emitted: WsServerMessage[] = [];
  const runner = Object.assign(new EventEmitter(), {
    sessionId,
    sessionDir: "/tmp/x",
    workspaceDir: "/tmp/x",
    running: false,
    queueLength: 0,
    viewerCount: 0,
    lastSseEventAt: 0,
    disposed: false,
    wasInterrupted: false,
    emitMessage: (msg: WsServerMessage) => { emitted.push(msg); },
    getAgent: () => null,
    setAgent: () => undefined,
    getTurnEventBuffer: () => [],
    attachViewer: () => undefined,
    detachViewer: () => undefined,
    waitForPreviewStatus: async () => undefined,
    previewStatusKnown: true,
    buildPreviewStatus: () => ({ type: "preview_status", running: false } as WsServerMessage),
    dispose: () => undefined,
  }) as unknown as SessionRunnerInterface;
  return { runner, emitted };
}

function makeFakeRegistry(runners: Record<string, SessionRunnerInterface>): SessionRunnerRegistry {
  return {
    get: (id: string) => runners[id],
  } as unknown as SessionRunnerRegistry;
}

describe("createPreviewErrorReporter (docs/124 §1.5)", () => {
  it("emits log_append once a failure persists past the grace window", () => {
    const { runner, emitted } = makeFakeRunner("sess-1");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-1": runner }),
      { now: () => nowMs, graceMs: 2_000 },
    );

    report("sess-1", 5173, "Connection refused", false);
    expect(emitted.length).toBe(0);

    nowMs += 2_500;
    report("sess-1", 5173, "Connection refused", false);

    const logAppend = emitted.find((m) => m.type === "log_append");
    expect(logAppend).toMatchObject({
      channel: "agent",
      records: [{
        source: "preview",
        text: expect.stringContaining("Preview unreachable on port 5173") as string,
      }],
    });
  });

  it("persists the record, not just the live line", () => {
    const { runner, emitted } = makeFakeRunner("sess-p");
    const persisted: { sessionId: string; source: string; text: string }[] = [];
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-p": runner }),
      {
        now: () => nowMs,
        graceMs: 2_000,
        broadcastLog: (sessionId, source, text) => { persisted.push({ sessionId, source, text }); },
      },
    );

    report("sess-p", 5173, "Connection refused", false);
    nowMs += 2_500;
    report("sess-p", 5173, "Connection refused", false);

    expect(emitted.some((m) => m.type === "log_append")).toBe(true);
    expect(persisted).toEqual([
      { sessionId: "sess-p", source: "preview", text: expect.stringContaining("Preview unreachable on port 5173") as string },
    ]);
  });

  it("suppresses a transient error that recovers within the grace window", () => {
    const { runner, emitted } = makeFakeRunner("sess-tr");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-tr": runner }),
      { now: () => nowMs, graceMs: 2_000 },
    );

    report("sess-tr", 3000, "connect EHOSTUNREACH 172.16.2.2:3000", false);
    expect(emitted.length).toBe(0);

    nowMs += 500;
    report.success("sess-tr", 3000);

    nowMs += 5_000;
    report("sess-tr", 3000, "connect EHOSTUNREACH 172.16.2.2:3000", false);
    expect(emitted.length).toBe(0);
  });

  it("formats HMR-upgrade failures distinctly", () => {
    const { runner, emitted } = makeFakeRunner("sess-2");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-2": runner }),
      { now: () => nowMs, graceMs: 2_000 },
    );

    report("sess-2", 5173, "ECONNRESET", true);
    nowMs += 2_500;
    report("sess-2", 5173, "ECONNRESET", true);

    const logAppend = emitted.find((m) => m.type === "log_append");
    expect(logAppend).toMatchObject({
      records: [{
        text: expect.stringContaining("Preview HMR unreachable on port 5173") as string,
      }],
    });
  });

  it("throttles repeats within the same (sessionId, port) window", () => {
    const { runner, emitted } = makeFakeRunner("sess-3");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-3": runner }),
      { now: () => nowMs, throttleMs: 5_000, graceMs: 2_000 },
    );

    report("sess-3", 5173, "boom", false);
    nowMs += 2_500;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "log_append").length).toBe(1);

    nowMs += 1_000;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "log_append").length).toBe(1);

    report("sess-3", 5174, "boom", false);
    nowMs += 2_500;
    report("sess-3", 5174, "boom", false);
    expect(emitted.filter((m) => m.type === "log_append").length).toBe(2);

    nowMs += 6_000;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "log_append").length).toBe(3);
  });

  it("closes the activation→preview-ready measurement on the first answered request", () => {
    const report = createPreviewErrorReporter(makeFakeRegistry({}));
    markStackUp("sess-timing", [{ name: "web", port: 5173 }]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) logged.push(msg);
    });

    try {
      report.success("sess-timing", 5173);
    } finally {
      spy.mockRestore();
      forgetStackUp("sess-timing");
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("preview.first-connect for sess-timing port=5173");
  });

  it("no-ops when no runner is registered for the session", () => {
    const report = createPreviewErrorReporter(makeFakeRegistry({}));
    expect(() => report("missing", 3000, "boom", false)).not.toThrow();
  });

  it("no-ops when no runner registry was wired", () => {
    const report = createPreviewErrorReporter(undefined);
    expect(() => report("any", 3000, "boom", false)).not.toThrow();
  });
});
