import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { applyModelList, exportModelList, getModel, serializeModelList } from "../shared/catalogue/index.js";
import { claudeModelArg } from "../shared/spawn-routing.js";

class FakeAgent extends EventEmitter {
  agentId: "claude" | "codex" = "claude";
  lastParams: AgentRunParams | null = null;
  messages: string[] = [];
  run(params: AgentRunParams): void {
    this.lastParams = params;
  }
  sendUserMessage(text: string): void {
    this.messages.push(text);
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

  it("holds a message sent during the runtime wait until the agent exists, instead of 400ing it", async () => {
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<never>((_resolve, reject) => {
      releaseRuntime = () => reject(new Error("offline"));
    });
    startNodeRuntimeProvisioning({
      workspaceDir: workspace,
      cacheDir,
      deps: { currentVersion: () => "v24.15.0", listRemoteVersions: () => runtimeGate },
    });

    const start = app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "first prompt", cwd: workspace } },
    });
    let running = false;
    for (let i = 0; i < 50 && !running; i++) {
      await new Promise((r) => setImmediate(r));
      running = (await app.inject({ method: "GET", url: "/agent/status" })).json().running === true;
    }
    expect(running).toBe(true);
    expect(agents).toHaveLength(0);
    const secondStart = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "duplicate", cwd: workspace } },
    });
    expect(secondStart.statusCode).toBe(409);

    const message = app.inject({ method: "POST", url: "/agent/message", payload: { text: "change of scope" } });
    releaseRuntime();

    const [startRes, messageRes] = await Promise.all([start, message]);
    expect(startRes.statusCode, startRes.body).toBe(200);
    expect(messageRes.statusCode, messageRes.body).toBe(200);
    expect(agents).toHaveLength(1);
    expect(agents[0].lastParams?.prompt).toContain("first prompt");
    expect(agents[0].messages).toEqual(["change of scope"]);
  });

  it("refuses a message once the start outlasts the wait, and never applies it later", async () => {
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<never>((_resolve, reject) => {
      releaseRuntime = () => reject(new Error("offline"));
    });
    fs.writeFileSync(path.join(workspace, ".nvmrc"), "22\n");
    startNodeRuntimeProvisioning({
      workspaceDir: workspace,
      cacheDir,
      deps: { currentVersion: () => "v24.15.0", listRemoteVersions: () => runtimeGate },
    });
    const shortApp = Fastify({ logger: false });
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
      messageStartWaitMs: 10,
    }).registerRoutes(shortApp);
    await shortApp.ready();
    try {
      const start = shortApp.inject({
        method: "POST",
        url: "/agent/start",
        payload: { agentId: "claude", params: { prompt: "first prompt", cwd: workspace } },
      });
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setImmediate(r));
        if ((await shortApp.inject({ method: "GET", url: "/agent/status" })).json().running === true) break;
      }
      const message = await shortApp.inject({ method: "POST", url: "/agent/message", payload: { text: "late" } });
      expect(message.statusCode).toBe(409);

      releaseRuntime();
      expect((await start).statusCode).toBe(200);
      expect(agents[0].messages).toEqual([]);
    } finally {
      await shortApp.close();
    }
  });

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
    expect(spawned[0].lastParams?.settingsPath).toBe("/etc/shipit/managed-settings.json");
    expect(spawned[0].lastParams?.sandbox).toBeUndefined();
  });

  it("hands a sandbox spawn's flag through to agent.run", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "claude", prompt: "review", spawnId: "s-4", model: "claude-opus-5", sandbox: true, timeoutMs: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(spawned[0].lastParams?.sandbox).toBe(true);
  });
});

