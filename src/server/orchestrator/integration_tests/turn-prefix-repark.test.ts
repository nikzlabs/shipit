import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { CredentialStore } from "../credential-store.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * planning#609 — the prefix entries that are one-shot TAKES, performed at composition and
 * therefore spent before the prompt is submitted: the pending agent notice, the branch the
 * pre-turn reset already moved, and a role's standing brief.
 *
 * A turn can end without the prompt reaching any agent, and ShipIt's own error text for
 * that says "send this message again" — so the user walks straight back into the hole the
 * dead turn dug. The takes belong to the agent that reads them, not to the turn that asked.
 *
 * The interactive composition site (`ws-handlers/agent-execution.ts`) had no repark at all,
 * and `dispatched-turn.ts` latched "delivered" before the executor, so it covered only a
 * failure in the pre-executor setup. Both now hand the takes to `executeAgentTurn`, which
 * is the one that knows whether the prompt was ever submitted.
 */
describe("Integration: one-shot prefix takes survive a turn that never reaches an agent", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as never;
  /** The spawn this attempt's process makes fails, so the prompt is never submitted. */
  let failNextRun = false;
  /** Make the LAST of the three takes throw, so composition itself dies. */
  let failRoleWrite = false;
  let roleWriteAttempted = false;

  const NOTICE = "[System] Your branch was reset to origin/main after PR #482 merged.";
  const ROLE_PROMPT = "Review only. Never edit a file in this repository.";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-prefix-repark-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);
    lastClaude = null as never;
    failNextRun = false;
    failRoleWrite = false;
    roleWriteAttempted = false;
    const setOriginRoleName = sessionManager.setOriginRoleName.bind(sessionManager);
    sessionManager.setOriginRoleName = (id: string, name: string) => {
      roleWriteAttempted = true;
      if (failRoleWrite) throw new Error("database connection is closed");
      setOriginRoleName(id, name);
    };

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        if (failNextRun) {
          failNextRun = false;
          // The prompt was composed and handed over, and the spawn then failed — so the
          // takes are spent and no agent has read them. `executeAgentTurn` catches this
          // and reports it as an adapter error, exactly as a refused route is reported.
          agent.run = (params: { prompt: string }) => {
            agent.runCalled = true;
            agent.lastPrompt = params.prompt;
            throw new Error("The agent exited without running. Please send your message again.");
          };
        }
        lastClaude = agent;
        return agent as never;
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

  const settled = (sessionId: string) => waitFor(() => {
    const runner = app.runnerRegistry.get(sessionId);
    return runner !== undefined && !runner.running && !runner.agentBusy;
  }, "the turn settled");

  const seedRole = (sessionId: string): void => {
    credentialStore.setRole("auditor", {
      name: "auditor",
      prompt: ROLE_PROMPT,
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
      },
    });
    sessionManager.setRoleName(sessionId, "auditor");
  };

  it("hands the notice and the role brief to the resend, not to the turn that died", async () => {
    const client = await TestClient.connect(port);
    const sessionId = client.sessionId;
    seedRole(sessionId);
    sessionManager.setPendingAgentNotice(sessionId, NOTICE);

    // The first attempt cannot start its process, so composition's takes were spent on an
    // agent that read nothing. This is the shape of every failure inside the executor —
    // `prepareAgentEnv` refusing a spent account is the one the report came from.
    failNextRun = true;
    client.send({ type: "send_message", text: "Now add the rate limiter" });
    const died = await waitForClaude(() => lastClaude);
    await settled(sessionId);
    // Composition spent both takes on this attempt, and nothing ever read them.
    expect(died.lastPrompt).toContain(NOTICE);
    expect(died.lastPrompt).toContain(ROLE_PROMPT);

    // Both takes are back in the store, where the next composition looks for them.
    expect(sessionManager.get(sessionId)?.originRoleName).toBeUndefined();

    client.send({ type: "send_message", text: "Now add the rate limiter" });
    const resend = await waitForClaude(() => lastClaude, died);
    await waitFor(() => resend.runCalled, "the resend reached an agent");

    expect(resend.lastPrompt).toContain(NOTICE);
    expect(resend.lastPrompt).toContain(ROLE_PROMPT);

    resend.initSession("turn-one");
    resend.finish("turn-one");
    await settled(sessionId);
    client.close();
  }, 30_000);

  it("hands back the takes composition already made when composition itself throws", async () => {
    const client = await TestClient.connect(port);
    const sessionId = client.sessionId;
    seedRole(sessionId);
    sessionManager.setPendingAgentNotice(sessionId, NOTICE);

    // The role take is the LAST of the three, and it writes to SQLite — which shutdown can
    // close under a turn. A throw there is a throw inside composition: the notice and the
    // reset prefix are already spent, no executor exists yet, and none ever will, so
    // nothing downstream of composition can put them back.
    failRoleWrite = true;

    client.send({ type: "send_message", text: "Now add the rate limiter" });
    // Wait for the throw FIRST. Polling the notice straight away would read the one still
    // sitting there unconsumed and call it restored — a check that cannot fail.
    await waitFor(() => roleWriteAttempted, "composition reached the role take and threw");

    let restored: string | undefined;
    await waitFor(() => {
      restored = sessionManager.consumePendingAgentNotice(sessionId);
      return restored !== undefined;
    }, "the notice was handed back");

    expect(restored).toBe(NOTICE);
    // No agent ran, so nothing downstream of composition could have put it back.
    expect(lastClaude?.runCalled ?? false).toBe(false);
    client.close();
  }, 30_000);

  it("leaves the takes spent once an agent has read them", async () => {
    const client = await TestClient.connect(port);
    const sessionId = client.sessionId;
    seedRole(sessionId);
    sessionManager.setPendingAgentNotice(sessionId, NOTICE);

    client.send({ type: "send_message", text: "Add the billing routes" });
    const first = await waitForClaude(() => lastClaude);
    expect(first.lastPrompt).toContain(NOTICE);
    expect(first.lastPrompt).toContain(ROLE_PROMPT);
    first.initSession("turn-one");
    first.finish("turn-one");
    await settled(sessionId);

    // A repark keyed on the turn's outcome rather than on whether the prompt was submitted
    // would put both back here, and the agent would be told twice.
    expect(sessionManager.get(sessionId)?.originRoleName).toBe("auditor");

    client.send({ type: "send_message", text: "And the webhook route" });
    const second = await waitForClaude(() => lastClaude, first);
    expect(second.lastPrompt).not.toContain(NOTICE);
    expect(second.lastPrompt).not.toContain(ROLE_PROMPT);

    second.initSession("turn-one");
    second.finish("turn-one");
    await settled(sessionId);
    client.close();
  }, 30_000);
});
