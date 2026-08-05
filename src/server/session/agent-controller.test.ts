/**
 * docs/248 req 8 — the Node-pin system note that rides the first turn's prompt.
 *
 * Exercised through the real `/agent/start` route with a fake agent, because
 * the behaviour being pinned is an interaction between three things: the
 * provisioning singleton's resolved status, the once-per-container latch, and
 * where the note lands in the prompt handed to the CLI.
 */

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

/**
 * Captures the params it was run with; emits nothing on its own. Deliberately
 * not `implements AgentProcess` — these tests exercise one route, and the fake
 * carries only what that route touches.
 */
class FakeAgent extends EventEmitter {
  readonly agentId = "claude" as const;
  lastParams: AgentRunParams | null = null;
  run(params: AgentRunParams): void {
    this.lastParams = params;
  }
  writeStdin(): void {}
  kill(): void {}
  interrupt(): void {}
  /** The controller always invokes the adapter's MCP writer before `run`. */
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

  /** Start a turn and return the prompt the agent was actually run with. */
  async function startTurn(prompt: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      payload: { agentId: "claude", params: { prompt, cwd: workspace } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const agent = agents.at(-1)!;
    const started = agent.lastParams?.prompt ?? "";
    // Free the single-occupant slot so the next turn can start.
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

  /** Drive the singleton to a real `failed` status for a repo pinning 22. */
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
    // A repo whose range the container already satisfies — the common case.
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
    // The user's request survives intact, after the note.
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
    // Prefixing here would stop the CLI parsing it as a command.
    await provisionFailure();
    const prompt = await startTurn("/compact");
    expect(prompt.startsWith("/compact")).toBe(true);
    expect(prompt).toContain("<system>");
  });

  it("does not fire for a pin that resolves cleanly", async () => {
    // Belt and braces: a `provisioned` status is a success, not a warning.
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
