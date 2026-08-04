/**
 * Unit coverage for the #1622 dependency-change auto-reinstall: the dep-input
 * match predicate and the cooldown/trailing-edge throttle. The full
 * reinstall→gated-service restart flow is exercised by the install-gate
 * integration test (CI-run; integration tests OOM a session container).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { Socket } from "node:net";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { WorkerAbortedError } from "./worker-http.js";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_TRANSPORT_TIMEOUT_MS,
} from "../shared/sub-agent-run.js";

function makeRunner(): ContainerSessionRunner {
  // A non-placeholder workerUrl resolves `_workerReady` immediately; we never
  // hit the network because `runInstall` is spied out in the throttle tests.
  return new ContainerSessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude",
    workerUrl: "http://127.0.0.1:1",
  });
}

/** Reach the private members under test without widening the public surface. */
function priv(runner: ContainerSessionRunner): {
  isDepInputChange(paths: string[]): boolean;
  maybeReinstallForDepChange(): void;
} {
  return runner as unknown as {
    isDepInputChange(paths: string[]): boolean;
    maybeReinstallForDepChange(): void;
  };
}

describe("ContainerSessionRunner — dependency-input change detection (#1622)", () => {
  it("matches only declared dep-input files, normalizing a ./ prefix", () => {
    const runner = makeRunner();
    // No inputs set yet → never matches.
    expect(priv(runner).isDepInputChange(["package-lock.json"])).toBe(false);

    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    expect(priv(runner).isDepInputChange(["package-lock.json"])).toBe(true);
    expect(priv(runner).isDepInputChange(["./package-lock.json"])).toBe(true);
    expect(priv(runner).isDepInputChange(["src/App.tsx", "package.json"])).toBe(true);
    expect(priv(runner).isDepInputChange(["src/App.tsx", "README.md"])).toBe(false);
  });

  it("treats an empty input set (non-keyable install) as never-matching", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["./build.sh"], []);
    expect(priv(runner).isDepInputChange(["package-lock.json"])).toBe(false);
  });
});

describe("ContainerSessionRunner — dependency-change reinstall throttle (#1622)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reinstalls on the leading edge and coalesces a within-cooldown change into one trailing reinstall", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });

    // First change → fires immediately.
    priv(runner).maybeReinstallForDepChange();
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenLastCalledWith(["npm ci"]);

    // Second change within the cooldown → suppressed, one trailing pass armed.
    vi.advanceTimersByTime(5_000);
    priv(runner).maybeReinstallForDepChange();
    expect(install).toHaveBeenCalledTimes(1);

    // After the cooldown elapses, exactly one trailing reinstall fires.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no install commands are configured", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs([], []);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    priv(runner).maybeReinstallForDepChange();
    expect(install).not.toHaveBeenCalled();
  });
});

/**
 * SHI-278 — an in-flight sub-agent spawn must not vanish with its container.
 *
 * The incident: a backgrounded Codex consult was running when the user hit
 * Restart agent. `restartAgent` kills the PRIMARY agent on the worker, then
 * force-disposes the runner and destroys the container — nothing on that path
 * noticed the spawn. Its `/agent/spawn` request was sent `{ timeoutMs: 0 }`, so
 * it either hung forever on a half-open socket or rejected minutes later
 * through a runner that no longer had viewers. Either way the 15-minute review
 * produced no card, no error, and nothing for `shipit agent result` to read.
 *
 * `dispose()` is the chokepoint every force-teardown path funnels through
 * (Restart agent, Restart container, Rescue, archive, full reset), so cancelling
 * there covers all of them without patching each caller.
 */
describe("ContainerSessionRunner — sub-agent spawn cancellation (SHI-278)", () => {
  it("aborts an in-flight spawn on dispose, rejecting the awaiting caller", async () => {
    const runner = makeRunner();
    // A silent worker: the request is accepted and never answered, which is
    // exactly what a container about to be SIGKILLed looks like.
    const server = http.createServer(() => { /* never respond */ });
    const sockets: Socket[] = [];
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);

    const spawn = runner.spawnSubAgent({
      agentId: "codex",
      prompt: "review the PR",
      spawnId: "spawn-1",
      depth: 0,
    });
    // Let the request reach the socket before tearing down.
    await new Promise((r) => setTimeout(r, 20));

    runner.dispose({ force: true });

    await expect(spawn).rejects.toBeInstanceOf(WorkerAbortedError);
    await expect(spawn).rejects.toThrow(/runner disposed/);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("defers a lifecycle-driven dispose while a spawn is in flight", async () => {
    // A backgrounded consult outlives its turn, so `running` is false and idle
    // cleanup would otherwise reap a perfectly healthy 30-minute review.
    const runner = makeRunner();
    const server = http.createServer(() => { /* never respond */ });
    const sockets: Socket[] = [];
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);

    const spawn = runner.spawnSubAgent({
      agentId: "codex", prompt: "review", spawnId: "spawn-1", depth: 0,
    });
    await new Promise((r) => setTimeout(r, 20));

    runner.dispose(); // no force — idle cleanup
    expect(runner.disposed).toBe(false);

    // An explicit teardown still proceeds, and cancels the spawn.
    runner.dispose({ force: true });
    expect(runner.disposed).toBe(true);
    await expect(spawn).rejects.toBeInstanceOf(WorkerAbortedError);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bounds the transport so a worker that never answers can't hang forever", () => {
    // The worker's own wall-clock cap stays authoritative; this is the backstop
    // for when the worker is gone and its timer went with it.
    expect(SUB_AGENT_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SUB_AGENT_TIMEOUT_MS);
    expect(Number.isFinite(SUB_AGENT_TRANSPORT_TIMEOUT_MS)).toBe(true);
  });
});
