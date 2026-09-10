import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Avoid spawning npm.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, getGitIdentity, setGitIdentity } from "../git-config.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { readSessionAccountMarker, writeSessionAccountMarker } from "../session-credentials.js";

describe("Integration: Phase 2 HTTP mutation endpoints", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let credentialStore: CredentialStore;
  let chatHistoryManager: ChatHistoryManager;
  let savedOpenAIKey: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-mutations-"));

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore,
      credentialsDir: tmpDir,
      chatHistoryManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
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
    if (savedOpenAIKey !== undefined) {
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  async function createSession(id: string, title: string): Promise<string> {
    const sessionDir = path.join(tmpDir, "sessions", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track(id, title, sessionDir);
    const git = new GitManager(sessionDir);
    await git.init();
    fs.writeFileSync(path.join(sessionDir, "init.txt"), "init");
    await git.autoCommit("initial commit");
    return sessionDir;
  }

  describe("PATCH /api/sessions/:id (rename)", () => {
    it("renames a session", async () => {
      await createSession("s1", "Old Title");
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/s1",
        payload: { title: "New Title" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.id).toBe("s1");
      expect(body.session.title).toBe("New Title");
    });

    it("returns 400 for empty title", async () => {
      await createSession("s1", "Title");
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/s1",
        payload: { title: "   " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/sessions/nonexistent",
        payload: { title: "Title" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/rename (agent)", () => {
    it("renames the session and records the agent as the source", async () => {
      await createSession("s1", "Fix the flaky test");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/rename",
        payload: { title: "Harden the CI pipeline" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        sessionId: "s1",
        previousTitle: "Fix the flaky test",
        title: "Harden the CI pipeline",
      });
      const session = sessionManager.get("s1");
      expect(session?.title).toBe("Harden the CI pipeline");
      expect(session?.titleSource).toBe("agent");
    });

    it("refuses with 409 once the user has renamed by hand, and changes nothing", async () => {
      await createSession("s1", "Auto name");
      await app.inject({ method: "PATCH", url: "/api/sessions/s1", payload: { title: "My name" } });
      expect(sessionManager.get("s1")?.titleSource).toBe("user");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/rename",
        payload: { title: "Agent name" },
      });
      expect(res.statusCode).toBe(409);
      expect(sessionManager.get("s1")?.title).toBe("My name");
    });

    it("lets the user rename over an agent title, and that then locks it", async () => {
      await createSession("s1", "Auto name");
      await app.inject({ method: "POST", url: "/api/sessions/s1/rename", payload: { title: "Agent name" } });

      const patch = await app.inject({
        method: "PATCH",
        url: "/api/sessions/s1",
        payload: { title: "User wins" },
      });
      expect(patch.statusCode).toBe(200);
      expect(sessionManager.get("s1")?.titleSource).toBe("user");

      const retry = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/rename",
        payload: { title: "Agent tries again" },
      });
      expect(retry.statusCode).toBe(409);
      expect(sessionManager.get("s1")?.title).toBe("User wins");
    });

    it("rejects an over-length title rather than truncating it", async () => {
      await createSession("s1", "Old");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/rename",
        payload: { title: "x".repeat(61) },
      });
      expect(res.statusCode).toBe(400);
      expect(sessionManager.get("s1")?.title).toBe("Old");
    });

    it("returns 400 for a missing title and 404 for an unknown session", async () => {
      await createSession("s1", "Old");
      const noTitle = await app.inject({ method: "POST", url: "/api/sessions/s1/rename", payload: {} });
      expect(noTitle.statusCode).toBe(400);

      const missing = await app.inject({
        method: "POST",
        url: "/api/sessions/nope/rename",
        payload: { title: "T" },
      });
      expect(missing.statusCode).toBe(404);
    });

    it("leaves the session's branch untouched (req 10)", async () => {
      await createSession("s1", "Old");
      sessionManager.setBranch("s1", "shipit/keep-me-abc123");

      await app.inject({ method: "POST", url: "/api/sessions/s1/rename", payload: { title: "Different work" } });

      expect(sessionManager.get("s1")?.branch).toBe("shipit/keep-me-abc123");
    });
  });

  describe("docs/110: POST/DELETE /api/sessions/:id/pin", () => {
    it("pins then unpins a session, returning the updated session", async () => {
      await createSession("s1", "Session 1");

      const pinRes = await app.inject({ method: "POST", url: "/api/sessions/s1/pin" });
      expect(pinRes.statusCode).toBe(200);
      expect(pinRes.json().session.pinnedAt).toBeTruthy();
      expect(sessionManager.get("s1")?.pinnedAt).toBeTruthy();

      const unpinRes = await app.inject({ method: "DELETE", url: "/api/sessions/s1/pin" });
      expect(unpinRes.statusCode).toBe(200);
      expect(unpinRes.json().session.pinnedAt).toBeUndefined();
      expect(sessionManager.get("s1")?.pinnedAt).toBeUndefined();
    });

    it("returns 404 for a non-existent session", async () => {
      const res = await app.inject({ method: "POST", url: "/api/sessions/nope/pin" });
      expect(res.statusCode).toBe(404);
    });

    it("scopes pins per repo — a pin on one repo's session never touches another's", async () => {
      await createSession("a1", "Repo A session");
      await createSession("b1", "Repo B session");
      sessionManager.setRemoteUrl("a1", "https://github.com/o/a.git");
      sessionManager.setRemoteUrl("b1", "https://github.com/o/b.git");

      await app.inject({ method: "POST", url: "/api/sessions/a1/pin" });

      expect(sessionManager.get("a1")?.pinnedAt).toBeTruthy();
      expect(sessionManager.get("b1")?.pinnedAt).toBeUndefined();
    });

    it("POST /api/sessions/pin-order reorders a repo's pins", async () => {
      const repo = "https://github.com/o/a.git";
      for (const id of ["p1", "p2", "p3"]) {
        await createSession(id, id);
        sessionManager.setRemoteUrl(id, repo);
        await app.inject({ method: "POST", url: `/api/sessions/${id}/pin` });
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/pin-order",
        payload: { remoteUrl: repo, ids: ["p3", "p1", "p2"] },
      });
      expect(res.statusCode).toBe(200);

      const order = sessionManager.list()
        .filter((s) => s.pinnedAt)
        .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""))
        .map((s) => s.id);
      expect(order).toEqual(["p3", "p1", "p2"]);
    });

    it("POST /api/sessions/pin-order rejects a non-array ids payload", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/pin-order",
        payload: { remoteUrl: "https://github.com/o/a.git", ids: "nope" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("docs/241: PUT /api/sessions/:id/keep-preview-running", () => {
    it("persists, activates, broadcasts through the canonical list, and disables without stopping", async () => {
      await createSession("keep-1", "Keep me");
      const enabled = await app.inject({
        method: "PUT",
        url: "/api/sessions/keep-1/keep-preview-running",
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(sessionManager.get("keep-1")?.keepPreviewRunning).toBe(true);
      expect(app.runnerRegistry.get("keep-1")).toBeDefined();

      const disabled = await app.inject({
        method: "PUT",
        url: "/api/sessions/keep-1/keep-preview-running",
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(sessionManager.get("keep-1")?.keepPreviewRunning).toBeUndefined();
      expect(app.runnerRegistry.get("keep-1")).toBeDefined();
    });

    it("rejects invalid bodies and missing sessions", async () => {
      await createSession("keep-2", "Keep me");
      const invalid = await app.inject({
        method: "PUT", url: "/api/sessions/keep-2/keep-preview-running", payload: { enabled: "yes" },
      });
      expect(invalid.statusCode).toBe(400);
      const missing = await app.inject({
        method: "PUT", url: "/api/sessions/nope/keep-preview-running", payload: { enabled: true },
      });
      expect(missing.statusCode).toBe(404);
    });

    it("enforces the default capacity before mutating the second session", async () => {
      await createSession("keep-a", "A");
      await createSession("keep-b", "B");
      await app.inject({
        method: "PUT", url: "/api/sessions/keep-a/keep-preview-running", payload: { enabled: true },
      });
      const overflow = await app.inject({
        method: "PUT", url: "/api/sessions/keep-b/keep-preview-running", payload: { enabled: true },
      });
      expect(overflow.statusCode).toBe(409);
      expect(overflow.json()).toMatchObject({ error: expect.stringContaining('"A"') });
      expect(sessionManager.get("keep-b")?.keepPreviewRunning).toBeUndefined();
    });
  });

  describe("DELETE /api/sessions/:id (archive)", () => {
    it("archives a session and returns updated list", async () => {
      await createSession("s1", "Session 1");
      await createSession("s2", "Session 2");
      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/s1",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.sessions.map((s: any) => s.id);
      expect(ids).not.toContain("s1");
      expect(ids).toContain("s2");
    });
  });

  describe("POST /api/sessions/:id/unarchive", () => {
    it("unarchives a session and returns updated list", async () => {
      await createSession("s1", "Session 1");
      await createSession("s2", "Session 2");
      const archiveRes = await app.inject({
        method: "DELETE",
        url: "/api/sessions/s1",
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(archiveRes.json().sessions.map((s: any) => s.id)).not.toContain("s1");

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/unarchive",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.id).toBe("s1");
      expect(body.session.archived).toBeUndefined();
      const ids = body.sessions.map((s: any) => s.id);
      expect(ids).toContain("s1");
      expect(ids).toContain("s2");
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/unarchive",
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for session that is not archived", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/unarchive",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/git/rollback", () => {
    it("rolls back to a previous commit", async () => {
      const dir = await createSession("s1", "Session 1");
      fs.writeFileSync(path.join(dir, "file2.txt"), "content");
      const git = new GitManager(dir);
      await git.autoCommit("second commit");

      const logRes = await app.inject({ method: "GET", url: "/api/sessions/s1/git/log" });
      const commits = logRes.json().commits;
      const firstHash = commits[commits.length - 1].hash;

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/rollback",
        payload: { commitHash: firstHash },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().commitHash).toBe(firstHash);
    });

    it("returns 404 for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/git/rollback",
        payload: { commitHash: "abc" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/settings/git-identity", () => {
    it("sets git identity", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Test User", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe("Test User");
      expect(body.email).toBe("test@example.com");
    });

    it("persists identity to global git config", async () => {
      await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Global User", email: "global@example.com" },
      });
      expect(getGitIdentity()).toEqual({ name: "Global User", email: "global@example.com" });
    });

    it("returns 400 for empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty email", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "Test", email: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for whitespace-only name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/git-identity",
        payload: { name: "   ", email: "test@example.com" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /api/settings", () => {
    it("saves system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Be helpful" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.systemPrompt).toBe("Be helpful");
    });

    it("persists system prompt to disk", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Always use TypeScript." },
      });
      const filePath = path.join(tmpDir, ".shipit", "system-prompt.md");
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, "utf-8")).toBe("Always use TypeScript.\n");
    });

    it("round-trips system prompt (save then read)", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Use Tailwind CSS." },
      });
      const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
      expect(res.json().settings.systemPrompt).toBe("Use Tailwind CSS.");
    });

    it("empty system prompt deletes the file", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "Something" },
      });
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemPrompt).toBe("");
      expect(fs.existsSync(path.join(tmpDir, ".shipit", "system-prompt.md"))).toBe(false);
    });

    it("trims whitespace from system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "  Use strict mode.  \n" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().systemPrompt).toBe("Use strict mode.");
    });

    it("saves git identity via settings", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "New Name", email: "new@test.com" } },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.gitIdentity.name).toBe("New Name");
      expect(body.gitIdentity.email).toBe("new@test.com");
    });

    it("persists git identity to global git config via settings", async () => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "Global User", email: "global@test.com" } },
      });
      expect(getGitIdentity()).toEqual({ name: "Global User", email: "global@test.com" });
    });

    it("returns 400 for empty git name in settings", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { gitIdentity: { name: "", email: "a@b.com" } },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for too-long system prompt", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { systemPrompt: "x".repeat(50_001) },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/settings/agent", () => {
    it("returns 400 for unknown agent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/agent",
        payload: { agentId: "nonexistent" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("provider account settings endpoints", () => {
    it("creates, renames, reorders, and disconnects provider accounts", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "claude", label: "Work Anthropic" },
      });
      expect(created.statusCode).toBe(200);
      const createdBody = created.json() as { account: { id: string; label: string; isPrimary: boolean }; accounts: { serviceId: string }[] };
      expect(createdBody.account.label).toBe("Work Anthropic");
      expect(createdBody.account.isPrimary).toBe(true);
      expect(createdBody.accounts.filter((account) => account.serviceId === "anthropic")).toHaveLength(1);

      const accountId = createdBody.account.id;
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/provider-accounts/claude/${accountId}`,
        payload: { label: "Primary Anthropic" },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as { account: { label: string } }).account.label).toBe("Primary Anthropic");

      const second = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "claude", label: "Backup Anthropic" },
      });
      const secondId = (second.json() as { account: { id: string } }).account.id;

      const primary = await app.inject({
        method: "PUT",
        url: "/api/provider-accounts/claude/order",
        payload: { accountIds: [secondId, accountId] },
      });
      expect(primary.statusCode).toBe(200);
      const primaryAccounts = (primary.json() as { accounts: { id: string; isPrimary: boolean }[] }).accounts;
      expect(primaryAccounts.find((account) => account.id === secondId)?.isPrimary).toBe(true);
      expect(primaryAccounts.find((account) => account.id === accountId)?.isPrimary).toBe(false);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/provider-accounts/claude/${accountId}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect((deleted.json() as { accounts: { serviceId: string; id: string }[] }).accounts
        .filter((account) => account.serviceId === "anthropic")
        .map((account) => account.id)).toEqual([secondId]);
    });

    it("disconnects the last account over HTTP: {accounts} only, no stranded/switched reporting (docs/260-turn-level-account-routing req 3)", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "codex", label: "Team ChatGPT" },
      });
      const accountId = (created.json() as { account: { id: string } }).account.id;
      await createSession("codex-session", "Codex session");
      sessionManager.setAgentId("codex-session", "codex");
      const tokenPath = path.join(tmpDir, "sessions", "codex-session", ".codex", "auth.json");
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, '{"accessToken":"live"}');
      writeSessionAccountMarker(tmpDir, "codex-session", "codex", accountId);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/provider-accounts/codex/${accountId}`,
      });

      expect(deleted.statusCode).toBe(200);
      const body = deleted.json() as Record<string, unknown> & { accounts: { serviceId: string; id: string }[] };
      expect(body.accounts.filter((account) => account.serviceId === "openai")).toEqual([]);
      // Check the ID too: a renamed service field can make the filter pass vacuously.
      expect(body.accounts.map((account) => account.id)).not.toContain(accountId);
      expect(body).not.toHaveProperty("switchedSessionIds");
      expect(body).not.toHaveProperty("strandedSessionIds");
      expect(fs.existsSync(tokenPath)).toBe(false);
      expect(readSessionAccountMarker(tmpDir, "codex-session").codex).toBeUndefined();
    });

    it("refuses to disconnect while a live process on the account is busy, and allows it once idle (docs/260-turn-level-account-routing req 13)", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "codex", label: "Team ChatGPT" },
      });
      const accountId = (created.json() as { account: { id: string } }).account.id;
      const session = sessionManager.track("running-session", "Running session", path.join(tmpDir, "session"));
      sessionManager.setAgentId(session.id, "codex");
      const runner = app.runnerRegistry.getOrCreate(session.id, path.join(tmpDir, "session"), "codex");
      runner.residentRoute = { kind: "account", id: accountId };
      runner.running = true;

      const blocked = await app.inject({
        method: "DELETE",
        url: `/api/provider-accounts/codex/${accountId}`,
      });

      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { error: string }).error).toMatch(/"Running session"/);
      expect((blocked.json() as { error: string }).error).toMatch(/wait/i);

      runner.running = false;
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/provider-accounts/codex/${accountId}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect((deleted.json() as { accounts: { serviceId: string }[] }).accounts
        .filter((account) => account.serviceId === "openai")).toEqual([]);
    });

    it("PUT /order changes the order returned by the reorder response AND by GET", async () => {
      const mk = async (label: string): Promise<string> => {
        const res = await app.inject({
          method: "POST", url: "/api/provider-accounts", payload: { provider: "claude", label },
        });
        return (res.json() as { account: { id: string } }).account.id;
      };
      const a = await mk("Account A");
      const b = await mk("Account B");
      const c = await mk("Account C");

      const claudeIds = (payload: unknown): string[] =>
        (payload as { accounts: { id: string; serviceId: string }[] }).accounts
          .filter((row) => row.serviceId === "anthropic")
          .map((row) => row.id);

      expect(claudeIds((await app.inject({ method: "GET", url: "/api/provider-accounts" })).json()))
        .toEqual([a, b, c]);

      const reordered = await app.inject({
        method: "PUT",
        url: "/api/provider-accounts/claude/order",
        payload: { accountIds: [c, a, b] },
      });
      expect(reordered.statusCode).toBe(200);
      expect(claudeIds(reordered.json())).toEqual([c, a, b]);
      expect(claudeIds((await app.inject({ method: "GET", url: "/api/provider-accounts" })).json()))
        .toEqual([c, a, b]);
      const rows = ((await app.inject({ method: "GET", url: "/api/provider-accounts" })).json() as
        { accounts: { id: string; isPrimary?: boolean }[] }).accounts;
      expect(rows.find((row) => row.id === c)?.isPrimary).toBe(true);
    });

    it("starts, feeds a code to, and cancels an account-scoped login (docs/150)", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "claude", label: "Work Anthropic" },
      });
      const accountId = (created.json() as { account: { id: string } }).account.id;

      const login = await app.inject({
        method: "POST",
        url: `/api/provider-accounts/claude/${accountId}/login`,
      });
      expect(login.statusCode).toBe(202);
      expect((login.json() as { account: { status: string } }).account.status).toBe("authenticating");

      const listed = await app.inject({ method: "GET", url: "/api/provider-accounts" });
      const row = (listed.json() as { accounts: { id: string; status: string }[] }).accounts
        .find((a) => a.id === accountId);
      expect(row?.status).toBe("authenticating");

      const code = await app.inject({
        method: "POST",
        url: `/api/provider-accounts/claude/${accountId}/login/code`,
        payload: { code: "abc-123" },
      });
      expect(code.statusCode).toBe(200);

      // The auth stub reports configured, so cancellation restores "ready".
      const cancelled = await app.inject({
        method: "POST",
        url: `/api/provider-accounts/claude/${accountId}/login/cancel`,
      });
      expect(cancelled.statusCode).toBe(200);
      expect((cancelled.json() as { account: { status: string } }).account.status).toBe("ready");
    });

    it("refuses a second concurrent sign-in with 409, and frees up after cancel", async () => {
      const mk = async (label: string): Promise<string> => {
        const res = await app.inject({
          method: "POST", url: "/api/provider-accounts", payload: { provider: "claude", label },
        });
        return (res.json() as { account: { id: string } }).account.id;
      };
      const first = await mk("First Anthropic");
      const second = await mk("Second Anthropic");

      expect((await app.inject({
        method: "POST", url: `/api/provider-accounts/claude/${first}/login`,
      })).statusCode).toBe(202);

      const blocked = await app.inject({
        method: "POST", url: `/api/provider-accounts/claude/${second}/login`,
      });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { error: string }).error).toContain("First Anthropic");

      expect((await app.inject({
        method: "POST",
        url: `/api/provider-accounts/claude/${second}/login/code`,
        payload: { code: "abc-123" },
      })).statusCode).toBe(409);

      await app.inject({ method: "POST", url: `/api/provider-accounts/claude/${first}/login/cancel` });
      expect((await app.inject({
        method: "POST", url: `/api/provider-accounts/claude/${second}/login`,
      })).statusCode).toBe(202);
    });

    it("rejects an empty login code and an unknown account (docs/150)", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/provider-accounts",
        payload: { provider: "claude", label: "Work Anthropic" },
      });
      const accountId = (created.json() as { account: { id: string } }).account.id;

      const emptyCode = await app.inject({
        method: "POST",
        url: `/api/provider-accounts/claude/${accountId}/login/code`,
        payload: { code: "   " },
      });
      expect(emptyCode.statusCode).toBe(400);

      const unknown = await app.inject({
        method: "POST",
        url: "/api/provider-accounts/claude/acct_does-not-exist/login",
      });
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe("POST /api/auth/api-key", () => {
    it("sets a valid API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test123" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it("returns 400 for invalid key format", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "not-a-valid-key" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/auth/api-key", () => {
    it("signs out: clears the key and returns the refreshed agent list", async () => {
      await app.inject({
        method: "POST",
        url: "/api/auth/api-key",
        payload: { key: "sk-ant-test123" },
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/auth/api-key",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.agents)).toBe(true);
      const claude = body.agents.find((a: { id: string }) => a.id === "claude");
      expect(claude?.hasRunnableModels).toBe(false);
    });

    it("refuses while a live process on a connected account is mid-turn, and allows it once idle (docs/260-turn-level-account-routing req 13)", async () => {
      // The busy-process guard only checks connected accounts.
      const now = Date.now();
      credentialStore.upsertCredentialRoute({
        id: "acct_live", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Live", isPrimary: true,
        priority: 0, status: "ready", createdAt: now, updatedAt: now,
      });
      await createSession("signout-1", "Mid-turn session");
      sessionManager.setAgentId("signout-1", "claude");
      const runner = app.runnerRegistry.getOrCreate("signout-1", "/tmp/signout-1", "claude");
      runner.residentRoute = { kind: "account", id: "acct_live" };
      runner.running = true;

      const blocked = await app.inject({ method: "DELETE", url: "/api/auth/api-key" });
      expect(blocked.statusCode).toBe(409);
      expect((blocked.json() as { error: string }).error).toMatch(/mid-turn/i);

      runner.running = false;
      expect((await app.inject({ method: "DELETE", url: "/api/auth/api-key" })).statusCode).toBe(200);
    });

    it("still signs out with an idle session holding the account's copy, revoking it by marker", async () => {
      const now = Date.now();
      credentialStore.upsertCredentialRoute({
        id: "acct_gone", serviceId: "anthropic", billingMode: "sub", via: "account", label: "Gone", isPrimary: true,
        priority: 0, status: "ready", createdAt: now, updatedAt: now,
      });
      await createSession("signout-2", "Idle session");
      sessionManager.setAgentId("signout-2", "claude");
      const sessionToken = path.join(tmpDir, "sessions", "signout-2", ".claude", ".credentials.json");
      const resume = path.join(tmpDir, "sessions", "signout-2", ".claude", "projects", "abc.jsonl");
      fs.mkdirSync(path.dirname(resume), { recursive: true });
      fs.writeFileSync(sessionToken, '{"accessToken":"live"}');
      fs.writeFileSync(resume, "{}");
      writeSessionAccountMarker(tmpDir, "signout-2", "claude", "acct_gone");

      expect((await app.inject({ method: "DELETE", url: "/api/auth/api-key" })).statusCode).toBe(200);

      expect(fs.existsSync(sessionToken)).toBe(false);
      expect(fs.existsSync(resume)).toBe(true);
      expect(readSessionAccountMarker(tmpDir, "signout-2").claude).toBeUndefined();
    });

    it("erases the on-disk credentials of every connected account, not just the first", async () => {
      const now = Date.now();
      const accountDirs = ["claude-default", "acct_work"].map((id, index) => {
        credentialStore.upsertCredentialRoute({
          id, serviceId: "anthropic", billingMode: "sub", via: "account", label: id, isPrimary: index === 0,
          priority: index, status: "ready", createdAt: now, updatedAt: now,
        });
        const dir = path.join(tmpDir, "provider-accounts", "claude", id, ".claude");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, ".credentials.json"), '{"accessToken":"live"}');
        return path.join(tmpDir, "provider-accounts", "claude", id);
      });

      expect((await app.inject({ method: "DELETE", url: "/api/auth/api-key" })).statusCode).toBe(200);

      expect(credentialStore.listCredentialRoutes("anthropic", "sub")).toEqual([]);
      for (const dir of accountDirs) {
        expect(fs.existsSync(dir)).toBe(false);
      }
    });
  });

  describe("POST /api/github/token", () => {
    it("returns 400 for empty token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/github/token",
        payload: { token: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid token and returns status + repos", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/github/token",
        payload: { token: "ghp_valid_token" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status.authenticated).toBe(true);
      expect(body.repos.length).toBeGreaterThan(0);
    });
  });

  describe("POST /api/github/logout", () => {
    it("clears GitHub credentials", async () => {
      await githubAuthManager.setToken("ghp_some_token");
      expect(githubAuthManager.authenticated).toBe(true);
      const res = await app.inject({
        method: "POST",
        url: "/api/github/logout",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status.authenticated).toBe(false);
    });
  });

  describe("POST /api/sessions/:id/pr", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr",
        payload: { title: "My PR", body: "", base: "main" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for empty title", async () => {
      await createSession("s1", "Session 1");
      await githubAuthManager.setToken("ghp_test");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr",
        payload: { title: "", body: "", base: "main" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/sessions/:id/pr/merge", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/merge",
        payload: { method: "squash" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/sessions/:id/pr/comments", () => {
    it("returns 400 for an empty comment body", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/comments",
        payload: { body: "   " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/comments",
        payload: { body: "Looks good" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("posts a PR-level comment to the current-branch PR", async () => {
      await createSession("s1", "Session 1");
      await githubAuthManager.setToken("ghp_test");
      await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "https://github.com/user/repo.git" },
      });
      githubAuthManager.setPrData({
        url: "https://github.com/user/repo/pull/7",
        number: 7,
        base: "main",
        title: "My PR",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/pr/comments",
        payload: { body: "Looks good to me" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ number: 7 });
      expect(githubAuthManager.lastIssueComment).toEqual({ pullNumber: 7, body: "Looks good to me" });
    });
  });

  describe("POST /api/sessions/:id/git/remotes", () => {
    it("adds a remote and returns remotes list", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "https://github.com/user/repo.git" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.remotes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "origin", url: "https://github.com/user/repo.git" }),
        ]),
      );
    });

    it("caches remoteUrl in session metadata when setting origin", async () => {
      await createSession("s1", "Session 1");
      await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "https://github.com/cached/url.git" },
      });
      expect(sessionManager.get("s1")?.remoteUrl).toBe("https://github.com/cached/url.git");
    });

    it("returns 400 for empty remote name", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "", url: "https://github.com/user/repo.git" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty url", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/remotes",
        payload: { name: "origin", url: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/sessions/:id/git/push", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/push",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/sessions/:id/git/pull", () => {
    it("returns 401 when not authenticated", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/git/pull",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/sessions/:id/preview-errors", () => {
    it("returns 400 for empty message", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/preview-errors",
        payload: { message: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts valid error message", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/preview-errors",
        payload: { message: "TypeError: foo is not a function" },
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("POST /api/sessions/:id/template", () => {
    it("scaffolds files for react-vite-ts template", async () => {
      const dir = await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "react-vite-ts" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.templateId).toBe("react-vite-ts");
      expect(body.name).toBe("React + Vite");
      expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "src/App.tsx"))).toBe(true);
    });

    it("returns 400 for unknown template ID", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "does-not-exist" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty template ID", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/s1/template",
        payload: { templateId: "" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/reset", () => {
    it("resets and returns success", async () => {
      await createSession("s1", "Session 1");
      const res = await app.inject({
        method: "POST",
        url: "/api/reset",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it("deletes all persistent data from workspace", async () => {
      const sessionsDir = path.join(tmpDir, "sessions", "test-session");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "file.txt"), "hello");

      const shipitDir = path.join(tmpDir, ".shipit");
      fs.mkdirSync(shipitDir, { recursive: true });
      fs.writeFileSync(path.join(shipitDir, "system-prompt.md"), "Be concise.");

      const res = await app.inject({ method: "POST", url: "/api/reset" });
      expect(res.statusCode).toBe(200);

      const remaining = fs.readdirSync(tmpDir);
      expect(remaining).toEqual([]);
    });

    it("succeeds on already-clean workspace (idempotent)", async () => {
      const res = await app.inject({ method: "POST", url: "/api/reset" });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });
  });
});

describe("Integration: Phase 2 HTTP agent mutations", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let savedOpenAIKey: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-http-agents-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      credentialStore: new CredentialStore(path.join(tmpDir, "credentials")),
      credentialsDir: path.join(tmpDir, "credentials"),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("POST /api/settings/agent", () => {
    it("accepts installed and auth-configured agent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/agent",
        payload: { agentId: "claude" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().agentId).toBe("claude");
    });
  });

  describe("POST /api/agents/:id/env", () => {
    it("sets env var and updates auth status", async () => {
      const beforeRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const codexBefore = beforeRes.json().agents.find((a: any) => a.id === "codex");
      expect(codexBefore.hasRunnableModels).toBe(false);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "OPENAI_API_KEY", value: "sk-test-key-123" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().key).toBe("OPENAI_API_KEY");

      const afterRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const codexAfter = afterRes.json().agents.find((a: any) => a.id === "codex");
      expect(codexAfter.hasRunnableModels).toBe(true);
    });

    it("returns 400 for disallowed env key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "PATH", value: "/usr/bin" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("not in the allowlist");
    });

    it("returns 400 for empty value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/codex/env",
        payload: { key: "OPENAI_API_KEY", value: "   " },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
