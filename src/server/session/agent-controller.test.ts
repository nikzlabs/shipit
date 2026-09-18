import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentController } from "./agent-controller.js";
import { PermissionBroker } from "./permission-broker.js";
import { McpConfigController } from "./mcp-config-controller.js";
import {
  provisionNodeRuntime,
  resetNodeRuntimeForTests,
  startNodeRuntimeProvisioning,
} from "./node-runtime.js";
import type { AgentProcess, AgentRunParams } from "../shared/types.js";

class FakeAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  lastParams: AgentRunParams | null = null;
  run(params: AgentRunParams): void {
    this.lastParams = params;
  }
  writeStdin(): void {}
  kill(): void {}
  interrupt(): void {}
  writeMcpConfig(): Record<string, never> {
    return {};
  }
}

describe("AgentController — Node pin notice on the first turn", () => {
  let app: FastifyInstance;
  let agents: FakeAgent[];
  let workspace: string;
  let cacheDir: string;
  let originalPath: string | undefined;

  async function startTurn(prompt: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt, cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const agent = agents.at(-1)!;
    const started = agent.lastParams?.prompt ?? "";
    agent.emit("done", 0);
    await new Promise((r) => setImmediate(r));
    return started;
  }

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ws-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-cache-"));
    originalPath = process.env.PATH;
    agents = [];
    resetNodeRuntimeForTests();

    app = Fastify({ logger: false });
    const controller = new AgentController({
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
    });
    controller.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.env.PATH = originalPath;
    delete process.env.SHIPIT_PINNED_NODE;
    resetNodeRuntimeForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  async function provisionFailure(): Promise<void> {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");
    startNodeRuntimeProvisioning({
      workspaceDir: workspace,
      cacheDir,
      deps: {
        currentVersion: () => "v24.15.0",
        listRemoteVersions: async () => {
          throw new Error("getaddrinfo EAI_AGAIN nodejs.org");
        },
      },
    });
  }

  it("stays completely silent when the repo pins nothing", async () => {
    const prompt = await startTurn("fix the build");
    expect(prompt).toBe("fix the build");
  });

  it("stays silent when the pin was honored", async () => {
    fs.writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ engines: { node: ">=20" } }),
    );
    startNodeRuntimeProvisioning({
      workspaceDir: workspace,
      cacheDir,
      deps: { currentVersion: () => "v24.15.0" },
    });
    const prompt = await startTurn("fix the build");
    expect(prompt).toBe("fix the build");
  });

  it("leads the first turn's prompt with the note when the pin failed", async () => {
    await provisionFailure();
    const prompt = await startTurn("why does the native module not build?");

    expect(prompt.startsWith("<system>")).toBe(true);
    expect(prompt).toContain("24.15.0");
    expect(prompt).toContain("22 (.nvmrc)");
    expect(prompt).toContain("EAI_AGAIN");
    expect(prompt.endsWith("why does the native module not build?")).toBe(true);
  });

  it("says it once per container, not on every turn", async () => {
    await provisionFailure();
    const first = await startTurn("one");
    const second = await startTurn("two");

    expect(first).toContain("<system>");
    expect(second).toBe("two");
  });

  it("keeps a slash command at position 0", async () => {
    await provisionFailure();
    const prompt = await startTurn("/compact");
    expect(prompt.startsWith("/compact")).toBe(true);
    expect(prompt).toContain("<system>");
  });

  it("does not fire for a pin that resolves cleanly", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");
    const status = await provisionNodeRuntime({
      workspaceDir: workspace,
      cacheDir,
      deps: {
        currentVersion: () => "v24.15.0",
        listRemoteVersions: async () => [{ major: 22, minor: 20, patch: 1 }],
        install: async (v, dir) => {
          const bin = path.join(dir, `node-v${v.major}.${v.minor}.${v.patch}-linux-x64`, "bin");
          fs.mkdirSync(bin, { recursive: true });
          fs.writeFileSync(path.join(bin, "node"), "");
          return path.dirname(bin);
        },
      },
    });
    expect(status.mismatch).toBe(false);
  });
});

