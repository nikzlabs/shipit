import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { AgentController } from "./agent-controller.js";
import { PermissionBroker } from "./permission-broker.js";
import { McpConfigController } from "./mcp-config-controller.js";
import type { AgentGoalCommand, AgentGoalCommandResult, AgentProcess } from "../shared/types.js";

class GoalAgent extends EventEmitter {
  readonly agentId = "codex" as const;
  calls: { threadId: string; command: AgentGoalCommand }[] = [];
  constructor(private readonly answer: () => Promise<AgentGoalCommandResult>) {
    super();
  }
  run(): void {}
  writeStdin(): void {}
  kill(): void {}
  interrupt(): void {}
  writeMcpConfig(): Record<string, never> {
    return {};
  }
  goalCommand(threadId: string, command: AgentGoalCommand): Promise<AgentGoalCommandResult> {
    this.calls.push({ threadId, command });
    return this.answer();
  }
}

class PlainAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  run(): void {}
  writeStdin(): void {}
  kill(): void {}
  interrupt(): void {}
  writeMcpConfig(): Record<string, never> {
    return {};
  }
}

describe("AgentController /agent/goal (docs/154)", () => {
  let app: FastifyInstance;
  let agents: (GoalAgent | PlainAgent)[];
  let answer: () => Promise<AgentGoalCommandResult>;

  beforeEach(async () => {
    agents = [];
    answer = () => Promise.resolve({ goal: null });
    app = Fastify({ logger: false });
    const controller = new AgentController({
      agentFactory: (agentId) => {
        const a = agentId === "codex" ? new GoalAgent(() => answer()) : new PlainAgent();
        agents.push(a);
        return a as unknown as AgentProcess;
      },
      workspaceDir: "/tmp",
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
  });

  const post = (payload: object) => app.inject({ method: "POST", url: "/agent/goal", payload });

  it("answers from a fresh adapter when no turn is live", async () => {
    const res = await post({ agentId: "codex", threadId: "t1", command: { action: "clear" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ goal: null });
    expect(agents).toHaveLength(1);
    expect((agents[0] as GoalAgent).calls).toEqual([{ threadId: "t1", command: { action: "clear" } }]);
  });

  it("answers from the live turn's agent", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "codex", params: { prompt: "hi", cwd: "/tmp" } },
    });
    expect(start.statusCode, start.body).toBe(200);

    const res = await post({ agentId: "codex", threadId: "t1", command: { action: "get" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(agents).toHaveLength(1);
    expect((agents[0] as GoalAgent).calls).toHaveLength(1);
  });

  it("rejects a malformed command", async () => {
    expect((await post({ agentId: "codex", threadId: "t1", command: { action: "set", objective: "  " } })).statusCode).toBe(400);
    expect((await post({ agentId: "codex", threadId: "t1", command: { action: "drop" } })).statusCode).toBe(400);
    expect((await post({ agentId: "codex", command: { action: "get" } })).statusCode).toBe(400);
    expect(agents).toHaveLength(0);
  });

  it("refuses an agent without goals", async () => {
    const res = await post({ agentId: "claude", threadId: "t1", command: { action: "get" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Agent claude does not support goals" });
  });

  it("reports the adapter's failure", async () => {
    answer = () => Promise.reject(new Error("thread not found: t1"));
    const res = await post({ agentId: "codex", threadId: "t1", command: { action: "get" } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "thread not found: t1" });
  });
});
