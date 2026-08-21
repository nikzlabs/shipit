/**
 * Integration test for planning#309 / docs/249 — a consult card stranded `pending`
 * by an orchestrator restart is finished at the next boot.
 *
 * The unit tests in `consult-card-reconcile.test.ts` cover the sweep's policy.
 * The seam THEY cannot cover is the one that actually broke: whether the sweep
 * is wired into boot at all. So this test seeds the database exactly as a killed
 * orchestrator would leave it, boots a real `buildApp`, and asks the same
 * question `shipit agent result` asks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import { getSubAgentResult } from "../services/sub-agent.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

describe("Integration: consult cards stranded by an orchestrator restart (planning#309)", () => {
  let app: FastifyInstance | undefined;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;

  beforeEach(() => {
    dbManager = createTestDatabaseManager();
    chatHistoryManager = new ChatHistoryManager(dbManager);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-consult-reconcile-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const boot = async () => {
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  };

  const pendingCard = (spawnId: string) => ({
    role: "assistant" as const,
    text: "",
    subAgentConsult: {
      cardId: `card-${spawnId}`,
      spawnId,
      subAgentId: "codex" as const,
      status: "pending" as const,
      createdAt: "2026-08-04T09:00:00.000Z",
    },
  });

  it("boot finishes a card the previous process left pending, and `agent result` reports it terminal", async () => {
    // What a killed orchestrator leaves behind: a card created at spawn time
    // whose only writer — the in-memory `runSubAgent` promise — is gone.
    chatHistoryManager.append("sess-1", { role: "user", text: "review this with codex" });
    chatHistoryManager.append("sess-1", pendingCard("spawn-a"));

    await boot();

    // The read `shipit agent result` performs. Before this fix it answered
    // `pending` forever (exit 4, and `--wait` burning its whole timeout).
    const card = getSubAgentResult({ chatHistoryManager }, "sess-1");
    expect(card.status).toBe("cancelled");
    expect(card.statusDetail).toContain("ShipIt restarted");
    expect(card.spawnId).toBe("spawn-a");
  });

  it("boot leaves the card able to survive an adopted turn's row rebuild", async () => {
    // The foreground-consult shape: a blocking `shipit agent run` means the card
    // is still an `in_progress=1` row when the orchestrator dies. docs/240 then
    // adopts that turn, and its eventual `agent_result` calls `replaceInProgress`,
    // which deletes EVERY in-progress row in the session and rebuilds from the
    // fresh runner's empty `recordedCards`.
    //
    // So terminalizing the card is not sufficient on its own — a card that boot
    // marked `cancelled` but left in-progress is deleted outright a moment later,
    // and `shipit agent result` answers "No sub-agent runs in this session yet".
    // This asserts the property that actually protects it end-to-end: after a
    // REAL boot, the row no longer participates in the rebuild.
    chatHistoryManager.replaceInProgress("sess-1", [
      { role: "assistant", text: "asking codex", inProgress: true },
      { ...pendingCard("spawn-a"), inProgress: true },
    ]);

    await boot();

    // …now the adopted turn finalizes and rebuilds its own rows.
    chatHistoryManager.replaceInProgress("sess-1", [
      { role: "assistant", text: "the adopted turn", inProgress: true },
    ]);

    const card = getSubAgentResult({ chatHistoryManager }, "sess-1");
    expect(card.status).toBe("cancelled");
    expect(card.spawnId).toBe("spawn-a");
  });

  it("leaves a finished consult's output untouched across the same boot", async () => {
    chatHistoryManager.append("sess-1", {
      role: "assistant",
      text: "",
      subAgentConsult: {
        ...pendingCard("spawn-done").subAgentConsult,
        status: "success",
        durationMs: 900_000,
        outputMarkdown: "## Findings\n\n- a real report",
      },
    });

    await boot();

    const card = getSubAgentResult({ chatHistoryManager }, "sess-1");
    expect(card).toMatchObject({
      status: "success",
      durationMs: 900_000,
      outputMarkdown: "## Findings\n\n- a real report",
    });
    expect(card.statusDetail).toBeUndefined();
  });
});
