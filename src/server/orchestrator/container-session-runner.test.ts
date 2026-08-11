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
 * planning#280 — an in-flight sub-agent spawn must not vanish with its container.
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
describe("ContainerSessionRunner — sub-agent spawn cancellation (planning#280)", () => {
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
      // docs/261 req 7 — a spawn names the model it runs; the type requires it.
      model: "gpt-5.6-sol",
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
      agentId: "codex", prompt: "review", spawnId: "spawn-1", depth: 0, model: "gpt-5.6-sol",
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

/**
 * planning#246 — what the sidebar dot and the chat status line report as "busy
 * outside a turn". A consult is the case the CLI's background-task list cannot
 * see: it outlives its parent turn, needs no resident streaming process, and
 * Codex reports no background tasks at all — so the union is what every marker
 * surface has to read.
 */
describe("ContainerSessionRunner — background-work marker", () => {
  it("names an in-flight consult, and stops naming it once the run settles", async () => {
    const runner = makeRunner();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", text: "ok", truncated: false, durationMs: 1, costUsd: 0 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);

    expect(runner.backgroundWorkDescriptions).toEqual([]);

    const spawn = runner.spawnSubAgent({
      agentId: "codex", prompt: "review", spawnId: "spawn-1", depth: 0, model: "gpt-5.6-sol",
    });
    // Read WITHOUT awaiting: `runSubAgent` announces the marker the moment
    // `spawnSubAgent` returns its promise, so the registration has to happen
    // synchronously, ahead of the method's first `await`. An `await` inserted
    // before it would make the consult invisible to the announcement — this
    // assertion is what turns that into a red build.
    expect(runner.backgroundWorkDescriptions).toEqual(["Codex consult"]);
    expect(runner.subAgentSpawnsInFlight).toBe(1);

    await spawn;
    expect(runner.backgroundWorkDescriptions).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/**
 * docs/113 — the orchestrator-shutdown dispose must not reach into the worker.
 *
 * Keeping the container alive across an update is only half of "running turns
 * survive it". An ordinary forced dispose posts `/agent/kill`, which clears the
 * worker's `turnActive` (`agent-controller.ts` → `endTurn()`), and
 * `reattachInFlightTurns()` (docs/240) adopts a turn only while that flag is
 * true — so the CLI died inside a healthy container, its transcript tail was
 * never persisted and its post-turn commit never ran. That is the second half
 * of the 2026-08-10 incident, and it survived the first fix (containers stopped
 * being destroyed, turns kept dying).
 */
describe("ContainerSessionRunner — dispose({ preserveAgent }) (docs/113)", () => {
  /** A worker that records every path it is called on. */
  async function startRecordingWorker(): Promise<{
    url: string;
    paths: string[];
    close: () => Promise<void>;
  }> {
    const paths: string[] = [];
    const sockets: Socket[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ killed: true }));
    });
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    return {
      url: `http://127.0.0.1:${addr.port}`,
      paths,
      close: async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** Install a minimal live agent proxy in the runner's slot. */
  function installAgent(runner: ContainerSessionRunner): void {
    runner.setAgent({ runToken: "run-token-1" } as never);
  }

  it("does not kill the worker-side agent, so the next orchestrator can adopt the turn", async () => {
    const worker = await startRecordingWorker();
    const runner = makeRunner();
    runner.setWorkerUrl(worker.url);
    installAgent(runner);

    runner.dispose({ force: true, preserveAgent: true });

    // Give a fire-and-forget post every chance to land before asserting it didn't.
    await new Promise((r) => setTimeout(r, 50));

    expect(worker.paths).toEqual([]);
    expect(runner.disposed).toBe(true);
    // The local proxy is still dropped — it cannot outlive this process.
    expect(runner.getAgent()).toBeNull();

    await worker.close();
  });

  it("still kills the agent on an ordinary forced dispose (full reset, archive, Rescue)", async () => {
    const worker = await startRecordingWorker();
    const runner = makeRunner();
    runner.setWorkerUrl(worker.url);
    installAgent(runner);

    runner.dispose({ force: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(worker.paths).toEqual(["/agent/kill"]);

    await worker.close();
  });

  it("leaves an in-flight sub-agent consult running on the preserve path", async () => {
    const server = http.createServer(() => { /* never respond */ });
    const sockets: Socket[] = [];
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");

    const runner = makeRunner();
    runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);
    const spawn = runner.spawnSubAgent({
      agentId: "codex", prompt: "review", spawnId: "spawn-1", depth: 0, model: "gpt-5.6-sol",
    });
    await new Promise((r) => setTimeout(r, 20));

    let settled = false;
    void (async () => {
      try { await spawn; } catch { /* rejection settles it too */ }
      settled = true;
    })();

    runner.dispose({ force: true, preserveAgent: true });
    await new Promise((r) => setTimeout(r, 50));

    // Not aborted: the consult keeps running in the container and stays
    // readable via `shipit agent result`. The awaiting promise dies with this
    // process, which is the point — nothing is left to hang.
    expect(settled).toBe(false);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
