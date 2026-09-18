import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { WorkerAbortedError } from "./worker-http.js";
import { clearActivationState, getPluginPrepareFailures } from "./services/plugin-activation.js";
import { dependencyGapAgentPrefix } from "./dependency-staleness.js";
import {
  hasTokenWriteBackWatch,
  startTokenWriteBackWatch,
  stopAllTokenWriteBackWatches,
} from "./session-token-publisher.js";
import type { WsServerMessage } from "../shared/types.js";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_TRANSPORT_TIMEOUT_MS,
} from "../shared/sub-agent-run.js";

function makeRunner(): ContainerSessionRunner {
  return new ContainerSessionRunner({
    sessionId: "s1",
    sessionDir: "/tmp/s1",
    defaultAgentId: "claude",
    workerUrl: "http://127.0.0.1:1",
  });
}

function priv(runner: ContainerSessionRunner): {
  isDepInputChange(paths: string[]): boolean;
  maybeReinstallForDepChange(): void;
  signalInstallComplete(ok?: boolean, opts?: { unverified?: boolean }): void;
  _installInFlight: boolean;
} {
  return runner as unknown as {
    isDepInputChange(paths: string[]): boolean;
    maybeReinstallForDepChange(): void;
    signalInstallComplete(ok?: boolean, opts?: { unverified?: boolean }): void;
    _installInFlight: boolean;
  };
}

