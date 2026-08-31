/**
 * Unit tests for the shared sub-agent run helper (docs/144). Drives a fake
 * AgentProcess through `runAgentToCompletion` and asserts the accumulated text,
 * status, cost/duration, truncation, and cancel behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  runAgentToCompletion,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_TRANSPORT_TIMEOUT_MS,
} from "./sub-agent-run.js";
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

  it("captures the token breakdown from agent_result (docs/144 usage attribution)", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("done"));
    agent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s",
      cost: { totalUsd: 0.05 },
      durationMs: 3000,
      tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 80 },
      contextTokens: 6200,
    });
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.inputTokens).toBe(1200);
    expect(res.outputTokens).toBe(340);
    expect(res.cacheReadTokens).toBe(5000);
    expect(res.cacheCreateTokens).toBe(80);
    expect(res.contextTokens).toBe(6200);
  });

  it("carries back the latest rate-limit snapshot (last-one-wins) for the limits pill", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", {
      type: "agent_rate_limits",
      session: { usedPct: 40, resetAt: "2026-06-13T00:00:00Z" },
      weekly: null,
    });
    agent.emit("event", {
      type: "agent_rate_limits",
      session: { usedPct: 55, resetAt: "2026-06-13T05:00:00Z" },
      weekly: { usedPct: 12, resetAt: "2026-06-20T00:00:00Z" },
    });
    agent.emit("event", assistant("done"));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.rateLimits).toEqual({
      session: { usedPct: 55, resetAt: "2026-06-13T05:00:00Z" },
      weekly: { usedPct: 12, resetAt: "2026-06-20T00:00:00Z" },
    });
  });

  it("leaves rateLimits undefined when the backend pushed no snapshot", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("done"));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.rateLimits).toBeUndefined();
  });

  it("leaves token fields undefined when the backend reports no token telemetry", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("done"));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.inputTokens).toBeUndefined();
    expect(res.outputTokens).toBeUndefined();
    expect(res.contextTokens).toBeUndefined();
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

  it("joins every completed message when a run answers across several (planning#247)", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    // Codex shape: deltas, then the completed message re-emitted — twice, because
    // the answer spanned a long report and a shorter wrap-up. Keeping only the
    // last one handed the caller the tail of the answer and nothing said so.
    agent.emit("event", assistant("The orphan branch is viab"));
    agent.emit("event", assistant("The orphan branch is viable, but…\n\n1. digest excludes the envelope", true));
    agent.emit("event", assistant("I found nine defi"));
    agent.emit("event", assistant("I found nine definite problems.", true));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.text).toBe(
      "The orphan branch is viable, but…\n\n1. digest excludes the envelope\n\nI found nine definite problems.",
    );
  });

  it("does not double a completion an adapter re-emits verbatim", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("Final streamed answer.", true));
    agent.emit("event", assistant("Final streamed answer.", true));
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

  it("treats a non-zero exit with no result event and no output as an error, not an empty success", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    // The shape of a CLI that never started: no events at all, then a non-zero
    // exit. This resolved `status: "success"`, `text: ""` — so the caller
    // reported "the reviewer found nothing" and retried into the same wall.
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.text).toBe("");
    expect(res.error).toContain("exited with code 1");
  });

  it("reports a crash that leaked a preamble as an error, keeping the partial text", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    // A run that starts talking, works, then dies before its result event. The
    // preamble is not an answer — calling this a success hands the caller
    // "Let me inspect the files…" as if it were the review.
    agent.emit("event", assistant("Let me inspect the files…"));
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.text).toBe("Let me inspect the files…");
    expect(res.error).toContain("exited with code 1");
  });

  it("keeps a clean exit a success", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("Here are the findings."));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.status).toBe("success");
    expect(res.text).toBe("Here are the findings.");
  });

  it("lets the backend's own agent_result verdict stand over the exit code", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", result(0.01, 1000, "success"));
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res.status).toBe("success");
  });

  it("still reports cancelled — not error — when a cancel produces the non-zero exit", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.cancel();
    agent.emit("done", 143);
    const res = await handle.promise;
    expect(res.status).toBe("cancelled");
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

  /**
   * docs/144 §8 — the cap is now one of only TWO things that can end a consult,
   * so "a spawn that names no cap is still bounded" carries weight it did not
   * before. The test above passes an explicit 50 ms, so it would keep passing if
   * the default were deleted or made unbounded; this one would not.
   *
   * Why it matters beyond a runaway process: the credential borrow of the
   * sub-agent's account closes in `runSubAgent`'s `finally`
   * (`orchestrator/services/sub-agent.ts`), so an unbounded run holds an open
   * borrow in the session subtree — plus a live process and consumed
   * subscription quota — for as long as the container lives.
   */
  it("bounds a spawn that names no cap of its own, at the default", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
      agent.emit("event", assistant("still working"));

      // One tick short of the default: still running, nothing killed.
      vi.advanceTimersByTime(DEFAULT_SUB_AGENT_TIMEOUT_MS - 1);
      expect(agent.kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      const res = await handle.promise;
      expect(agent.kill).toHaveBeenCalled();
      expect(res.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The transport backstop must sit STRICTLY ABOVE the run's own cap, or it
   * fires first and the worker's timer stops being authoritative — a consult
   * that was merely slow would be reported as a transport failure, and the
   * partial text the run did produce would never come back.
   */
  it("keeps the transport backstop above the run's own cap", () => {
    expect(SUB_AGENT_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SUB_AGENT_TIMEOUT_MS);
  });
});

// 2026-08-21 incident — `homeDir` (a same-harness spawn's isolated credential
// root) must survive the runOpts → AgentRunParams mapping, or the CLI falls
// back to the session subtree the live primary reads.
describe("buildSubAgentRunParams", () => {
  it("carries homeDir through to the run params, and omits an absent one", async () => {
    const { buildSubAgentRunParams } = await import("./sub-agent-run.js");
    const withHome = buildSubAgentRunParams({
      prompt: "p",
      cwd: "/workspace",
      model: "m",
      homeDir: "/credentials/sub-agent-homes/x",
    });
    expect(withHome.homeDir).toBe("/credentials/sub-agent-homes/x");

    const without = buildSubAgentRunParams({ prompt: "p", cwd: "/workspace", model: "m" });
    expect("homeDir" in without).toBe(false);
  });
});
