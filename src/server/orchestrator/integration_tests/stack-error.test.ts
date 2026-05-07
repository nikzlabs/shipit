/**
 * Unit/integration test for the stack_error subscriber wiring.
 *
 * Verifies that when a ServiceManager emits stack_error, the wiring in
 * `app-lifecycle.ts` routes the failure to:
 *   1. The per-session log ring via `broadcastLog`.
 *   2. Attached viewers via `runner.emitMessage` (both a `log_entry` and
 *      the dedicated `stack_error` WS type).
 *
 * See docs/124-session-rescue-and-diagnostics §1.1.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { handleStackError } from "../app-lifecycle.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import type { WsServerMessage, WsLogEntry } from "../../shared/types.js";

function makeFakeRunner(sessionId: string): {
  runner: SessionRunnerInterface;
  emitted: WsServerMessage[];
} {
  const emitted: WsServerMessage[] = [];
  // Minimal runner stub — only the fields handleStackError reads matter.
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
    emitMessage: (msg: WsServerMessage) => {
      emitted.push(msg);
    },
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

describe("handleStackError (docs/124 §1.1)", () => {
  it("broadcasts a server log entry", () => {
    const { runner } = makeFakeRunner("sess-1");
    const calls: { sid: string; source: WsLogEntry["source"]; text: string }[] = [];
    const broadcastLog = (sid: string, source: WsLogEntry["source"], text: string) => {
      calls.push({ sid, source, text });
    };

    handleStackError(runner, new Error("compose up exited 1"), broadcastLog);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sid: "sess-1",
      source: "server",
      text: "[compose] Stack error: compose up exited 1",
    });
  });

  it("emits both a log_entry and stack_error WS message to attached viewers", () => {
    const { runner, emitted } = makeFakeRunner("sess-2");

    handleStackError(runner, new Error("daemon unreachable"));

    const types = emitted.map((m) => m.type);
    expect(types).toContain("log_entry");
    expect(types).toContain("stack_error");

    const stackErr = emitted.find((m) => m.type === "stack_error");
    expect(stackErr).toMatchObject({
      type: "stack_error",
      sessionId: "sess-2",
      message: "daemon unreachable",
    });

    const logEntry = emitted.find((m) => m.type === "log_entry");
    expect(logEntry).toMatchObject({
      type: "log_entry",
      source: "server",
      text: expect.stringContaining("Stack error: daemon unreachable") as string,
    });
  });

  it("works without a broadcastLog when none is wired", () => {
    const { runner, emitted } = makeFakeRunner("sess-3");

    expect(() => handleStackError(runner, new Error("boom"))).not.toThrow();
    expect(emitted.find((m) => m.type === "stack_error")).toBeDefined();
  });
});
