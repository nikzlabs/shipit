import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { SystemTurnDeps } from "../session-runner.js";
import type { RequestedRestartTurn } from "../services/agent-restart-request.js";
import type { SubAgentConsultCard } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const captured = vi.hoisted(() => ({
  executor: [] as unknown[],
  restart: [] as { quotaContinuation?: unknown }[],
  jobs: [] as { quotaContinuation?: unknown }[],
  consult: [] as { quotaContinuation?: unknown }[],
  started: [] as unknown[],
}));

vi.mock("../turn-executor.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../turn-executor.js")>("../turn-executor.js");
  const executeAgentTurn: typeof real.executeAgentTurn = (runner, deps, agent, input) => {
    captured.executor.push(deps);
    return real.executeAgentTurn(runner, deps, agent, input);
  };
  return { ...real, executeAgentTurn };
});

vi.mock("../services/agent-restart-request.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../services/agent-restart-request.js")>(
    "../services/agent-restart-request.js",
  );
  return {
    ...real,
    runRequestedRestart: (deps: { quotaContinuation?: unknown }) => {
      captured.restart.push(deps);
      return Promise.resolve();
    },
  };
});

vi.mock("../services/stopped-background-jobs.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../services/stopped-background-jobs.js")>(
    "../services/stopped-background-jobs.js",
  );
  return {
    ...real,
    reportStoppedBackgroundJobs: (deps: { quotaContinuation?: unknown }) => {
      captured.jobs.push(deps);
      return Promise.resolve({ woken: false, reason: "no-jobs" });
    },
  };
});

vi.mock("../services/consult-result-delivery.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../services/consult-result-delivery.js")>(
    "../services/consult-result-delivery.js",
  );
  return {
    ...real,
    deliverConsultResultByWake: (deps: { quotaContinuation?: unknown }) => {
      captured.consult.push(deps);
      return Promise.resolve({ woken: false, reason: "no-session" });
    },
  };
});

// The route's own gates are not under test: the spawn finishes at once and delivers its result.
vi.mock("../services/sub-agent.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../services/sub-agent.js")>("../services/sub-agent.js");
  return {
    ...real,
    runSubAgent: async (
      deps: { deliverConsultResult?: (req: unknown) => Promise<unknown> },
      sessionId: string,
    ) => {
      const card = { cardId: "c1", spawnId: "s1", subAgentId: "codex", status: "success", createdAt: "" };
      await deps.deliverConsultResult?.({ sessionId, card: card as SubAgentConsultCard, originatingTurnEpoch: 0 });
      return { ok: true };
    },
  };
});

vi.mock("../services/quota-continuation.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../services/quota-continuation.js")>(
    "../services/quota-continuation.js",
  );
  class QuotaContinuationManager extends real.QuotaContinuationManager {
    override start(): void {
      captured.started.push(this);
      super.start();
    }
  }
  return { ...real, QuotaContinuationManager };
});

/**
 * docs/306-quota-continuation — each owner of an automatic wake takes the manager as an
 * optional dependency, so its unit tests stay green when the composition root does not pass it.
 */
describe("Integration: every automatic wake can hand a quota refusal to the quota continuation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as never;

  beforeEach(async () => {
    for (const list of Object.values(captured)) list.length = 0;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-quota-resume-"));
    lastClaude = null as never;

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  it("passes the started manager to the restart follow-up, the stopped-jobs note and the consult result", async () => {
    expect(captured.started).toHaveLength(1);
    const manager = captured.started[0];

    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Do the work" });
    const turn = await waitForClaude(() => lastClaude);
    turn.initSession("turn-one");

    const deps = captured.executor[0] as SystemTurnDeps;
    await deps.runRequestedRestart?.({ sessionId: client.sessionId } as RequestedRestartTurn);
    await deps.reportStoppedBackgroundJobs?.({ sessionId: client.sessionId, jobs: ["npm run build"], mayWake: true });
    const spawn = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/spawn`,
      payload: {
        agentId: "codex",
        serviceId: "openai",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        prompt: "review this",
        depth: 0,
      },
    });
    expect(spawn.statusCode).toBe(200);

    expect(captured.restart.at(-1)?.quotaContinuation).toBe(manager);
    expect(captured.jobs.at(-1)?.quotaContinuation).toBe(manager);
    expect(captured.consult.at(-1)?.quotaContinuation).toBe(manager);

    turn.finish("turn-one");
  });
});
