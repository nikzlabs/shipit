import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  describeSubAgentFailure,
  runAgentToCompletion,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_FAILURE_MESSAGE_MAX_CHARS,
  SUB_AGENT_STDERR_TAIL_MAX_CHARS,
  SUB_AGENT_TRANSPORT_TIMEOUT_MS,
  type SubAgentRunResult,
} from "./sub-agent-run.js";
import type { AgentEvent } from "./types.js";

class FakeAgent extends EventEmitter {
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
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
    expect(res.requests).toBeUndefined();
  });

  it("carries the per-request list back for prompt-length pricing (docs/329-tiered-model-pricing)", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    const requests = [{ input: 1000, output: 40 }, { input: 200, output: 300, cacheRead: 5000 }];
    agent.emit("event", assistant("done"));
    agent.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "s",
      tokens: { input: 1200, output: 340, cacheRead: 5000 },
      requests,
    });
    agent.emit("done", 0);
    expect((await handle.promise).requests).toEqual(requests);
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
    expect(res.outputLimitChars).toBe(10);
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
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.text).toBe("");
    expect(res.error).toContain("exited before it reported a result");
    expect(res.exitCode).toBe(1);
  });

  it("reports a crash that leaked a preamble as an error, keeping the partial text", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("event", assistant("Let me inspect the files…"));
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.text).toBe("Let me inspect the files…");
    expect(res.exitCode).toBe(1);
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
      expect(res.outputLimitChars).toBeUndefined();
      expect(res.error).toContain("time limit (1 s)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a spawn that names no cap of its own, at the default", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
      agent.emit("event", assistant("still working"));

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

  it("keeps the transport backstop above the run's own cap", () => {
    expect(SUB_AGENT_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SUB_AGENT_TIMEOUT_MS);
  });
});

// A credential shape that is put together here, so that no secret scan reads one in this file.
const FAKE_KEY = ["sk", "proj", "k".repeat(28)].join("-");

async function settledSoon(handle: { promise: Promise<SubAgentRunResult> }): Promise<SubAgentRunResult | "still running"> {
  return Promise.race([
    handle.promise,
    new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 50)),
  ]);
}

