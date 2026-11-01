// The whole path that a lost caller takes: the real shim process, the worker's relay, the orchestrator's route.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as realSleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../api-routes.js";
import { registerPluginRepoRoutes } from "../api-routes-plugin-repos.js";
import type { PluginCliRequest, PluginCliResult } from "../plugin-cli-run.js";
import { registerAgentOpsRoutes } from "../../session/agent-ops-routes.js";
import { OrchestratorClient } from "../../session/orchestrator-client.js";
import { killChild, killProcessTree } from "../../shared/kill-child.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SHIM = path.join(REPO_ROOT, "src/server/session/agent-shim/shipit.ts");
const SESSION = "ses_me";
const STOPPED: PluginCliResult = {
  exitCode: 125, stdout: "", stderr: "", error: "the caller went away while the command was running",
};

describe("Integration: a plugin command whose caller goes away (docs/262-plugins req 32)", () => {
  let orchestrator: FastifyInstance;
  let orchestratorUrl: string;
  let running: PluginCliRequest | undefined;
  let finish: (result: PluginCliResult) => void = () => undefined;
  const workers: FastifyInstance[] = [];
  const shims: ChildProcess[] = [];
  // Both routes run in this process, as each does in its own; a vitest run does not report these by itself.
  const unhandled: unknown[] = [];
  const record = (err: unknown): void => { unhandled.push(err); };

  beforeEach(async () => {
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    running = undefined;
    orchestrator = Fastify({ logger: false });
    await registerPluginRepoRoutes(orchestrator, {
      sessionManager: { get: (id: string) => (id === SESSION ? { workspaceDir: "/ws" } : undefined) },
      runPluginCommandForSession: (_id: string, _dir: string, request: PluginCliRequest) => {
        running = request;
        return new Promise<PluginCliResult>((resolve) => { finish = resolve; });
      },
    } as unknown as ApiDeps);
    await orchestrator.listen({ port: 0, host: "127.0.0.1" });
    orchestratorUrl = `http://127.0.0.1:${(orchestrator.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const shim of shims.splice(0)) killProcessTree(shim, "SIGKILL");
    finish({ exitCode: 0, stdout: "", stderr: "" });
    for (const worker of workers.splice(0)) await worker.close();
    await orchestrator.close();
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
    expect(unhandled.splice(0)).toEqual([]);
  });

  const realClient = (): OrchestratorClient => new OrchestratorClient({ baseUrl: orchestratorUrl, sessionId: SESSION });

  async function startWorker(client: OrchestratorClient = realClient()): Promise<string> {
    const worker = Fastify({ logger: false });
    workers.push(worker);
    registerAgentOpsRoutes(worker, { createOrchestratorClient: () => client });
    await worker.listen({ port: 0, host: "127.0.0.1" });
    return `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  }

  // Its own process group, as a command has under a shell with job control and under `timeout`.
  function startShim(
    workerUrl: string,
    stdin: "ignore" | "pipe" = "ignore",
  ): { shim: ChildProcess; output: () => string; exited: Promise<number | null> } {
    const shim = spawn(TSX, [SHIM, "plugin", "exec", "--alias", "reqs", "--command", "reqs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SHIPIT_AGENT_OPS_URL: workerUrl },
      stdio: [stdin, "pipe", "pipe"],
      detached: true,
    });
    shims.push(shim);
    let text = "";
    shim.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    shim.stderr?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => { shim.on("close", (code) => resolve(code)); });
    return { shim, output: () => text, exited };
  }

  const toGroup = (signal: NodeJS.Signals) => (shim: ChildProcess): void => {
    if (shim.pid) process.kill(-shim.pid, signal);
  };

  const commandRuns = async (): Promise<() => boolean> => {
    await vi.waitFor(() => { expect(running).toBeDefined(); }, { timeout: 30_000, interval: 50 });
    return running!.callerGone!;
  };

  const saysGone = (callerGone: () => boolean): Promise<void> =>
    vi.waitFor(() => { expect(callerGone()).toBe(true); }, { timeout: 10_000, interval: 50 });

  // The launcher is two processes (tsx starts a second node), so each row says which of them get the signal.
  it.each<[string, (shim: ChildProcess) => void]>([
    ["Ctrl-C (SIGINT to its process group)", toGroup("SIGINT")],
    ["`timeout` (SIGTERM to its process group)", toGroup("SIGTERM")],
    ["`timeout -s KILL` (SIGKILL to its process group)", toGroup("SIGKILL")],
    ["a kill of its process tree, as ShipIt does to a turn", (shim) => { killProcessTree(shim, "SIGKILL"); }],
    ["SIGINT to its first process only", (shim) => { killChild(shim, "SIGINT"); }],
    ["SIGTERM to its first process only", (shim) => { killChild(shim, "SIGTERM"); }],
  ])("tells the command's run when the shim ends by %s", { timeout: 60_000 }, async (_name, end) => {
    const { shim } = startShim(await startWorker());
    const callerGone = await commandRuns();
    expect(callerGone()).toBe(false);

    end(shim);

    await saysGone(callerGone);
    // The stopped command's result: each route now answers into a connection that is closed.
    finish(STOPPED);
    await realSleep(50);
  });

  it("tells the command's run when the shim ends while the caller's stdin is open", { timeout: 60_000 }, async () => {
    const { shim } = startShim(await startWorker(), "pipe");
    shim.stdin?.write("first\n");
    const callerGone = await commandRuns();
    const stdin = running!.stdin as Readable;
    let taken = "";
    stdin.on("data", (chunk: Buffer) => { taken += chunk.toString(); });
    await vi.waitFor(() => { expect(taken).toBe("first\n"); }, { timeout: 10_000, interval: 50 });
    expect(stdin.readableEnded).toBe(false);

    toGroup("SIGTERM")(shim);

    await saysGone(callerGone);
    finish(STOPPED);
    await vi.waitFor(() => { expect(stdin.destroyed).toBe(true); });
  });

  it("tells the command's run when the shim ends because it could not deliver stdin", { timeout: 60_000 }, async () => {
    const real = realClient();
    const refusesStdin = {
      request: (...args: Parameters<OrchestratorClient["request"]>) =>
        args[1] === "/plugin/exec/stdin"
          ? Promise.resolve({ ok: false, status: 409, body: { error: "refused for this test" } })
          : real.request(...args),
    } as unknown as OrchestratorClient;
    const { shim, output, exited } = startShim(await startWorker(refusesStdin), "pipe");
    const callerGone = await commandRuns();

    shim.stdin?.write("not delivered\n");

    expect(await exited).toBe(2);
    expect(output()).toContain("Could not deliver stdin to `reqs`: refused for this test");
    expect(output()).toContain("ShipIt stops the command");
    await saysGone(callerGone);
    finish(STOPPED);
    await realSleep(50);
  });

  it("gives a shim that waits the command's result", { timeout: 60_000 }, async () => {
    const { output, exited } = startShim(await startWorker());
    const callerGone = await commandRuns();

    finish({ exitCode: 3, stdout: "done\n", stderr: "" });

    expect(await exited).toBe(3);
    expect(output()).toBe("done\n");
    expect(callerGone()).toBe(false);
  });
});