describe("AgentController — /agent/spawn requires a model (docs/261)", () => {
  let app: FastifyInstance;
  let workspace: string;
  let spawned: FakeAgent[];

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-spawn-"));
    spawned = [];
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => {
        const a = new FakeAgent();
        spawned.push(a);
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
  });

  it("400s a spawn with no model, and runs nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "claude", prompt: "review", spawnId: "s-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error as string).toMatch(/model is required/);
    expect(spawned).toHaveLength(0);
  });

  it("accepts a spawn that names one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: {
        agentId: "claude",
        prompt: "review",
        spawnId: "s-2",
        model: "claude-opus-5",
        timeoutMs: 50,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].lastParams?.model).toBe("claude-opus-5");
  });

  it("hands the spawn's homeDir through to agent.run", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: {
        agentId: "claude",
        prompt: "review",
        spawnId: "s-3",
        model: "claude-opus-5",
        homeDir: "/credentials/sub-agent-homes/s-3",
        timeoutMs: 50,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].lastParams?.homeDir).toBe("/credentials/sub-agent-homes/s-3");
  });
});

describe("AgentController — the primary's lifecycle does not end a spawn (docs/144 §8)", () => {
  class SpawnAgent extends EventEmitter {
    readonly agentId = "claude" as const;
    killed = false;
    lastParams: AgentRunParams | null = null;
    run(params: AgentRunParams): void { this.lastParams = params; }
    writeStdin(): void {}
    interrupt(): void {}
    writeMcpConfig(): Record<string, never> { return {}; }
    kill(): void {
      if (this.killed) return;
      this.killed = true;
      this.emit("done", 143);
    }
    finish(text: string): void {
      this.emit("event", {
        type: "agent_assistant",
        content: [{ type: "text", text }],
        isStreamCompletion: true,
      });
      this.emit("event", { type: "agent_result", status: "success" });
      this.emit("done", 0);
    }
  }

  let app: FastifyInstance;
  let workspace: string;
  let agents: SpawnAgent[];
  let controller: AgentController;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-life-"));
    agents = [];
    app = Fastify({ logger: false });
    controller = new AgentController({
      agentFactory: () => {
        const a = new SpawnAgent();
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => 0,
    });
    controller.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function startPrimaryAndSpawn(): Promise<{
    primary: SpawnAgent;
    sub: SpawnAgent;
    spawnResponse: Promise<{ statusCode: number; json: () => { status: string; text: string } }>;
  }> {
    const started = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: {
        agentId: "claude",
        runToken: "rt-1",
        params: { prompt: "do the work", cwd: workspace },
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const primary = agents.at(-1)!;

    const spawnResponse = app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: {
        agentId: "claude",
        prompt: "review the diff",
        spawnId: "sp-1",
        model: "claude-opus-5",
      },
    }) as unknown as Promise<{ statusCode: number; json: () => { status: string; text: string } }>;
    // Wait for registration so cancellation is tested against a live spawn.
    for (let i = 0; i < 50 && agents.length < 2; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(agents).toHaveLength(2);
    const sub = agents[1];
    expect(sub).not.toBe(primary);
    return { primary, sub, spawnResponse };
  }

  it("leaves an in-flight spawn running when the primary turn is interrupted", async () => {
    const { sub, spawnResponse } = await startPrimaryAndSpawn();

    const res = await app.inject({ method: "POST", url: "/agent/interrupt" });
    expect(res.statusCode).toBe(200);
    expect(sub.killed).toBe(false);

    sub.finish("9 findings");
    const spawn = await spawnResponse;
    expect(spawn.statusCode).toBe(200);
    expect(spawn.json()).toMatchObject({ status: "success", text: "9 findings" });
  });

  it("leaves it running with no resident primary either", async () => {
    const { primary, sub, spawnResponse } = await startPrimaryAndSpawn();
    primary.emit("done", 0);
    await new Promise((r) => setImmediate(r));

    const res = await app.inject({ method: "POST", url: "/agent/interrupt" });
    expect(res.statusCode).toBe(404);
    expect(sub.killed).toBe(false);

    sub.finish("still here");
    expect((await spawnResponse).json()).toMatchObject({ status: "success", text: "still here" });
  });

  it("leaves it running when the primary is killed — an explicit Stop", async () => {
    const { primary, sub, spawnResponse } = await startPrimaryAndSpawn();

    const res = await app.inject({
      method: "POST",
      url: "/agent/kill",
      payload: { runToken: "rt-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ killed: true });
    expect(primary.killed).toBe(true);
    expect(sub.killed).toBe(false);

    sub.finish("outlived its turn");
    const spawn = await spawnResponse;
    expect(spawn.statusCode).toBe(200);
    expect(spawn.json()).toMatchObject({ status: "success", text: "outlived its turn" });
  });

  it("still cancels spawns when the worker itself goes down", async () => {
    const { sub, spawnResponse } = await startPrimaryAndSpawn();

    controller.stop();
    expect(sub.killed).toBe(true);

    const spawn = await spawnResponse;
    expect(spawn.json()).toMatchObject({ status: "cancelled" });
  });
});

describe("AgentController — /agent/status publishes worker-side liveness", () => {
  let app: FastifyInstance;
  let agents: FakeAgent[];
  let workspace: string;

  async function status(): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: "GET", url: "/agent/status" });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  async function startTurn(): Promise<FakeAgent> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "hi", cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    return agents.at(-1)!;
  }

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-live-"));
    agents = [];
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
    resetNodeRuntimeForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("reports nothing live on a fresh controller", async () => {
    expect(await status()).toMatchObject({
      running: false,
      turnActive: false,
      backgroundTaskCount: 0,
      selfWakeActive: false,
    });
  });

  it("keeps the background-task count across the end of the turn that started it", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1" }, { id: "t2" }] });
    expect(await status()).toMatchObject({ turnActive: true, backgroundTaskCount: 2 });

    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ turnActive: false, backgroundTaskCount: 2 });

    agent.emit("event", { type: "agent_background_tasks", tasks: [] });
    expect(await status()).toMatchObject({ backgroundTaskCount: 0 });
  });

  it("reports a self-woken turn, and clears it on the turn's result", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ turnActive: false, selfWakeActive: false });

    agent.emit("event", { type: "agent_self_wake", taskId: "t1", status: "completed" });
    expect(await status()).toMatchObject({ turnActive: false, selfWakeActive: true });

    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ selfWakeActive: false });
  });

  it("clears the background-task count when the agent process dies", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1" }] });
    agent.emit("event", { type: "agent_self_wake", taskId: "t1" });
    expect(await status()).toMatchObject({ backgroundTaskCount: 1, selfWakeActive: true });

    agent.emit("done", 0);
    await new Promise((r) => setImmediate(r));
    expect(await status()).toMatchObject({
      running: false,
      turnActive: false,
      backgroundTaskCount: 0,
      selfWakeActive: false,
    });
  });

  it("clears the background-task count when the agent is KILLED, not just when it exits", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1" }] });

    const res = await app.inject({ method: "POST", url: "/agent/kill", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(await status()).toMatchObject({ running: false, backgroundTaskCount: 0 });

    agent.emit("done", 143);
    await new Promise((r) => setImmediate(r));
    expect(await status()).toMatchObject({ backgroundTaskCount: 0 });
  });

  it("reports terminal and install liveness from the controllers that own them", async () => {
    const live = { terminalActive: true, installRunning: true };
    const app2 = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => new FakeAgent() as unknown as AgentProcess,
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => 0,
      otherWorkerLiveness: () => live,
    }).registerRoutes(app2);
    await app2.ready();
    try {
      const res = await app2.inject({ method: "GET", url: "/agent/status" });
      expect(res.json()).toMatchObject({ terminalActive: true, installRunning: true });
      live.terminalActive = false;
      live.installRunning = false;
      const after = await app2.inject({ method: "GET", url: "/agent/status" });
      expect(after.json()).toMatchObject({ terminalActive: false, installRunning: false });
    } finally {
      await app2.close();
    }
  });

  it("reports no terminal or install work when nothing supplies the getter", async () => {
    expect(await status()).toMatchObject({ terminalActive: false, installRunning: false });
  });

  it("ignores liveness events from a process that no longer holds the slot", async () => {
    const retired = await startTurn();
    retired.emit("done", 0);
    await new Promise((r) => setImmediate(r));
    const current = await startTurn();
    current.emit("event", { type: "agent_background_tasks", tasks: [{ id: "live" }] });

    retired.emit("event", { type: "agent_background_tasks", tasks: [{ id: "a" }, { id: "b" }] });
    retired.emit("event", { type: "agent_self_wake", taskId: "a" });
    expect(await status()).toMatchObject({ backgroundTaskCount: 1, selfWakeActive: false });
  });
});
