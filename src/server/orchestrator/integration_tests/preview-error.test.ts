/**
 * Test for the preview-proxy `preview_error` reporter wiring.
 *
 * Verifies that when the proxy can't reach a container (or HMR upgrade
 * fails), the reporter emits both a `preview_error` WS message (drives
 * the inline PreviewFrame banner) and a `log_entry` (Logs panel record),
 * and that repeats for the same (sessionId, port) within the throttle
 * window are suppressed.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { createPreviewErrorReporter } from "../preview-proxy.js";
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
  it("emits preview_error + log_append once a failure persists past the grace window", () => {
    const { runner, emitted } = makeFakeRunner("sess-1");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-1": runner }),
      { now: () => nowMs, graceMs: 2_000 },
    );

    // First error only starts the streak clock — nothing surfaces yet.
    report("sess-1", 5173, "Connection refused", false);
    expect(emitted.length).toBe(0);

    // A later error, still unresolved past the grace window, surfaces.
    nowMs += 2_500;
    report("sess-1", 5173, "Connection refused", false);

    const types = emitted.map((m) => m.type);
    expect(types).toContain("preview_error");
    expect(types).toContain("log_append");

    const previewErr = emitted.find((m) => m.type === "preview_error");
    expect(previewErr).toMatchObject({
      type: "preview_error",
      sessionId: "sess-1",
      port: 5173,
      message: "Connection refused",
      upgrade: false,
    });

    const logAppend = emitted.find((m) => m.type === "log_append");
    expect(logAppend).toMatchObject({
      channel: "agent",
      records: [{
        source: "preview",
        text: expect.stringContaining("Preview unreachable on port 5173") as string,
      }],
    });
  });

  it("suppresses a transient error that recovers within the grace window", () => {
    const { runner, emitted } = makeFakeRunner("sess-tr");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-tr": runner }),
      { now: () => nowMs, graceMs: 2_000 },
    );

    // EHOSTUNREACH during container bring-up — held back.
    report("sess-tr", 3000, "connect EHOSTUNREACH 172.16.2.2:3000", false);
    expect(emitted.length).toBe(0);

    // The next request reaches the upstream — streak cleared.
    nowMs += 500;
    report.success("sess-tr", 3000);

    // Even well past the grace window, a fresh lone error stays silent
    // because the streak was reset.
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

    // Start the streak, then push past the grace window so errors surface.
    report("sess-3", 5173, "boom", false);
    nowMs += 2_500;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(1);

    // Inside the throttle window — suppressed.
    nowMs += 1_000;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(1);

    // Different port — needs its own streak past the grace window.
    report("sess-3", 5174, "boom", false);
    nowMs += 2_500;
    report("sess-3", 5174, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(2);

    // After the throttle window — releases for port 5173 (streak still open).
    nowMs += 6_000;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(3);
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
