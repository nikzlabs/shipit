/**
 * Unit tests for the shared sub-agent run helper (docs/144). Drives a fake
 * AgentProcess through `runAgentToCompletion` and asserts the accumulated text,
 * status, cost/duration, truncation, and cancel behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runAgentToCompletion } from "./sub-agent-run.js";
import type { AgentEvent } from "./types.js";

/** Minimal AgentProcess stand-in: an EventEmitter with a spy-able kill(). */
class FakeAgent extends EventEmitter {
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    // Emulate the adapter emitting `done` shortly after kill.
    queueMicrotask(() => this.emit("done", 0));
  });
}

function assistant(text: string, isStreamCompletion = false): AgentEvent {
  return {
    type: "agent_assistant",
    content: [{ type: "text", text }],
    ...(isStreamCompletion ? { isStreamCompletion: true } : {}),
  };
}

function result(costUsd: number, durationMs: number, status: "success" | "error" = "success"): AgentEvent {
  return { type: "agent_result", status, sessionId: "s", cost: { totalUsd: costUsd }, durationMs };
}

describe("runAgentToCompletion", () => {
  it("returns the last full assistant message on success (Claude one-shot shape)", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("Let me look…"));
    agent.emit("event", assistant("Final answer: 2 bugs."));
    agent.emit("event", result(0.03, 4200));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.status).toBe("success");
    expect(res.text).toBe("Final answer: 2 bugs.");
    expect(res.costUsd).toBe(0.03);
    expect(res.durationMs).toBe(4200);
    expect(res.truncated).toBe(false);
  });

  it("prefers the stream-completion text over deltas (Codex shape)", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("Fin"));
    agent.emit("event", assistant("Final streamed answer.", true));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.text).toBe("Final streamed answer.");
  });

  it("ignores nested (Task tool) assistant events", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "nested noise" }], parentToolUseId: "t1" });
    agent.emit("event", assistant("top-level answer"));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.text).toBe("top-level answer");
  });

  it("truncates output past the char cap and flags it", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w", maxOutputChars: 10 }, Date.now());
    agent.emit("event", assistant("0123456789ABCDEF"));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.text).toBe("0123456789");
    expect(res.truncated).toBe(true);
  });

  it("reports an error status when the adapter emits error", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("error", new Error("crashed"));
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.error).toBe("crashed");
  });

  it("cancel() kills the agent and resolves with status cancelled", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("partial"));
    handle.cancel();
    const res = await handle.promise;
    expect(agent.kill).toHaveBeenCalled();
    expect(res.status).toBe("cancelled");
    expect(res.text).toBe("partial");
  });

  it("times out and kills the agent when the wall-clock cap is hit", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w", timeoutMs: 50 }, Date.now());
      agent.emit("event", assistant("slow partial"));
      vi.advanceTimersByTime(60);
      const res = await handle.promise;
      expect(agent.kill).toHaveBeenCalled();
      expect(res.status).toBe("timeout");
      expect(res.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
