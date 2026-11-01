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
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitFor,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const executorDeps = vi.hoisted(() => [] as unknown[]);
const executorRunners = vi.hoisted(() => [] as ({ running: boolean; agentBusy: boolean } | null)[]);

vi.mock("../turn-executor.js", async () => {
  // eslint-disable-next-line no-restricted-syntax -- vitest's blessed form
  const real = await vi.importActual<typeof import("../turn-executor.js")>("../turn-executor.js");
  const executeAgentTurn: typeof real.executeAgentTurn = (runner, deps, agent, input) => {
    executorDeps.push(deps);
    executorRunners.push(runner);
    return real.executeAgentTurn(runner, deps, agent, input);
  };
  return { ...real, executeAgentTurn };
});

/**
 * A message from the composer builds its executor in `runAgentWithMessage`
 * (`ws-handlers/agent-execution.ts`), not in the runner's dispatch, and its resident CLI
 * starts turns of its own like any other. The unit tests inject the stand-down hooks, so
 * they stay green when this site does not pass them (docs/140-live-steering Phase 6.13).
 */
describe("Integration: a composer turn can stand down into a continuation", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as never;

  beforeEach(async () => {
    executorDeps.length = 0;
    executorRunners.length = 0;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-stand-down-"));
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

  it("hands the executor stand-down hooks that start the continuation turn", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Do the work" });
    const first = await waitForClaude(() => lastClaude);
    first.initSession("turn-one");

    const deps = executorDeps[0] as SystemTurnDeps;
    const runner = executorRunners[0];
    expect(deps.recordStandDown).toBeTypeOf("function");

    // As the executor does: the stand-down is recorded at the stopped turn's result, and the
    // continuation starts once that turn's teardown is over.
    first.finish("turn-one");
    await waitFor(() => !runner?.running && !runner?.agentBusy, "the first turn's teardown");
    deps.recordStandDown?.({ sessionId: client.sessionId, agentId: "claude", cause: "auth" });
    await deps.continueAfterStandDown?.(client.sessionId);
    const continuation = await waitForClaude(() => lastClaude, first);

    const told = fs.readFileSync(
      new URL("../prompts/auth-continuation-wake.md", import.meta.url),
      "utf8",
    ).trim();
    expect(continuation.lastPrompt).toContain(told);

    continuation.initSession("turn-one");
    continuation.finish("turn-one");
  });
});