describe("ContainerSessionRunner — dependency-input change detection (#1622)", () => {
  it("matches only declared dep-input files, normalizing a ./ prefix", () => {
    const runner = makeRunner();
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

describe("ContainerSessionRunner — config-file change detection", () => {
  function withComposeFile(runner: ContainerSessionRunner, file: string): void {
    (runner as unknown as { _serviceManager: unknown })._serviceManager = { composeFilePath: file };
  }

  const isConfig = (runner: ContainerSessionRunner, p: string): boolean =>
    (runner as unknown as { isConfigFileChange(p: string): boolean }).isConfigFileChange(p);

  it("matches the conventional names before any manager exists", () => {
    const runner = makeRunner();
    expect(isConfig(runner, "shipit.yaml")).toBe(true);
    expect(isConfig(runner, "./docker-compose.yml")).toBe(true);
    expect(isConfig(runner, "compose.yaml")).toBe(true);
    expect(isConfig(runner, "deploy/compose.yml")).toBe(false);
    expect(isConfig(runner, "src/App.tsx")).toBe(false);
  });

  it("also matches the compose file the session's config actually names", () => {
    const runner = makeRunner();
    withComposeFile(runner, "deploy/compose.yml");

    expect(isConfig(runner, "deploy/compose.yml")).toBe(true);
    expect(isConfig(runner, "./deploy/compose.yml")).toBe(true);
    expect(isConfig(runner, "deploy/other.yml")).toBe(false);
  });

  it("normalizes a `./` the configured path itself carries", () => {
    const runner = makeRunner();
    withComposeFile(runner, "./deploy/compose.yml");
    expect(isConfig(runner, "deploy/compose.yml")).toBe(true);
  });
});

describe("ContainerSessionRunner — dependency-change reinstall throttle (#1622)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reinstalls on the leading edge and coalesces a within-cooldown change into one trailing reinstall", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });

    priv(runner).maybeReinstallForDepChange();
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.lastCall?.[0]).toEqual(["npm ci"]);

    vi.advanceTimersByTime(5_000);
    priv(runner).maybeReinstallForDepChange();
    expect(install).toHaveBeenCalledTimes(1);

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

describe("ContainerSessionRunner — dependency re-check after an orchestrator tree rewrite (#2429)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-runs the recorded install without being told which paths moved", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });

    runner.notifyWorkspaceRewritten();

    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.lastCall?.[0]).toEqual(["npm ci"]);
  });

  it("stays out of sessions whose install is not content-keyable — but says so", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["./build.sh"], []);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    const notices: string[] = [];
    runner.onDependenciesUnverified = (m) => notices.push(m);

    runner.notifyWorkspaceRewritten("rebase");

    expect(install).not.toHaveBeenCalled();
    expect(runner.dependencyGap).toEqual({
      reason: "not-content-keyed",
      rewrite: "rebase",
      commands: ["./build.sh"],
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("a sync onto the latest base");
  });

  it("says nothing when the session declares no install at all", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs([], []);
    const notices: string[] = [];
    runner.onDependenciesUnverified = (m) => notices.push(m);

    runner.notifyWorkspaceRewritten("rollback");

    expect(runner.dependencyGap).toBeNull();
    expect(notices).toEqual([]);
  });

  it("reports a rewrite whose re-install failed, naming the rewrite", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: false });
    const notices: string[] = [];
    runner.onDependenciesUnverified = (m) => notices.push(m);

    runner.notifyWorkspaceRewritten("git-pull");
    await vi.runAllTimersAsync();

    expect(runner.dependencyGap).toMatchObject({ reason: "install-failed", rewrite: "git-pull" });
    expect(notices[0]).toContain("a git pull");
  });

  it("does not carry a rewrite into a later watcher-driven install", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: false });

    runner.notifyWorkspaceRewritten("rebase");
    await vi.runAllTimersAsync();
    expect(runner.dependencyGap).toMatchObject({ rewrite: "rebase" });

    await vi.advanceTimersByTimeAsync(30_000);
    priv(runner).maybeReinstallForDepChange();
    await vi.runAllTimersAsync();
    expect(runner.dependencyGap).toMatchObject({ reason: "install-failed" });
    expect(runner.dependencyGap?.rewrite).toBeUndefined();
  });

  it("reports once for a burst of the same rewrite, again for a different one", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["./build.sh"], []);
    const notices: string[] = [];
    runner.onDependenciesUnverified = (m) => notices.push(m);

    runner.notifyWorkspaceRewritten("rebase");
    runner.notifyWorkspaceRewritten("rebase");
    expect(notices).toHaveLength(1);

    runner.notifyWorkspaceRewritten("pre-turn-reset");
    expect(notices).toHaveLength(2);
  });

  it("clears the gap once an install proves the tree is installed", async () => {
    vi.useRealTimers();
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/install" ? { skipped: true } : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      const runner = makeRunner();
      runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);
      runner.setDepReinstallInputs(["./build.sh"], []);
      runner.notifyWorkspaceRewritten("rebase");
      expect(runner.dependencyGap).not.toBeNull();

      await runner.runInstall(["./build.sh"]);

      expect(runner.dependencyGap).toBeNull();
    } finally {
      server.close();
    }
  });

  it("clears the gap when the install actually ran and succeeded", async () => {
    vi.useRealTimers();
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/install" ? { started: true } : { running: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      const runner = makeRunner();
      runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);
      runner.setDepReinstallInputs(["./build.sh"], []);
      runner.notifyWorkspaceRewritten("rebase");
      expect(runner.dependencyGap).not.toBeNull();

      const install = runner.runInstall(["./build.sh"]);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(true);

      expect(await install).toEqual({ ok: true });
      expect(runner.dependencyGap).toBeNull();
    } finally {
      server.close();
    }
  });

  it("keeps the gap when the completion was synthesized rather than observed", async () => {
    vi.useRealTimers();
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/install" ? { started: true } : { running: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      const runner = makeRunner();
      runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);
      runner.setDepReinstallInputs(["./build.sh"], []);
      runner.notifyWorkspaceRewritten("rebase");
      expect(runner.dependencyGap).not.toBeNull();

      const install = runner.runInstall(["./build.sh"]);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(true, { unverified: true });

      expect(await install).toEqual({ ok: true, unverified: true });
      expect(runner.dependencyGap).not.toBeNull();
    } finally {
      server.close();
    }
  });

  it("keeps a gap that a FAILED install did not answer", async () => {
    vi.useRealTimers();
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/install" ? { started: true } : { running: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      const runner = makeRunner();
      runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);
      runner.setDepReinstallInputs(["./build.sh"], []);
      runner.notifyWorkspaceRewritten("rebase");

      const install = runner.runInstall(["./build.sh"]);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(false);

      expect(await install).toEqual({ ok: false });
      expect(runner.dependencyGap).toMatchObject({ reason: "not-content-keyed" });
    } finally {
      server.close();
    }
  });

  it("exposes a gap the turn prompt can push at the agent, for a skipped install", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["./build.sh"], []);

    runner.notifyWorkspaceRewritten("rebase");

    const prefix = dependencyGapAgentPrefix(runner.dependencyGap);
    expect(prefix.startsWith("[System] ")).toBe(true);
    expect(prefix).toContain("./build.sh");
    expect(prefix).toContain("a sync onto the latest base");
  });

  it("exposes a gap the turn prompt can push at the agent, for a failed install", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: false });

    runner.notifyWorkspaceRewritten("git-pull");
    await vi.runAllTimersAsync();

    const prefix = dependencyGapAgentPrefix(runner.dependencyGap);
    expect(prefix).toContain("FAILED");
    expect(prefix).toContain("npm ci");
    expect(prefix).toContain("a git pull");
  });

  it("contributes nothing to the turn prompt when the tree is believed installed", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });

    runner.notifyWorkspaceRewritten("rebase");

    expect(runner.dependencyGap).toBeNull();
    expect(dependencyGapAgentPrefix(runner.dependencyGap)).toBe("");
  });

  it("keeps the recorded gap when the notice hook throws", () => {
    const runner = makeRunner();
    vi.spyOn(console, "error").mockImplementation(() => {});
    runner.setDepReinstallInputs(["./build.sh"], []);
    runner.onDependenciesUnverified = () => { throw new Error("sqlite is unhappy"); };

    expect(() => runner.notifyWorkspaceRewritten("rebase")).not.toThrow();
    expect(runner.dependencyGap).toMatchObject({ reason: "not-content-keyed" });
  });

  it("shares the #1622 cooldown rather than stacking a second install on it", async () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });

    runner.notifyWorkspaceRewritten();
    priv(runner).maybeReinstallForDepChange();
    expect(install).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("does nothing once the runner is disposed", () => {
    const runner = makeRunner();
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    const install = vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    (runner as unknown as { _disposed: boolean })._disposed = true;

    runner.notifyWorkspaceRewritten();

    expect(install).not.toHaveBeenCalled();
  });
});