describe("AgentController — /agent/spawn says why a run failed", () => {
  // Put together here, so that no secret scan reads a credential in this file.
  const FAKE_KEY = ["sk", "proj", "k".repeat(28)].join("-");

  type Ending = "exit" | "no-credential" | "success";

  class EndingAgent extends EventEmitter {
    readonly agentId = "codex" as const;
    constructor(private readonly ending: Ending) {
      super();
    }
    run(): void {
      if (this.ending === "no-credential") {
        this.emit("auth_required");
        return;
      }
      setImmediate(() => {
        if (this.ending === "success") {
          this.emit("log", "codex-stderr", "warning: a plugin took 2 s to start");
          this.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "no findings" }] });
          this.emit("event", { type: "agent_result", status: "success" });
          this.emit("done", 0);
          return;
        }
        this.emit("log", "codex-stderr", `error: config.toml is not valid (key ${FAKE_KEY})`);
        this.emit("done", 2);
      });
    }
    kill(): void {}
  }

  let app: FastifyInstance;
  let workspace: string;
  let ending: Ending;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-spawn-fail-"));
    ending = "exit";
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => new EndingAgent(ending) as unknown as AgentProcess,
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => 0,
    }).registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function spawnAndReadDoneLine(spawnId: string): Promise<{ body: Record<string, unknown>; doneLine: string }> {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "codex", prompt: "review", spawnId, model: "gpt-5.6-sol" },
    });
    expect(res.statusCode).toBe(200);
    const doneLine = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes(`worker done spawn=${spawnId}`));
    expect(doneLine).toBeDefined();
    return { body: res.json(), doneLine: doneLine! };
  }

  it("logs the exit code and the stderr tail, with the credential redacted", async () => {
    const { body, doneLine } = await spawnAndReadDoneLine("s-crash");
    expect(body).toMatchObject({ status: "error", exitCode: 2 });
    expect(doneLine).toContain("status=error");
    expect(doneLine).toContain("Exit code 2.");
    expect(doneLine).toContain("config.toml is not valid");
    expect(doneLine).not.toContain(FAKE_KEY);
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it("answers at once, with a reason, when the harness has no credential", async () => {
    ending = "no-credential";
    const { body, doneLine } = await spawnAndReadDoneLine("s-noauth");
    expect(body).toMatchObject({ status: "error" });
    expect(doneLine).toMatch(/reason=".*credential/);
  }, 2_000);

  it("adds no reason to the line of a run that succeeded", async () => {
    ending = "success";
    const { body, doneLine } = await spawnAndReadDoneLine("s-ok");
    expect(body).toMatchObject({ status: "success", text: "no findings" });
    expect(doneLine).not.toContain("reason=");
    expect(doneLine).not.toContain("plugin");
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
  let sseSeq: number;
  let orchestratorStreams: number;
  let unheardTurns: number;
  let controller: AgentController;

  async function status(): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: "GET", url: "/agent/status" });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  async function startTurn(opts: { streaming?: boolean; agentId?: "claude" | "codex" } = {}): Promise<FakeAgent> {
    const agentId = opts.agentId ?? "claude";
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: {
        agentId,
        params: { prompt: "hi", cwd: workspace, ...(opts.streaming ? { useStreaming: true } : {}) },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return agents.at(-1)!;
  }

  // A resident streaming CLI whose first turn has ended.
  async function idleResident(agentId: "claude" | "codex" = "claude"): Promise<FakeAgent> {
    const agent = await startTurn({ streaming: true, agentId });
    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ running: true, turnActive: false });
    return agent;
  }

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-live-"));
    agents = [];
    sseSeq = 0;
    orchestratorStreams = 1;
    unheardTurns = 0;
    resetNodeRuntimeForTests();
    app = Fastify({ logger: false });
    controller = new AgentController({
      agentFactory: (agentId) => {
        const a = new FakeAgent();
        a.agentId = agentId === "codex" ? "codex" : "claude";
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      workspaceDir: workspace,
      broadcast: () => { sseSeq += 1; },
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => sseSeq,
      sseClientCount: () => orchestratorStreams,
      onUnheardTurn: () => { unheardTurns += 1; },
    });
    controller.registerRoutes(app);
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

  it("reports a task notification on a one-shot process, and counts no turn for it", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ turnActive: false, selfWakeActive: false });

    agent.emit("event", { type: "agent_self_wake", taskId: "t1", status: "completed" });
    expect(await status()).toMatchObject({ turnActive: false, selfWakeActive: true });

    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ selfWakeActive: false });
  });

  it("counts a turn a resident CLI starts on a task notification, from the event that starts it", async () => {
    const agent = await idleResident();
    const seqBeforeTheWake = sseSeq;

    agent.emit("event", { type: "agent_self_wake", taskId: "t1", status: "completed" });
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "the tests passed" }] });
    expect(await status()).toMatchObject({
      turnActive: true,
      selfWakeActive: true,
      turnStartSseSeq: seqBeforeTheWake,
    });

    agent.emit("event", { type: "agent_result" });
    expect(await status()).toMatchObject({ turnActive: false, selfWakeActive: false });
  });

  it("says whether an orchestrator heard such a turn start, and reports one that none did", async () => {
    const agent = await idleResident();

    agent.emit("event", { type: "agent_self_wake", taskId: "t1" });
    expect((await status()).ownTurn).toBe("heard");
    agent.emit("event", { type: "agent_result" });
    expect(await status()).not.toHaveProperty("ownTurn");
    expect(unheardTurns).toBe(0);

    orchestratorStreams = 0;
    agent.emit("event", { type: "agent_self_wake", taskId: "t2" });
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "done" }] });
    expect((await status()).ownTurn).toBe("unheard");
    expect(unheardTurns).toBe(1);

    controller.noteOrchestratorStream();
    expect((await status()).ownTurn).toBe("heard");
  });

  it("marks no turn that was sent as the CLI's own", async () => {
    const agent = await idleResident();
    orchestratorStreams = 0;
    agent.emit("event", { type: "agent_self_wake", taskId: "t1" });
    agent.emit("event", { type: "agent_result" });

    const steer = await app.inject({ method: "POST", url: "/agent/message", payload: { text: "next" } });
    expect(steer.statusCode).toBe(200);
    agent.emit("event", { type: "agent_self_wake", taskId: "t2" });
    expect(await status()).toMatchObject({ turnActive: true });
    expect(await status()).not.toHaveProperty("ownTurn");
    expect(unheardTurns).toBe(1);
  });

  it("counts a turn a resident CLI starts by answering a late steer", async () => {
    const agent = await idleResident();

    agent.emit("event", { type: "agent_assistant", parentToolUseId: "toolu_sub", content: [] });
    expect(await status()).toMatchObject({ turnActive: false });

    const seqBeforeTheAnswer = sseSeq;
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "on it" }] });
    expect(await status()).toMatchObject({ turnActive: true, turnStartSseSeq: seqBeforeTheAnswer });
  });

  it("keeps a running turn's start when a task notifies inside it", async () => {
    const agent = await startTurn({ streaming: true });
    const { turnStartSseSeq } = await status();
    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "working" }] });

    agent.emit("event", { type: "agent_self_wake", taskId: "t1" });
    expect(await status()).toMatchObject({ turnActive: true, turnStartSseSeq });
  });

  it("counts no turn for output after the result of a backend that starts none of its own", async () => {
    const agent = await idleResident("codex");

    agent.emit("event", { type: "agent_assistant", content: [{ type: "text", text: "final text" }] });
    expect(await status()).toMatchObject({ turnActive: false });
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

describe("AgentController — a permission request the agent stopped waiting for is denied (docs/193)", () => {
  let app: FastifyInstance;
  let agents: FakeAgent[];
  let workspace: string;
  let broker: PermissionBroker;
  let controller: AgentController;
  let brokerEvents: { type: string; requestId?: string; behavior?: string }[];

  async function startTurn(): Promise<FakeAgent> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "hi", cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    return agents.at(-1)!;
  }

  const denials = () => brokerEvents.filter((e) => e.type === "agent_permission_resolved");

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-perm-"));
    agents = [];
    brokerEvents = [];
    resetNodeRuntimeForTests();
    broker = new PermissionBroker({ broadcast: (e) => brokerEvents.push(e) });
    app = Fastify({ logger: false });
    controller = new AgentController({
      agentFactory: () => {
        const a = new FakeAgent();
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: broker,
      mcpConfig: new McpConfigController({ broadcast: () => {} }),
      latestSseSeq: () => 0,
    });
    controller.registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetNodeRuntimeForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // The shape the Claude CLI emits when its MCP idle timeout ends the gate call.
  it("denies the request when the gated tool call gets its result", async () => {
    const agent = await startTurn();
    const { requestId } = broker.openRequest({ toolName: "Bash", input: { command: "curl x" }, toolUseId: "toolu_1" });
    const { requestId: otherId } = broker.openRequest({ toolName: "Bash", input: { command: "curl y" }, toolUseId: "toolu_2" });

    agent.emit("event", {
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "sent no response or progress for 1800s; aborting." }],
    });

    expect(denials()).toEqual([{
      type: "agent_permission_resolved",
      requestId,
      behavior: "deny",
      callEnded: { summary: expect.stringContaining("curl x"), waitedMs: expect.any(Number) },
    }]);
    expect(denials().some((e) => e.requestId === otherId)).toBe(false);
  });

  it("denies every unanswered request when the agent process exits", async () => {
    const agent = await startTurn();
    const { requestId } = broker.openRequest({ toolName: "Bash", input: { command: "curl x" }, toolUseId: "toolu_1" });

    agent.emit("done", 143);

    expect(denials()).toEqual([{ type: "agent_permission_resolved", requestId, behavior: "deny" }]);
  });

  it("denies a killed agent's requests at the kill, and its late exit leaves the replacement's alone", async () => {
    const killed = await startTurn();
    const { requestId: oldId } = broker.openRequest({ toolName: "Bash", input: { command: "curl x" }, toolUseId: "toolu_old" });
    const kill = await app.inject({ method: "POST", url: "/agent/kill", payload: {} });
    expect(kill.statusCode).toBe(200);
    expect(denials()).toEqual([{ type: "agent_permission_resolved", requestId: oldId, behavior: "deny" }]);

    await startTurn();
    const { requestId: newId } = broker.openRequest({ toolName: "Bash", input: { command: "curl y" }, toolUseId: "toolu_new" });
    killed.emit("done", 143);
    killed.emit("error", new Error("late"));

    expect(denials().some((e) => e.requestId === newId)).toBe(false);
    expect(broker.pendingCount).toBe(1);
  });

  // The order the Claude CLI emits: a background Agent call returns before its subagent's first call.
  it("tells a background subagent's call from a foreground one and from the main agent's", async () => {
    const agent = await startTurn();
    const use = (id: string, name: string) => [{ type: "tool_use", id, name, input: {} }];
    const result = (id: string) => [{ type: "tool_result", tool_use_id: id, content: "ok" }];

    agent.emit("event", { type: "agent_assistant", content: use("agent_bg", "Agent") });
    agent.emit("event", { type: "agent_tool_result", content: result("agent_bg") });
    agent.emit("event", { type: "agent_assistant", content: use("agent_fg", "Agent") });
    agent.emit("event", { type: "agent_assistant", content: use("write_bg", "Write"), parentToolUseId: "agent_bg" });
    agent.emit("event", { type: "agent_assistant", content: use("write_fg", "Write"), parentToolUseId: "agent_fg" });
    agent.emit("event", { type: "agent_assistant", content: use("write_main", "Write") });

    await expect(controller.subagentCaller("write_bg")).resolves.toBe("background");
    await expect(controller.subagentCaller("write_fg")).resolves.toBe("foreground");
    await expect(controller.subagentCaller("write_main")).resolves.toBeUndefined();

    agent.emit("event", { type: "agent_tool_result", content: result("write_bg"), parentToolUseId: "agent_bg" });
    agent.emit("done", 0);
    await expect(controller.subagentCaller("write_fg")).resolves.toBeUndefined();
  });

  it("names the caller of a request that arrives before the stream shows its call", async () => {
    const agent = await startTurn();
    const caller = controller.subagentCaller("write_late");

    agent.emit("event", {
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "write_late", name: "Write", input: {} }],
      parentToolUseId: "agent_bg",
    });

    await expect(caller).resolves.toBe("background");
  });

  it("keeps a replaced process's late events out of its successor's calls", async () => {
    const killed = await startTurn();
    const kill = await app.inject({ method: "POST", url: "/agent/kill", payload: {} });
    expect(kill.statusCode).toBe(200);
    await startTurn();

    killed.emit("event", {
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "write_old", name: "Write", input: {} }],
      parentToolUseId: "agent_old",
    });

    await expect(controller.subagentCaller("write_old")).resolves.toBeUndefined();
  });

  it("reports the requests still waiting, so a restarted orchestrator can check its saved cards", async () => {
    await startTurn();
    const { requestId } = broker.openRequest({ toolName: "Bash", input: { command: "curl x" }, toolUseId: "toolu_1" });

    const res = await app.inject({ method: "GET", url: "/agent/status" });

    expect(res.json()).toMatchObject({ pendingPermissionIds: [requestId] });
  });
});