describe("runAgentToCompletion — a run that fails says why", () => {
  it("ends at once when the adapter finds no credential in run() and starts no process", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => { agent.emit("auth_required"); });
    const res = await settledSoon(handle);
    expect(res).toMatchObject({ status: "error", text: "" });
    expect((res as SubAgentRunResult).error).toMatch(/credential/);
  });

  it("ends a cancelled run as cancelled when the adapter then finds no credential", async () => {
    const agent = new FakeAgent();
    // The Codex adapter emits no `done` for a kill with no process.
    agent.kill.mockImplementation(() => {});
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.cancel();
    handle.start(() => { agent.emit("auth_required"); });
    const res = await settledSoon(handle);
    expect(res).toMatchObject({ status: "cancelled" });
    expect((res as SubAgentRunResult).error).toBeUndefined();
  });

  it("lets a live process that reports a credential problem run on, and names it if the process then fails", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => {});
    // The Claude adapter emits the event before it logs the line.
    agent.emit("auth_required");
    agent.emit("log", "stderr", "API Error: 401 authentication_error");
    expect(await settledSoon(handle)).toBe("still running");

    agent.emit("done", 1);
    const res = await handle.promise;
    expect(res).toMatchObject({ status: "error", exitCode: 1, stderrTail: "API Error: 401 authentication_error" });
    expect(res.error).toMatch(/credential/);
  });

  // The Codex adapter emits the event for a stderr line with "api key" in it. The account
  // failover in the orchestrator reads the error of the result that follows.
  it("keeps the error of a result that follows a credential report from a live process", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => {});
    agent.emit("log", "codex-stderr", "API key quota exceeded");
    agent.emit("auth_required");
    agent.emit("event", { type: "agent_result", status: "error", sessionId: "s", error: "Quota exceeded for this account" });
    agent.emit("done", 1);
    expect(await handle.promise).toMatchObject({ status: "error", error: "Quota exceeded for this account" });
  });

  it("keeps the success of a live process that recovered", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => {});
    agent.emit("auth_required");
    agent.emit("event", assistant("2 findings"));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    expect(await handle.promise).toMatchObject({ status: "success", text: "2 findings" });
  });

  // The Claude adapter does not pass on the result of an auth failure, and the CLI can exit with 0.
  it("fails a live process that reported a credential problem and then exited with no result", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => {});
    agent.emit("auth_required");
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res).toMatchObject({ status: "error", exitCode: 0 });
    expect(res.error).toMatch(/credential/);
  });

  // The Claude and OpenCode adapters emit `error` and then `done` in one callback.
  it("keeps the exit code that follows an adapter error directly", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("error", new Error("write EPIPE"));
    agent.emit("done", 2);
    expect(await handle.promise).toMatchObject({ status: "error", error: "write EPIPE", exitCode: 2 });
  });


  it("carries the exit code and the end of the harness's stderr", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("log", "codex", "spawning: codex app-server | cwd: /w");
    agent.emit("log", "codex-stderr", "error: unexpected argument '--frobnicate' found");
    agent.emit("log", "stderr", "Usage: codex [OPTIONS]");
    agent.emit("done", 2);
    const res = await handle.promise;
    expect(res.status).toBe("error");
    expect(res.exitCode).toBe(2);
    expect(res.stderrTail).toBe("error: unexpected argument '--frobnicate' found Usage: codex [OPTIONS]");
  });

  it("keeps stderr that came before an adapter error", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("log", "codex-stderr", "thread/start failed: config.toml is not valid");
    agent.emit("error", new Error("Codex initialize timed out"));
    const res = await handle.promise;
    expect(res).toMatchObject({
      status: "error",
      error: "Codex initialize timed out",
      stderrTail: "thread/start failed: config.toml is not valid",
    });
    expect(res.exitCode).toBeUndefined();
  });

  it("keeps only the end of a long stderr", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    for (let i = 0; i < 400; i += 1) agent.emit("log", "stderr", `retry ${i} of the upstream call`);
    agent.emit("log", "stderr", "fatal: the last line");
    agent.emit("done", 1);
    const tail = (await handle.promise).stderrTail!;
    expect(tail.length).toBeLessThanOrEqual(SUB_AGENT_STDERR_TAIL_MAX_CHARS + 1);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("fatal: the last line")).toBe(true);
  });

  // A kill makes the Codex adapter reject its open requests, and its start-up then emits `error`.
  it("ends a cancelled run as cancelled when the kill makes the adapter emit an error", async () => {
    const agent = new FakeAgent();
    agent.kill.mockImplementation(() => { agent.emit("error", new Error("Process killed")); });
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    handle.start(() => {});
    handle.cancel();
    const res = await settledSoon(handle);
    expect(res).toMatchObject({ status: "cancelled" });
    expect((res as SubAgentRunResult).error).toBeUndefined();
  });

  it("redacts a credential in stderr before the text leaves the run", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("log", "codex-stderr", `401 Unauthorized for key ${FAKE_KEY} at https://api.example.test/v1/responses`);
    agent.emit("done", 1);
    const res = await handle.promise;
    expect(JSON.stringify(res)).not.toContain(FAKE_KEY);
    expect(res.stderrTail).toContain("401 Unauthorized for key [REDACTED]");
    // A diagnosis needs the URL, so only the credential shape goes.
    expect(res.stderrTail).toContain("https://api.example.test/v1/responses");
  });

  it("adds no stderr to a run that succeeded", async () => {
    const agent = new FakeAgent();
    const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w" }, Date.now());
    agent.emit("log", "stderr", "warning: a plugin took 2 s to start");
    agent.emit("event", assistant("All good."));
    agent.emit("event", result(0.01, 1000));
    agent.emit("done", 0);
    const res = await handle.promise;
    expect(res.status).toBe("success");
    expect(res.stderrTail).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });

  it("gives a timed-out run its stderr too", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w", timeoutMs: 120_000 }, Date.now());
      agent.emit("log", "stderr", "stream error: retrying in 30s");
      vi.advanceTimersByTime(120_001);
      const res = await handle.promise;
      expect(res.status).toBe("timeout");
      expect(res.error).toContain("time limit (2 min)");
      expect(res.stderrTail).toBe("stream error: retrying in 30s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runAgentToCompletion — stderr that the adapter emits at the kill", () => {
  // The Codex adapter gives its text with no line end when it is killed.
  it("is in the tail of a run that the time limit stopped", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      agent.kill.mockImplementation(() => { agent.emit("log", "codex-stderr", "fatal: cannot open the state database"); });
      const handle = runAgentToCompletion(agent as never, { prompt: "p", cwd: "/w", timeoutMs: 50 }, Date.now());
      vi.advanceTimersByTime(60);
      expect(await handle.promise).toMatchObject({
        status: "timeout",
        stderrTail: "fatal: cannot open the state database",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeSubAgentFailure", () => {
  const failed = (over: Partial<SubAgentRunResult>): SubAgentRunResult => ({
    status: "error", text: "", truncated: false, durationMs: 147, costUsd: 0, ...over,
  });

  it("puts the message, the exit code and the stderr tail on one line", () => {
    expect(describeSubAgentFailure(failed({
      error: "The agent process exited before it reported a result.",
      exitCode: 2,
      stderrTail: "error: unexpected argument",
    }))).toBe(
      "The agent process exited before it reported a result. Exit code 2. Last stderr: error: unexpected argument",
    );
  });

  it("says nothing for a run that succeeded or was cancelled", () => {
    expect(describeSubAgentFailure(failed({ status: "success" }))).toBeUndefined();
    expect(describeSubAgentFailure(failed({ status: "cancelled", error: "x" }))).toBeUndefined();
  });

  it("still says something when the harness gave no reason", () => {
    expect(describeSubAgentFailure(failed({}))).toMatch(/gave no reason/);
    expect(describeSubAgentFailure(failed({ status: "timeout" }))).toMatch(/time limit/);
  });

  it("names an exit code of zero too", () => {
    expect(describeSubAgentFailure(failed({ error: "Quota exhausted", exitCode: 0 }))).toBe(
      "Quota exhausted. Exit code 0.",
    );
  });

  it("redacts and bounds text that did not come from the run core", () => {
    const reason = describeSubAgentFailure(failed({
      error: `request failed\nAuthorization: Bearer ${FAKE_KEY} ${"x".repeat(2_000)}`,
      stderrTail: `${"y".repeat(2_000)} token ${FAKE_KEY}`,
    }))!;
    expect(reason).not.toContain(FAKE_KEY);
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(
      SUB_AGENT_FAILURE_MESSAGE_MAX_CHARS + SUB_AGENT_STDERR_TAIL_MAX_CHARS + 40,
    );
  });
});

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

  it("passes the managed settings, so a Claude spawn gets the deny list and the branch-block hook", async () => {
    const { buildSubAgentRunParams } = await import("./sub-agent-run.js");
    const params = buildSubAgentRunParams({ prompt: "p", cwd: "/workspace", model: "m", toolsOff: true });
    expect(params.settingsPath).toBe("/etc/shipit/managed-settings.json");
    expect(params.autoCreatePr).toBeUndefined();
    expect("sandbox" in params).toBe(false);
  });

  it("carries a sandbox parent's flag, which exempts the spawn from the branch-block hook", async () => {
    const { buildSubAgentRunParams } = await import("./sub-agent-run.js");
    expect(buildSubAgentRunParams({ prompt: "p", cwd: "/workspace", model: "m", sandbox: true }).sandbox).toBe(true);
  });
});
