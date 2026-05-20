import { describe, it, expect } from "vitest";
import { ProxyAgentProcess, type ProxyAgentRunner } from "./proxy-agent-process.js";
import { WorkerTimeoutError } from "./worker-http.js";

function makeRunner(overrides: Partial<ProxyAgentRunner> = {}): ProxyAgentRunner {
  return {
    _startAgentViaProxy: () => Promise.resolve(),
    writeAgentStdin: () => Promise.resolve(),
    sendAgentMessage: () => Promise.resolve(),
    interruptAgentOnWorker: () => Promise.resolve(),
    killAgentOnWorker: () => Promise.resolve(),
    ...overrides,
  };
}

function once<T>(emitter: ProxyAgentProcess, event: "error" | "log"): Promise<T> {
  return new Promise((resolve) => {
    emitter.once(event, ((...args: unknown[]) => resolve(args.length === 1 ? args[0] as T : args as unknown as T)) as never);
  });
}

describe("ProxyAgentProcess WorkerTimeoutError translation", () => {
  it("run(): wraps WorkerTimeoutError on /agent/start with rescue-session guidance", async () => {
    const runner = makeRunner({
      _startAgentViaProxy: () => Promise.reject(new WorkerTimeoutError("/agent/start", 10_000)),
    });
    const proxy = new ProxyAgentProcess("claude", runner);
    const errorPromise = once<Error>(proxy, "error");
    proxy.run({ initialPrompt: "x" } as never);
    const err = await errorPromise;
    expect(err.message).toContain("agent container is not responding");
    expect(err.message).toContain("Rescue session");
    expect(err.cause).toBeInstanceOf(WorkerTimeoutError);
  });

  it("interrupt(): wraps WorkerTimeoutError with kill-agent guidance", async () => {
    const runner = makeRunner({
      interruptAgentOnWorker: () => Promise.reject(new WorkerTimeoutError("/agent/interrupt", 10_000)),
    });
    const proxy = new ProxyAgentProcess("claude", runner);
    const errorPromise = once<Error>(proxy, "error");
    proxy.interrupt();
    const err = await errorPromise;
    expect(err.message).toContain("Interrupt request timed out");
    expect(err.message).toContain("Kill agent");
  });

  it("writeStdin(): wraps WorkerTimeoutError with stdin-specific message", async () => {
    const runner = makeRunner({
      writeAgentStdin: () => Promise.reject(new WorkerTimeoutError("/agent/stdin", 10_000)),
    });
    const proxy = new ProxyAgentProcess("claude", runner);
    const errorPromise = once<Error>(proxy, "error");
    proxy.writeStdin("hi");
    const err = await errorPromise;
    expect(err.message).toContain("Failed to send input");
  });

  it("non-timeout errors pass through unchanged", async () => {
    const original = new Error("connection refused");
    const runner = makeRunner({
      _startAgentViaProxy: () => Promise.reject(original),
    });
    const proxy = new ProxyAgentProcess("claude", runner);
    const errorPromise = once<Error>(proxy, "error");
    proxy.run({ initialPrompt: "x" } as never);
    const err = await errorPromise;
    expect(err).toBe(original);
  });
});
