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
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionSshHostsView, SshHostPublic } from "../../shared/types.js";
import { _resetSshRateLimits } from "../services/ssh.js";
import {
  buildSessionBind,
  buildUserauthData,
  fakeEd25519ServerKey,
} from "../ssh-test-helpers.js";

describe("Integration: SSH host routes", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  let otherSessionId: string;

  beforeEach(async () => {
    _resetSshRateLimits();
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-routes-"));
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
      credentialsDir: tmpDir,
      serveStatic: false,
    });

    sessionId = (await createTestSession(sessionManager, tmpDir)).sessionId;
    otherSessionId = (await createTestSession(sessionManager, tmpDir)).sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const create = async (over: Record<string, unknown> = {}): Promise<SshHostPublic> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ssh-hosts",
      payload: { label: "prod", address: "prod.example.com", user: "deploy", ...over },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { host: SshHostPublic }).host;
  };

  const grant = (id: string, granted: string[]) =>
    app.inject({ method: "PUT", url: `/api/sessions/${id}/ssh-hosts`, payload: { granted } });

  describe("registry CRUD", () => {
    it("creates a destination with a generated key and returns only public material", async () => {
      const host = await create();
      expect(host.publicLine).toContain("ssh-ed25519 ");
      expect(host.fingerprint).toMatch(/^SHA256:/);
      expect(JSON.stringify(host)).not.toContain("PRIVATE KEY");
      expect(host).not.toHaveProperty("privateKeyPem");

      const list = await app.inject({ method: "GET", url: "/api/ssh-hosts" });
      expect((list.json() as { hosts: SshHostPublic[] }).hosts).toEqual([host]);
      expect(list.body).not.toContain("PRIVATE KEY");
    });

    it("rejects an address that is neither a hostname nor an IPv4 literal", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/ssh-hosts",
        payload: { label: "bad", address: "not a host!", user: "deploy" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a user that ssh would read as a second argument", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/ssh-hosts",
        payload: { label: "bad", address: "prod.example.com", user: "deploy root" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a port outside the valid range", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/ssh-hosts",
        payload: { label: "bad", address: "prod.example.com", user: "deploy", port: 70000 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("revokes the grant everywhere when a destination is deleted", async () => {
      const host = await create();
      await grant(sessionId, [host.id]);
      expect(sessionManager.get(sessionId)?.sshHosts).toEqual([host.id]);

      const res = await app.inject({ method: "DELETE", url: `/api/ssh-hosts/${host.id}` });
      expect(res.statusCode).toBe(200);
      expect(sessionManager.get(sessionId)?.sshHosts).toBeUndefined();
    });
  });

  describe("session grants", () => {
    // req 6 — any session kind, so this route is deliberately not behind the
    // sandbox guard the capability editor uses.
    it("grants a destination to an ordinary repo-backed session", async () => {
      const host = await create();
      const res = await grant(sessionId, [host.id]);
      expect(res.statusCode).toBe(200);
      expect((res.json() as SessionSshHostsView).granted).toEqual([host.id]);
      expect(sessionManager.get(sessionId)?.sshHosts).toEqual([host.id]);
    });

    it("provisions ~/.ssh on grant and clears it on revoke", async () => {
      const host = await create();
      const sshDir = path.join(tmpDir, "sessions", sessionId, ".ssh");

      await grant(sessionId, [host.id]);
      expect(fs.readFileSync(path.join(sshDir, "config"), "utf8")).toContain("Host prod");
      expect(fs.existsSync(path.join(sshDir, "prod.pub"))).toBe(true);

      await grant(sessionId, []);
      expect(fs.readFileSync(path.join(sshDir, "config"), "utf8")).not.toContain("Host prod");
      expect(fs.existsSync(path.join(sshDir, "prod.pub"))).toBe(false);
    });

    /**
     * docs/188 — a grant moving is a trust-boundary change, so it has to still
     * be in the scrollback tomorrow, not merely on the wire today.
     */
    it("persists a change card naming what was granted and what was revoked", async () => {
      const host = await create();
      const history = new ChatHistoryManager(dbManager);

      await grant(sessionId, [host.id]);
      const afterGrant = history.load(sessionId).at(-1);
      expect(afterGrant?.sessionSettingsChange).toMatchObject({
        scope: "ssh-hosts",
        changes: [{ label: "SSH · prod", from: "not granted", to: "granted", granted: true }],
      });

      await grant(sessionId, []);
      expect(history.load(sessionId).at(-1)?.sessionSettingsChange).toMatchObject({
        scope: "ssh-hosts",
        changes: [{ label: "SSH · prod", from: "granted", to: "not granted", granted: false }],
      });
    });

    it("writes no card when the grant is unchanged", async () => {
      const host = await create();
      const history = new ChatHistoryManager(dbManager);
      await grant(sessionId, [host.id]);
      const before = history.load(sessionId).length;
      await grant(sessionId, [host.id]);
      expect(history.load(sessionId)).toHaveLength(before);
    });

    it("refuses a grant naming a destination that does not exist", async () => {
      const res = await grant(sessionId, ["ssh_nope"]);
      expect(res.statusCode).toBe(400);
      expect(sessionManager.get(sessionId)?.sshHosts).toBeUndefined();
    });

    it("404s for a session that does not exist", async () => {
      expect((await grant("no-such-session", [])).statusCode).toBe(404);
    });
  });

  describe("identities and signing", () => {
    it("answers identities for a granted session and nothing for an ungranted one", async () => {
      const host = await create();
      await grant(sessionId, [host.id]);

      const granted = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/ssh/identities` });
      expect((granted.json() as { identities: unknown[] }).identities).toHaveLength(1);

      const ungranted = await app.inject({ method: "GET", url: `/api/sessions/${otherSessionId}/ssh/identities` });
      expect((ungranted.json() as { identities: unknown[] }).identities).toEqual([]);
    });

    it("signs for a granted session and refuses the same request from another", async () => {
      const host = await create();
      await grant(sessionId, [host.id]);

      const server = fakeEd25519ServerKey();
      const sshSessionId = Buffer.from("kex-hash");
      const payload = {
        keyBlob: host.publicKeyBlob,
        data: buildUserauthData({
          sessionId: sshSessionId,
          user: host.user,
          publicKeyBlob: host.publicKeyBlob,
        }),
        bind: buildSessionBind(server, sshSessionId),
      };

      const signed = await app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/ssh/sign`, payload,
      });
      expect(signed.statusCode).toBe(200);
      expect(typeof (signed.json() as { signature: string }).signature).toBe("string");

      const refused = await app.inject({
        method: "POST", url: `/api/sessions/${otherSessionId}/ssh/sign`, payload,
      });
      expect(refused.statusCode).toBe(403);
    });

    it("400s a sign request missing its fields", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/sessions/${sessionId}/ssh/sign`, payload: { keyBlob: "x" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * req 3 — the two surfaces the design names as the ones that look usable and
   * are not. Neither may return the private half, and a session container may
   * not reach the registry at all.
   */
  describe("the private key is unreachable", () => {
    it("appears in no settings read", async () => {
      await create();
      for (const url of ["/api/settings", "/api/ssh-hosts", `/api/sessions/${sessionId}/ssh-hosts`]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.body).not.toContain("PRIVATE KEY");
        expect(res.body).not.toContain("privateKeyPem");
      }
    });

    it("keeps the registry off the container-accessible route set", () => {
      const routes = app.containerAccessibleRoutes;
      expect([...routes].filter((r) => r.includes("/api/ssh-hosts"))).toEqual([]);
      expect(routes.has(`GET /api/sessions/:id/ssh/identities`)).toBe(true);
      expect(routes.has(`POST /api/sessions/:id/ssh/sign`)).toBe(true);
      expect(routes.has(`PUT /api/sessions/:id/ssh-hosts`)).toBe(false);
    });
  });
});
