// The whole path of the git hook's read: the real hook process, the worker's relay, the orchestrator's route.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { DatabaseManager } from "../../shared/database.js";
import type { ApiDeps } from "../api-routes.js";
import { registerGitRoutes } from "../api-routes-git.js";
import { SessionManager } from "../sessions.js";
import { registerAgentOpsRoutes } from "../../session/agent-ops-routes.js";
import { OrchestratorClient } from "../../session/orchestrator-client.js";
import { createTestDatabaseManager } from "./test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "../../../../docker/agent-hooks/block-branch-ops.mjs");
const SESSION = "ses_me";
const AT_SPAWN_MERGED = { SHIPIT_GUARD_DESTRUCTIVE_GIT: "1" };

describe("Integration: the merged-branch git guard on a resident agent process (planning#694)", () => {
  let db: DatabaseManager;
  let sessions: SessionManager;
  let orchestrator: FastifyInstance;
  let orchestratorPort: number;
  let workerUrl: string;
  const workers: FastifyInstance[] = [];
  const stale: net.Server[] = [];

  beforeEach(async () => {
    db = createTestDatabaseManager();
    sessions = new SessionManager(db);
    sessions.track(SESSION, "A session");

    orchestrator = Fastify({ logger: false });
    await registerGitRoutes(orchestrator, {
      sessionManager: sessions,
      createGitManager: () => { throw new Error("this path reads no git"); },
    } as unknown as ApiDeps);
    await orchestrator.listen({ port: 0, host: "127.0.0.1" });
    orchestratorPort = (orchestrator.server.address() as AddressInfo).port;
    workerUrl = await startWorker(
      new OrchestratorClient({ baseUrl: `http://127.0.0.1:${orchestratorPort}`, sessionId: SESSION }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const worker of workers.splice(0)) await worker.close();
    for (const server of stale.splice(0)) await new Promise((resolve) => server.close(resolve));
    await orchestrator.close();
    db.close();
  });

  async function startWorker(client: OrchestratorClient): Promise<string> {
    const worker = Fastify({ logger: false });
    workers.push(worker);
    registerAgentOpsRoutes(worker, { createOrchestratorClient: () => client });
    await worker.listen({ port: 0, host: "127.0.0.1" });
    return `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  }

  // `atSpawn` is the environment the agent process got when it started, which it keeps.
  function runHook(
    command: string,
    atSpawn: Record<string, string> = {},
    worker: string = workerUrl,
  ): Promise<{ status: number | null; stderr: string }> {
    const {
      SHIPIT_GUARD_DESTRUCTIVE_GIT: _guard,
      SHIPIT_SANDBOX: _sandbox,
      WORKER_PORT: _port,
      ...ambient
    } = process.env;
    return new Promise((resolve, reject) => {
      const child = spawn("node", [HOOK], {
        env: { ...ambient, ...atSpawn, SHIPIT_AGENT_OPS_URL: worker },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
    });
  }

  it("guards a process that started before the merge, and frees one that started on the merged branch after the reset", async () => {
    expect((await runHook("git reset --hard origin/main")).status).toBe(0);

    // Merge detection, while the process from before stays up.
    sessions.markMerged(SESSION);
    sessions.setMergedHeadSha(SESSION, "a1f3c9d0");
    const refused = await runHook("git fetch origin && git reset --hard origin/main");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("shipit branch reset-to-base");
    expect((await runHook("git rebase origin/main", AT_SPAWN_MERGED)).status).toBe(2);

    // What a reset's re-arm does to the row (`services/pr-rearm.ts`).
    sessions.clearMerged(SESSION, null);
    expect(await runHook("git reset --hard origin/main", AT_SPAWN_MERGED)).toEqual({ status: 0, stderr: "" });
    expect((await runHook("git rebase origin/main")).status).toBe(0);
  });

  // After ShipIt's container is recreated a worker keeps the old address first (planning#626).
  it("gets its answer from the next orchestrator address when the first one does not answer", async () => {
    const sockets: net.Socket[] = [];
    const first = net.createServer((socket) => { sockets.push(socket); });
    stale.push(first);
    await new Promise<void>((resolve) => first.listen(orchestratorPort, "127.0.0.2", resolve));
    vi.stubEnv("SHIPIT_HOST", "127.0.0.2");
    vi.stubEnv("SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS", "127.0.0.1");
    vi.stubEnv("SHIPIT_PORT", String(orchestratorPort));
    vi.stubEnv("SESSION_ID", SESSION);
    const staleFirst = await startWorker(new OrchestratorClient());
    sessions.markMerged(SESSION);
    sessions.setMergedHeadSha(SESSION, "a1f3c9d0");

    const refused = await runHook("git reset --hard origin/main", {}, staleFirst);

    expect(sockets).toHaveLength(1);
    expect(refused.status).toBe(2);
    for (const socket of sockets) socket.destroy();
  });

  it("takes the spawn value when the orchestrator is gone", async () => {
    await orchestrator.close();

    expect((await runHook("git reset --hard origin/main", AT_SPAWN_MERGED)).status).toBe(2);
    expect((await runHook("git reset --hard origin/main")).status).toBe(0);
  });
});