describe("ContainerSessionRunner — the reinstall bracket skips a no-op install", () => {
  async function withWorker(
    installResponse: Record<string, unknown> | "error",
    body: (url: string, paths: string[]) => Promise<void>,
  ): Promise<void> {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url === "/install") {
        if (installResponse === "error") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        res.end(JSON.stringify(installResponse));
        return;
      }
      res.end(JSON.stringify({ running: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      await body(`http://127.0.0.1:${addr.port}`, paths);
    } finally {
      server.close();
    }
  }

  function attachGate(
    runner: ContainerSessionRunner,
    opts: { latchedFailed?: boolean; alreadyOpen?: boolean; throwOnOpen?: boolean } = {},
  ): { calls: { running: boolean; failed?: boolean }[]; failed: () => boolean; open: () => boolean } {
    const calls: { running: boolean; failed?: boolean }[] = [];
    let running = opts.alreadyOpen ?? false;
    let failed = opts.latchedFailed ?? false;
    (runner as unknown as { _serviceManager: unknown })._serviceManager = {
      composeFilePath: "docker-compose.yml",
      get installGateFailed() { return failed; },
      setInstallRunning(next: boolean, o: { failed?: boolean } = {}): boolean {
        if (running === next) return false;
        if (next && opts.throwOnOpen) throw new Error("a service_status listener threw");
        running = next;
        if (next) {
          failed = false;
          calls.push({ running: true });
        } else {
          failed = o.failed ?? false;
          calls.push({ running: false, failed });
        }
        return true;
      },
    };
    return { calls, failed: () => failed, open: () => running };
  }

  const reinstall = (runner: ContainerSessionRunner): Promise<void> =>
    (runner as unknown as { reinstallForDepChange(): Promise<void> }).reinstallForDepChange();

  function makeDepRunner(url: string): ContainerSessionRunner {
    const runner = makeRunner();
    runner.setWorkerUrl(url);
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    return runner;
  }

  it("does not touch the gate when the worker reports a marker skip", async () => {
    await withWorker({ skipped: true }, async (url, paths) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner);

      await reinstall(runner);

      expect(gate.calls).toEqual([]);
      expect(paths).toContain("/install");
    });
  });

  it("brackets as soon as the worker says an install is starting", async () => {
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner);

      const done = reinstall(runner);
      await vi.waitFor(() => expect(gate.calls).toEqual([{ running: true }]));
      priv(runner).signalInstallComplete(true);
      await done;

      expect(gate.calls).toEqual([{ running: true }, { running: false, failed: false }]);
    });
  });

  it("still latches gated services to error when the install runs and fails", async () => {
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner);

      const done = reinstall(runner);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(false);
      await done;

      expect(gate.calls).toEqual([{ running: true }, { running: false, failed: true }]);
      expect(runner.dependencyGap).toMatchObject({ reason: "install-failed" });
    });
  });

  it("fails closed when the worker never answers at all", async () => {
    await withWorker("error", async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner);

      await reinstall(runner);

      expect(gate.calls).toEqual([{ running: true }, { running: false, failed: true }]);
      expect(runner.dependencyGap).toMatchObject({ reason: "install-failed" });
    });
  });

  it("still brackets a no-op install when the gate is latched from an earlier failure", async () => {
    await withWorker({ skipped: true }, async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner, { latchedFailed: true });

      await reinstall(runner);

      expect(gate.calls).toEqual([{ running: true }, { running: false, failed: false }]);
      expect(gate.failed()).toBe(false);
    });
  });

  it("is inert for a session with no compose stack", async () => {
    await withWorker({ skipped: true }, async (url, paths) => {
      const runner = makeRunner();
      runner.setWorkerUrl(url);
      runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);

      await expect(reinstall(runner)).resolves.toBeUndefined();
      expect(paths).toContain("/install");
    });
  });

  it("does not repair a failure latch on a completion that observed nothing", async () => {
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner, { latchedFailed: true });

      const done = reinstall(runner);
      await vi.waitFor(() => expect(gate.calls).toEqual([{ running: true }]));
      priv(runner).signalInstallComplete(true, { unverified: true });
      await done;

      expect(gate.calls).toEqual([{ running: true }, { running: false, failed: false }]);
    });
  });

  it("does not open a bracket at all for an unverified completion over a latched gate", async () => {
    const runner = makeRunner();
    const gate = attachGate(runner, { latchedFailed: true });
    runner.setDepReinstallInputs(["npm ci"], ["package.json", "package-lock.json"]);
    (runner as unknown as { _disposed: boolean })._disposed = true;

    await reinstall(runner);

    expect(gate.calls).toEqual([]);
    expect(gate.failed()).toBe(true);
  });

  it("does not close a gate another caller owns", async () => {
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      const gate = attachGate(runner, { latchedFailed: true, alreadyOpen: true });

      const done = reinstall(runner);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(true);
      await done;

      expect(gate.calls).toEqual([]);
      expect(gate.open()).toBe(true);
    });
  });

  it("keeps the install outcome intact when the gate transition throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      attachGate(runner, { throwOnOpen: true });

      const done = reinstall(runner);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      priv(runner).signalInstallComplete(true);
      await done;

      expect(runner.dependencyGap).toBeNull();
    });
  });

  it("leaves the bracket to the owner when it joins an install already in flight", async () => {
    await withWorker({ started: true }, async (url) => {
      const runner = makeDepRunner(url);
      const owner = runner.runInstall(["npm ci"]);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      const gate = attachGate(runner);

      const done = reinstall(runner);
      priv(runner).signalInstallComplete(true);
      await Promise.all([owner, done]);

      expect(gate.calls).toEqual([]);
    });
  });
});

