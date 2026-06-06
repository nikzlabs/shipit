/**
 * Integration tests for the `/compact` interception (docs/179).
 *
 * `/compact` is an agent-agnostic ShipIt command, not a literal prompt. When the
 * active agent advertises `supportsCompaction`, the send-message handler routes
 * it to the agent's compaction trigger instead of the model:
 *   - no live turn → a fresh spawn runs with `compact: true` (the prompt is
 *     `/compact`, which Claude's CLI honors as a slash command);
 *   - a live in-flight turn → `agent.compact()` on the resident process, plus a
 *     transient "Compacting…" indicator.
 *
 * These pin the routing contract using `FakeClaudeProcess`, which records both
 * the `compact` run-param and any `compact()` call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

type AnyMsg = any;

describe("Integration: /compact interception (docs/179)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-compaction-"));
    credentialStore = createTestCredentialStore(tmpDir);

    const sessionManager = new SessionManager(dbManager);
    const chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("spawns a compaction turn (compact run-param + /compact prompt) when no turn is live", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "/compact" });
    const claude = await waitForClaude(() => lastClaude);

    // Routed as a compaction request: the spawn carries compact:true and the
    // CLI receives the `/compact` slash command as its prompt.
    expect(claude.lastCompact).toBe(true);
    expect(claude.lastPrompt).toBe("/compact");

    client.close();
  });

  it("triggers agent.compact() and a transient indicator when a turn is live", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First turn — leave it running (the fake doesn't auto-finish).
    client.send({ type: "send_message", text: "Hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("compact-session-1");

    // Mid-turn `/compact` → compaction trigger on the resident process, not a
    // queued literal message.
    client.send({ type: "send_message", text: "/compact" });

    const status = await drainUntil(
      client,
      (m) => m.type === "compaction_status" && m.active === true,
    );
    expect(status).toMatchObject({ type: "compaction_status", active: true, trigger: "manual" });
    expect(claude.compactCalled).toBe(true);

    client.close();
  });
});
