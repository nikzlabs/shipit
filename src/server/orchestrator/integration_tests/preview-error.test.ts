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
  it("emits preview_error + log_entry on first error", () => {
    const { runner, emitted } = makeFakeRunner("sess-1");
    const report = createPreviewErrorReporter(makeFakeRegistry({ "sess-1": runner }));

    report("sess-1", 5173, "Connection refused", false);

    const types = emitted.map((m) => m.type);
    expect(types).toContain("preview_error");
    expect(types).toContain("log_entry");

    const previewErr = emitted.find((m) => m.type === "preview_error");
    expect(previewErr).toMatchObject({
      type: "preview_error",
      sessionId: "sess-1",
      port: 5173,
      message: "Connection refused",
      upgrade: false,
    });

    const logEntry = emitted.find((m) => m.type === "log_entry");
    expect(logEntry).toMatchObject({
      source: "preview",
      text: expect.stringContaining("Preview unreachable on port 5173") as string,
    });
  });

  it("formats HMR-upgrade failures distinctly", () => {
    const { runner, emitted } = makeFakeRunner("sess-2");
    const report = createPreviewErrorReporter(makeFakeRegistry({ "sess-2": runner }));

    report("sess-2", 5173, "ECONNRESET", true);

    const logEntry = emitted.find((m) => m.type === "log_entry");
    expect(logEntry).toMatchObject({
      text: expect.stringContaining("Preview HMR unreachable on port 5173") as string,
    });
  });

  it("throttles repeats within the same (sessionId, port) window", () => {
    const { runner, emitted } = makeFakeRunner("sess-3");
    let nowMs = 1_000_000;
    const report = createPreviewErrorReporter(
      makeFakeRegistry({ "sess-3": runner }),
      { now: () => nowMs, throttleMs: 5_000 },
    );

    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(1);

    // Inside the throttle window — suppressed.
    nowMs += 1_000;
    report("sess-3", 5173, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(1);

    // Different port — not throttled.
    report("sess-3", 5174, "boom", false);
    expect(emitted.filter((m) => m.type === "preview_error").length).toBe(2);

    // After the window — throttle releases.
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
