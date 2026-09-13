import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentController } from "./agent-controller.js";
import { PermissionBroker } from "./permission-broker.js";
import { McpConfigController } from "./mcp-config-controller.js";
import { resetNodeRuntimeForTests } from "./node-runtime.js";
import type { AgentProcess, AgentRunParams } from "../shared/types.js";

let readEnv: (() => void) | null = null;

class FakeAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  lastParams: AgentRunParams | null = null;
  killed = 0;
  // Real adapters read the routed credential out of the environment here.
  run(params: AgentRunParams): void { this.lastParams = params; readEnv?.(); }
  writeStdin(): void {}
  // A real adapter's kill reaches the CLI, which then exits; the run settles on that.
  kill(): void { this.killed += 1; setImmediate(() => this.emit("done", 0)); }
  interrupt(): void {}
  writeMcpConfig(): Record<string, never> { return {}; }
}

/**
 * docs/299 req 9 — one dictation's deadline must be enforceable without
 * disturbing any other run in the shared cleanup container, so cancellation is
 * addressed by spawn id. /agent/kill targets the resident primary agent instead.
 */
describe("POST /agent/spawn/cancel", () => {
  let app: FastifyInstance;
  let agents: FakeAgent[];
  let workspace: string;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cancel-"));
    agents = [];
    readEnv = null;
    resetNodeRuntimeForTests();
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => {
        const a = new FakeAgent();
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => 0,
    }).registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    resetNodeRuntimeForTests();
  });

  function spawn(spawnId: string) {
    return app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "claude", prompt: "clean this up", spawnId, model: "haiku", toolsOff: true },
    });
  }

  it("ends the named run and leaves the other in flight", async () => {
    const first = spawn("spawn-a");
    const second = spawn("spawn-b");
    await vi.waitFor(() => { expect(agents).toHaveLength(2); });

    const cancel = await app.inject({
      method: "POST", url: "/agent/spawn/cancel", payload: { spawnId: "spawn-a" },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: true });

    const firstResult = (await first).json();
    expect(firstResult.status).toBe("cancelled");
    // The other run is untouched: it only settles when its own agent finishes.
    expect(agents[1]!.killed).toBe(0);
    agents[1]!.emit("done", 0);
    expect((await second).json().status).toBe("success");
  });

  it("passes toolsOff through to the spawned agent", async () => {
    const run = spawn("spawn-c");
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });
    expect(agents[0]!.lastParams?.toolsOff).toBe(true);
    agents[0]!.emit("done", 0);
    await run;
  });

  // The cleanup container has no credential environment of its own, unlike a
  // session container, which has every configured credential pushed into it.
  it("delivers the routed credential for the span the adapter reads it in", async () => {
    let seen: string | undefined = "not-read";
    readEnv = () => { seen = process.env.SHIPIT_CRED_ANTHROPIC; };

    const run = app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: {
        agentId: "claude", prompt: "clean this up", spawnId: "spawn-e", model: "haiku",
        serviceRouting: { credentialSourceEnv: "SHIPIT_CRED_ANTHROPIC" },
        credentialSecret: "sk-secret",
      },
    });
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });

    expect(seen).toBe("sk-secret");
    expect(process.env.SHIPIT_CRED_ANTHROPIC).toBeUndefined();
    agents[0]!.emit("done", 0);
    await run;
  });

  it("reports an unknown spawn rather than cancelling something else", async () => {
    const run = spawn("spawn-d");
    await vi.waitFor(() => { expect(agents).toHaveLength(1); });

    const res = await app.inject({
      method: "POST", url: "/agent/spawn/cancel", payload: { spawnId: "no-such-spawn" },
    });
    expect(res.json()).toEqual({ cancelled: false, unknownSpawn: true });
    expect(agents[0]!.killed).toBe(0);

    agents[0]!.emit("done", 0);
    await run;
  });

  it("rejects a request with no spawn id", async () => {
    const res = await app.inject({ method: "POST", url: "/agent/spawn/cancel", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