describe("ContainerSessionRunner — sub-agent spawn cancellation (planning#280)", () => {
  it("aborts an in-flight spawn on dispose, rejecting the awaiting caller", async () => {
    const runner = makeRunner();
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
      model: "gpt-5.6-sol",
    });
    await new Promise((r) => setTimeout(r, 20));

    runner.dispose({ force: true });

    await expect(spawn).rejects.toBeInstanceOf(WorkerAbortedError);
    await expect(spawn).rejects.toThrow(/runner disposed/);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("defers a lifecycle-driven dispose while a spawn is in flight", async () => {
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

    runner.dispose();
    expect(runner.disposed).toBe(false);

    runner.dispose({ force: true });
    expect(runner.disposed).toBe(true);
    await expect(spawn).rejects.toBeInstanceOf(WorkerAbortedError);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bounds the transport so a worker that never answers can't hang forever", () => {
    expect(SUB_AGENT_TRANSPORT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_SUB_AGENT_TIMEOUT_MS);
    expect(Number.isFinite(SUB_AGENT_TRANSPORT_TIMEOUT_MS)).toBe(true);
  });

  it("forwards the spawn's homeDir to the worker body", async () => {
    const runner = makeRunner();
    const seen: { body?: Record<string, unknown> } = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "success", text: "ok", truncated: false, durationMs: 1, costUsd: 0 }));
      });
    });
    const sockets: Socket[] = [];
    server.on("connection", (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    runner.setWorkerUrl(`http://127.0.0.1:${addr.port}`);

    const result = await runner.spawnSubAgent({
      agentId: "claude",
      prompt: "review",
      spawnId: "spawn-2",
      depth: 0,
      model: "claude-opus-5",
      homeDir: "/credentials/sub-agent-homes/spawn-2",
    });
    expect(result.status).toBe("success");
    expect(seen.body?.homeDir).toBe("/credentials/sub-agent-homes/spawn-2");
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

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
    // Assert before awaiting: registration must be synchronous.
    expect(runner.backgroundWorkDescriptions).toEqual(["Codex consult"]);
    expect(runner.subAgentSpawnsInFlight).toBe(1);

    await spawn;
    expect(runner.backgroundWorkDescriptions).toEqual([]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("ContainerSessionRunner — dispose({ preserveAgent }) (docs/113)", () => {
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

  function installAgent(runner: ContainerSessionRunner): void {
    runner.setAgent({ runToken: "run-token-1" } as never);
  }

  it("does not kill the worker-side agent, so the next orchestrator can adopt the turn", async () => {
    const worker = await startRecordingWorker();
    const runner = makeRunner();
    runner.setWorkerUrl(worker.url);
    installAgent(runner);

    runner.dispose({ force: true, preserveAgent: true });

    await new Promise((r) => setTimeout(r, 50));

    expect(worker.paths).toEqual([]);
    expect(runner.disposed).toBe(true);
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

    expect(settled).toBe(false);

    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("ContainerSessionRunner — plugin prepare results (docs/262 req 13)", () => {
  const SESSION = "plugin-prepare-session";

  async function withWorker(
    body: { current: unknown },
    run: (runner: ContainerSessionRunner, messages: WsServerMessage[]) => Promise<void>,
  ): Promise<void> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.current));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    const runner = new ContainerSessionRunner({
      sessionId: SESSION,
      sessionDir: "/tmp/s1",
      defaultAgentId: "claude",
      workerUrl: `http://127.0.0.1:${addr.port}`,
    });
    const messages: WsServerMessage[] = [];
    runner.on("message", (m) => messages.push(m));
    try {
      await run(runner, messages);
    } finally {
      runner.dispose({ force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  beforeEach(() => clearActivationState(SESSION));
  afterEach(() => clearActivationState(SESSION));

  it("puts a skill the container could not materialize on that repository's card", async () => {
    await withWorker(
      { current: { skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "has no readable SKILL.md" }] } },
      async (runner, messages) => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await runner.preparePlugins();

        expect(getPluginPrepareFailures(SESSION, "tools")).toEqual([
          "Skill `reqs/probe`: has no readable SKILL.md",
        ]);
        expect(messages.map((m) => m.type)).toContain("plugin_repos_updated");
      },
    );
  });

  it("says nothing when a healthy prepare changes nothing", async () => {
    await withWorker({ current: { skillsFailed: [] } }, async (runner, messages) => {
      await runner.preparePlugins();
      expect(getPluginPrepareFailures(SESSION, "tools")).toEqual([]);
      expect(messages).toEqual([]);
    });
  });

  it("clears a recorded failure once a later pass reports it fixed", async () => {
    const body: { current: unknown } = {
      current: { skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "has no readable SKILL.md" }] },
    };
    await withWorker(body, async (runner, messages) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await runner.preparePlugins();
      expect(getPluginPrepareFailures(SESSION, "tools")).toHaveLength(1);

      body.current = { skillsFailed: [] };
      messages.length = 0;
      await runner.preparePlugins();

      expect(getPluginPrepareFailures(SESSION, "tools")).toEqual([]);
      expect(messages.map((m) => m.type)).toEqual(["plugin_repos_updated"]);
    });
  });

  it("keeps each repository's failures apart, and replaces them all at once (req 14)", async () => {
    const body: { current: unknown } = {
      current: {
        skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "has no readable SKILL.md" }],
        linkFailed: [{ repo: "images", reason: "`/plugins/images` already exists" }],
      },
    };
    await withWorker(body, async (runner) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await runner.preparePlugins();
      expect(getPluginPrepareFailures(SESSION, "tools")).toHaveLength(1);
      expect(getPluginPrepareFailures(SESSION, "images")).toEqual(["`/plugins/images` already exists"]);

      body.current = { skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "has no readable SKILL.md" }] };
      await runner.preparePlugins();
      expect(getPluginPrepareFailures(SESSION, "tools")).toHaveLength(1);
      expect(getPluginPrepareFailures(SESSION, "images")).toEqual([]);
    });
  });

  it("leaves the last observed result standing when the container cannot be reached", async () => {
    await withWorker(
      { current: { skillsFailed: [{ repo: "tools", skill: "reqs/probe", reason: "has no readable SKILL.md" }] } },
      async (runner) => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await runner.preparePlugins();
        expect(getPluginPrepareFailures(SESSION, "tools")).toHaveLength(1);

        runner.setWorkerUrl("http://127.0.0.1:1");
        await runner.preparePlugins();
        expect(getPluginPrepareFailures(SESSION, "tools")).toEqual([
          "Skill `reqs/probe`: has no readable SKILL.md",
        ]);
      },
    );
  });
});

