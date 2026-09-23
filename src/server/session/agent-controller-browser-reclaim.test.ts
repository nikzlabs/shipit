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
import { reclaimStillRenderingBrowsers } from "./agents/browser-reclaim.js";

vi.mock("./agents/browser-reclaim.js", () => ({
  reclaimStillRenderingBrowsers: vi.fn(async () => 0),
}));

const reclaim = vi.mocked(reclaimStillRenderingBrowsers);

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

// The reclaim lives on the controller rather than in an adapter, so this covers the
// wiring: which signals make a browser count as unattended (docs/315 req 4, req 6).
describe("AgentController — reclaiming the browser at turn end", () => {
  let app: FastifyInstance;
  let agents: FakeAgent[];
  let workspace: string;

  const settle = () => new Promise((r) => setImmediate(r));

  async function startTurn(): Promise<FakeAgent> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt: "go", cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    return agents.at(-1)!;
  }

  function finishTurn(agent: FakeAgent): void {
    agent.emit("event", { type: "agent_result", subtype: "success", isError: false });
  }

  beforeEach(async () => {
    reclaim.mockClear();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-reclaim-"));
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

  it("runs when a turn ends", async () => {
    finishTurn(await startTurn());
    await settle();
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it("runs when the agent process dies without a result", async () => {
    const agent = await startTurn();
    agent.emit("done", 1);
    await settle();
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  it("reports the browser as attended once the next turn has started", async () => {
    const agent = await startTurn();
    finishTurn(agent);
    await settle();
    const stillIdle = reclaim.mock.calls[0]![0].stillIdle;
    expect(stillIdle()).toBe(true);

    agent.emit("done", 0);
    await settle();
    await startTurn();
    expect(stillIdle()).toBe(false);
  });

  it("does not reclaim while background tasks are running", async () => {
    const agent = await startTurn();
    agent.emit("event", { type: "agent_background_tasks", tasks: [{ id: "t1" }] });
    finishTurn(agent);
    await settle();
    expect(reclaim).not.toHaveBeenCalled();
  });

  it("does not reclaim while a sub-agent spawn is in flight", async () => {
    // Not awaited: the route resolves only when the spawned agent finishes, and this one
    // never does — which is the point. A spawn outlives the primary turn.
    void app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "claude", prompt: "review", spawnId: "s1", model: "claude-opus-5" },
    });
    await settle();
    await settle();

    finishTurn(await startTurn());
    await settle();

    expect(reclaim).not.toHaveBeenCalled();
  });

  // Skipping is a deferral, not a drop: the browser the turn abandoned would otherwise
  // render until some later turn happened to end at a quiet moment.
  it("reclaims once the spawn that blocked it finishes", async () => {
    const spawn = app.inject({
      method: "POST",
      url: "/agent/spawn",
      payload: { agentId: "claude", prompt: "review", spawnId: "s1", model: "claude-opus-5" },
    });
    await settle();
    await settle();
    const spawned = agents.at(-1)!;

    const primary = await startTurn();
    finishTurn(primary);
    await settle();
    expect(reclaim).not.toHaveBeenCalled();

    spawned.emit("event", { type: "agent_result", subtype: "success", isError: false });
    spawned.emit("done", 0);
    await spawn;
    await settle();

    expect(reclaim).toHaveBeenCalledTimes(1);
  });
});
