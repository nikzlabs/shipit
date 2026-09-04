import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { WsActionChecklistCard } from "../../shared/types.js";
import { MAX_PAYLOAD_LEN } from "../../shared/propose-actions-validation.js";

/**
 * docs/207 — the `propose_actions` route is the AUTHORITATIVE validator, and
 * that is the half no other test covered. The pure validator has unit tests and
 * the session-side tool has a fail-fast test, but both would stay green if the
 * route stopped validating: a request straight to this container-accessible
 * endpoint (the tool is not the only way in) could then persist a malformed
 * card. So this drives the real HTTP surface.
 */
describe("Integration: propose-actions route", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propose-actions-route-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/propose-actions`, payload });

  it("emits a card for a well-formed proposal", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    const res = await post({
      title: "Optional follow-ups",
      actions: [{ id: "a1", label: "Open a PR", payload: "Open a PR for this change." }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, count: 1 });

    const card = (await client.receiveType("action_checklist_card")) as WsActionChecklistCard;
    expect(card.card.actions).toHaveLength(1);
    expect(card.card.actions[0]?.label).toBe("Open a PR");
  });

  it("rejects an over-long payload at the route, naming the size and the cap", async () => {
    const res = await post({
      actions: [{ id: "a1", label: "Open a PR", payload: "x".repeat(MAX_PAYLOAD_LEN + 1) }],
    });

    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain(`${MAX_PAYLOAD_LEN + 1} chars`);
    expect(error).toContain(String(MAX_PAYLOAD_LEN));
  });

  it("rejects duplicate ids and an empty actions array at the route", async () => {
    const dup = await post({
      actions: [
        { id: "same", label: "A", payload: "a" },
        { id: "same", label: "B", payload: "b" },
      ],
    });
    expect(dup.statusCode).toBe(400);
    expect((dup.json() as { error: string }).error).toMatch(/Duplicate action id/);

    const empty = await post({ actions: [] });
    expect(empty.statusCode).toBe(400);
  });
});
