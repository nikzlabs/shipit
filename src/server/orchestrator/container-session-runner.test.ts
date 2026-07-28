/**
 * Unit coverage for the #1622 dependency-change auto-reinstall: the dep-input
 * match predicate and the cooldown/trailing-edge throttle. The full
 * reinstall→gated-service restart flow is exercised by the install-gate
 * integration test (CI-run; integration tests OOM a session container).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type net from "node:net";
import { ContainerSessionRunner } from "./container-session-runner.js";

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
 * docs/144 — an abandoned consult (the calling agent's blocking shell call was
 * killed, so the relay chain tore down) must come back as `cancelled`, not as a
 * transport error. The distinction is user-visible: the consult card says the
 * consult was cancelled instead of reporting a broken worker for something that
 * was simply walked away from.
 */
describe("ContainerSessionRunner.spawnSubAgent — caller abort", () => {
  let server: http.Server | undefined;
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.length = 0;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** A worker that takes the spawn and never answers, like a live sub-agent. */
  async function startHangingWorker(onReceived: () => void): Promise<string> {
    server = http.createServer((req) => {
      req.resume();
      req.on("end", onReceived);
    });
    server.on("connection", (socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    return `http://127.0.0.1:${addr.port}`;
  }

  it("resolves as cancelled when the caller's signal aborts mid-spawn", async () => {
    let received = () => {};
    const gotRequest = new Promise<void>((resolve) => { received = resolve; });
    const workerUrl = await startHangingWorker(() => received());
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude",
      workerUrl,
    });

    const controller = new AbortController();
    const pending = runner.spawnSubAgent(
      { agentId: "codex", prompt: "review this", spawnId: "sp1", depth: 0 },
      { signal: controller.signal },
    );
    await gotRequest;
    controller.abort();

    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.text).toBe("");
    expect(result.costUsd).toBe(0);
  });

  it("still throws on a genuine transport failure (not mistaken for a cancel)", async () => {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: "/tmp/s1",
      // Nothing is listening here — a real unreachable worker.
      workerUrl: "http://127.0.0.1:1",
      defaultAgentId: "claude",
    });
    await expect(
      runner.spawnSubAgent({ agentId: "codex", prompt: "p", spawnId: "sp2", depth: 0 }),
    ).rejects.toThrow();
  });
});