describe("AgentController — the orchestrator's model list (docs/318)", () => {
  let app: FastifyInstance;
  let workspace: string;
  let agents: FakeAgent[];
  const opus6 = { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-6" } as const;

  async function start(extra: Record<string, unknown> = {}): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "hi", cwd: workspace }, ...extra },
    });
    expect(res.statusCode, res.body).toBe(200);
    agents.at(-1)!.emit("done", 0);
    await new Promise((r) => setImmediate(r));
  }

  function listWithOpus6(): unknown {
    const doc = exportModelList();
    doc.services.anthropic?.sub?.models.push({
      id: "claude-opus-6",
      label: "Opus 6",
      canonicalModelKey: "claude-opus-6",
      family: "claude",
      styles: ["anthropic-messages"],
      price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: { default: 1_000_000 },
    });
    return JSON.parse(serializeModelList(doc));
  }

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ml-"));
    agents = [];
    resetNodeRuntimeForTests();
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => {
        const agent = new FakeAgent();
        agents.push(agent);
        return agent as unknown as AgentProcess;
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
    applyModelList(undefined);
    resetNodeRuntimeForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("runs the agent on the list the start request carries", async () => {
    await start({ modelList: listWithOpus6() });
    expect(getModel(opus6)?.label).toBe("Opus 6");
    expect(claudeModelArg("claude-opus-6")).toBe("claude-opus-6[1m]");
    expect(agents[0]!.lastParams).not.toBeNull();
  });

  it("keeps an adopted list when a later request carries none", async () => {
    await start({ modelList: listWithOpus6() });
    await start();
    expect(agents).toHaveLength(2);
    expect(getModel(opus6)?.label).toBe("Opus 6");
  });
});