describe("ContainerSessionRunner — an in-flight install counts as busy", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-install-busy-"));
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("counts an in-flight install as busy, so idle reclaim cannot dispose it", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/install" ? { started: true } : { running: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr === "string" || !addr) throw new Error("no server address");
    try {
      const runner = new ContainerSessionRunner({
        sessionId: "s1",
        sessionDir: path.join(dir, "workspace"),
        defaultAgentId: "claude",
        workerUrl: `http://127.0.0.1:${addr.port}`,
      });
      vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);
      expect(runner.agentBusy).toBe(false);

      const install = runner.runInstall(["npm ci"]);
      await vi.waitFor(() => expect(priv(runner)._installInFlight).toBe(true));
      expect(runner.agentBusy).toBe(true);

      priv(runner).signalInstallComplete(true);
      await install;
      expect(runner.agentBusy).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("ContainerSessionRunner — token write-back watch release (docs/153)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-watch-release-"));
    const file = path.join(tmpDir, "sessions", "s1", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { expiresAt: 1_000 } }));
  });

  afterEach(() => {
    stopAllTokenWriteBackWatches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function armWatch(): void {
    startTokenWriteBackWatch({
      credentialsDir: tmpDir, sessionId: "s1", agentId: "claude",
      pollIntervalMs: 10_000, debounceMs: 10_000,
    });
    expect(hasTokenWriteBackWatch("s1")).toBe(true);
  }

  it("releases the watch when a non-streaming turn's process exits", () => {
    const runner = makeRunner();
    armWatch();
    runner.setAgent(null);
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });

  it("keeps the watch while a streaming process survives the slot being cleared", () => {
    const runner = makeRunner();
    runner.isStreamingActive = true;
    armWatch();
    runner.setAgent(null);
    expect(hasTokenWriteBackWatch("s1")).toBe(true);

    runner.isStreamingActive = false;
    expect(hasTokenWriteBackWatch("s1")).toBe(false);
  });
});
