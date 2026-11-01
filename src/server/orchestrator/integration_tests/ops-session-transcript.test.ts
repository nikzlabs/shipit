import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const SUBJECT = "7bc72326-c1ad-48fd-ac95-12149a000000";
const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOP1234567890abcd";

describe("Integration: Ops session transcript (docs/326)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-session-transcript-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      repoStore: new RepoStore(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // ignore cleanup errors
    }
  });

  async function createSession(kind?: "ops"): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "S" } });
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };
    if (kind === "ops") sessionManager.setKind(sessionId, "ops");
    return sessionId;
  }

  function seedSubject(): void {
    sessionManager.track(SUBJECT, "Merge watch investigation");
    chatHistoryManager.append(SUBJECT, { role: "user", text: "USER-TEXT-MARKER tell me when the PR merges" });
    chatHistoryManager.append(SUBJECT, {
      role: "assistant",
      text: "ASSISTANT-TEXT-MARKER",
      toolUse: [{
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "shipit session notify-on-merge --self" },
      }],
      toolResults: [{
        toolUseId: "toolu_1",
        content: `409: a merge watch is already armed\nGITHUB_TOKEN=${GITHUB_TOKEN}`,
        isError: true,
      }],
    });
    chatHistoryManager.append(SUBJECT, {
      role: "assistant",
      text: "",
      selfMergeWatch: {
        cardId: "c1",
        watchId: "w1",
        prNumber: 3120,
        prUrl: "https://github.com/acme/app/pull/3120",
        createdAt: "2026-10-10T08:01:31.000Z",
      },
    });
  }

  interface Body {
    sessionId: string;
    entries: { position: number; message: Record<string, unknown> }[];
    stored: number;
    archived?: boolean;
    diskTier: string;
    redactions: number;
    everStored: boolean;
  }

  it("lets an ops session read another session's messages, tool results and cards", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=7bc72326`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body.sessionId).toBe(SUBJECT);
    expect(body.stored).toBe(3);
    expect(body.entries[0].message.text).toContain("USER-TEXT-MARKER");
    expect(body.entries[1].message.text).toBe("ASSISTANT-TEXT-MARKER");
    expect(body.entries[1].message.toolResults).toEqual([
      expect.objectContaining({ isError: true, content: expect.stringContaining("409: a merge watch is already armed") }),
    ]);
    expect(body.entries[2].message.selfMergeWatch).toMatchObject({ watchId: "w1", prNumber: 3120 });
  });

  it("redacts a credential before the text leaves the orchestrator, and keeps the PR URL", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}&full=true`,
    });

    expect(res.body).not.toContain(GITHUB_TOKEN);
    expect(res.body).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(res.body).toContain("https://github.com/acme/app/pull/3120");
    expect((res.json() as Body).redactions).toBe(1);
  });

  it("answers for an archived session with no runner and no checkout", async () => {
    const ops = await createSession("ops");
    seedSubject();
    sessionManager.setDiskTier(SUBJECT, "evicted");
    sessionManager.archive(SUBJECT);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;
    expect(body).toMatchObject({ archived: true, diskTier: "evicted", stored: 3 });
    expect(body.entries).toHaveLength(3);
  });

  it("tells a removed transcript from one that never existed", async () => {
    const ops = await createSession("ops");
    seedSubject();
    chatHistoryManager.saveMessages(SUBJECT, []);
    sessionManager.track("cccc1111-0000-0000-0000-000000000000", "Never used");

    const removed = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}`,
    });
    expect(removed.json() as Body).toMatchObject({ stored: 0, entries: [], everStored: true });

    const never = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=cccc1111`,
    });
    expect(never.json() as Body).toMatchObject({ stored: 0, entries: [], everStored: false });
  });

  it("pages backwards with last and before", async () => {
    const ops = await createSession("ops");
    seedSubject();

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}&last=1&before=3`,
    });

    const body = res.json() as Body & { truncated: boolean; olderBefore: number };
    expect(body.entries.map((e) => e.position)).toEqual([2]);
    expect(body).toMatchObject({ truncated: true, olderBefore: 2 });
  });

  it("400s a bad --last, --before or --since rather than applying a default", async () => {
    const ops = await createSession("ops");
    seedSubject();
    for (const query of [
      "last=0", "last=garbage", "before=-1", "before=1.5", "since=1%20hour%20ago",
      // Given with no value: an error, not the default page.
      "last=", "before=", "since=", "until=",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}&${query}`,
      });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it("marks a stored row it cannot decode, and never quotes it in the reply", async () => {
    const ops = await createSession("ops");
    seedSubject();
    const broken = chatHistoryManager.append(SUBJECT, { role: "assistant", text: "x" });
    dbManager.db.prepare("UPDATE messages SET tool_use = ? WHERE id = ?").run(`${GITHUB_TOKEN} is not JSON`, broken);

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(GITHUB_TOKEN);
    expect(res.body).not.toContain("ghp_ABCDEF");
    const body = res.json() as { entries: { position: number; withheld?: string }[] };
    expect(body.entries.filter((e) => e.withheld === "unreadable").map((e) => e.position)).toEqual([4]);
  });

  it("404s a target that matches no session", async () => {
    const ops = await createSession("ops");
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${ops}/host-session-transcript?target=deadbeef`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for a non-ops caller, also for its own transcript, and returns no content", async () => {
    const ordinary = await createSession();
    seedSubject();
    chatHistoryManager.append(ordinary, { role: "user", text: "OWN-TEXT-MARKER" });

    for (const target of [SUBJECT, ordinary]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${ordinary}/host-session-transcript?target=${target}`,
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error).toMatch(/only available in Ops sessions/);
      expect(res.body).not.toContain("USER-TEXT-MARKER");
      expect(res.body).not.toContain("OWN-TEXT-MARKER");
    }
  });

  it("returns 404 for a caller session that doesn't exist", async () => {
    seedSubject();
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/nope/host-session-transcript?target=${SUBJECT}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("offers no write: the transcript route answers GET only", async () => {
    const ops = await createSession("ops");
    seedSubject();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/sessions/${ops}/host-session-transcript?target=${SUBJECT}`,
        payload: {},
      });
      expect(res.statusCode, method).toBe(404);
    }
    expect(chatHistoryManager.load(SUBJECT)).toHaveLength(3);
  });
});