// planning#644 — an OpenCode compaction refused before it reaches the server ends its turn
// inside run(), and its done vacates the slot before /agent/start returns.
describe("AgentController — a turn that ends inside run()", () => {
  class EndsInRunAgent extends FakeAgent {
    cleanups = 0;
    override run(params: AgentRunParams): void {
      super.run(params);
      this.emit("event", { type: "agent_result", status: "error", sessionId: "", error: "refused" });
      this.emit("done", 1);
    }
    override writeMcpConfig(): Record<string, never> {
      return { cleanup: () => { this.cleanups += 1; } } as never;
    }
  }

  let app: FastifyInstance;
  let workspace: string;
  let agent: EndsInRunAgent;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-ends-in-run-"));
    resetNodeRuntimeForTests();
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => {
        agent = new EndsInRunAgent();
        return agent as unknown as AgentProcess;
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

  it("starts cleanly, runs the MCP cleanup and frees the slot", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "/compact", cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(agent.cleanups).toBe(1);
    expect((await app.inject({ method: "GET", url: "/agent/status" })).json().running).toBe(false);
  });
});

describe("AgentController — /agent/service-mcp (docs/327)", () => {
  const proxy = { tsxBin: "/usr/bin/node", bridgePath: "/app/dist/mcp-bridges/mcp-service-proxy.js" };
  const verseshot = { name: "verseshot", url: "http://verseshot:8787/mcp" };
  const dev = { name: "verseshotdev", url: "http://api:8787/mcp" };

  class LiveAgent extends FakeAgent {
    liveCalls: string[][] = [];
    accepts = true;
    setLiveMcpServers(servers: { name: string }[]): Promise<boolean> {
      this.liveCalls.push(servers.map((s) => s.name));
      return Promise.resolve(this.accepts);
    }
  }

  let app: FastifyInstance;
  let workspace: string;
  let agent: FakeAgent | null;
  let makeAgent: () => FakeAgent;

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-mcp-"));
    resetNodeRuntimeForTests();
    agent = null;
    makeAgent = () => new LiveAgent();
    const mcpConfig = new McpConfigController({ broadcast: () => {} });
    mcpConfig.serviceProxyPaths = () => proxy;
    app = Fastify({ logger: false });
    new AgentController({
      agentFactory: () => {
        agent = makeAgent();
        return agent as unknown as AgentProcess;
      },
      workspaceDir: workspace,
      broadcast: () => {},
      permissionBroker: new PermissionBroker({ broadcast: () => {} }),
      mcpConfig,
      latestSseSeq: () => 0,
    }).registerRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetNodeRuntimeForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  async function start(serviceMcpServers: typeof verseshot[]): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "p", cwd: workspace, useStreaming: true, serviceMcpServers } },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function sync(serviceMcpServers: typeof verseshot[]): Promise<unknown> {
    const res = await app.inject({ method: "POST", url: "/agent/service-mcp", payload: { serviceMcpServers } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it("gives a running agent a server that was declared after it started, and reports what it holds", async () => {
    await start([dev]);

    expect(await sync([dev, verseshot])).toEqual({ live: [dev, verseshot] });
    expect((agent as LiveAgent).liveCalls).toEqual([["verseshotdev", "verseshot"]]);
  });

  it("sends nothing when the set is the one the agent already holds", async () => {
    await start([verseshot]);

    expect(await sync([verseshot])).toEqual({ live: [verseshot] });
    expect((agent as LiveAgent).liveCalls).toEqual([]);
  });

  it("leaves a changed or removed server to a new process, and reports the old set", async () => {
    await start([verseshot]);

    expect(await sync([{ name: "verseshot", url: "http://verseshot:9000/mcp" }, dev])).toEqual({ live: [verseshot] });
    expect(await sync([])).toEqual({ live: [verseshot] });
    expect((agent as LiveAgent).liveCalls).toEqual([]);
  });

  it("reports the old set when the agent cannot take servers while it runs", async () => {
    makeAgent = () => new FakeAgent();
    await start([]);
    expect(await sync([verseshot])).toEqual({ live: [] });

    makeAgent = () => Object.assign(new LiveAgent(), { accepts: false });
    agent?.emit("done", 0);
    await new Promise((r) => setImmediate(r));
    await start([]);
    expect(await sync([verseshot])).toEqual({ live: [] });
  });

  it("answers null when no agent process runs", async () => {
    expect(await sync([verseshot])).toEqual({ live: null });
  });
});
