import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { CodexAuthManager, type SpawnFn } from "../agents/codex/auth-manager.js";
import {
  StubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { FastifyInstance } from "fastify";

/** Canonical stdout the real CLI prints (sans ANSI), URL + one-time code. */
const CANONICAL_OUTPUT =
  "Welcome to Codex\n\n" +
  "1. Open this link in your browser and sign in to your account\n" +
  "   https://auth.openai.com/codex/device\n\n" +
  "2. Enter this one-time code (expires in 15 minutes)\n" +
  "   K8RE-8MIGC\n";

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

function makeSpawn(): { proc: FakeChildProcess; spawnFn: SpawnFn } {
  const proc = new FakeChildProcess();
  const spawnFn: SpawnFn = () => proc as unknown as ChildProcess;
  return { proc, spawnFn };
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

class SseTestClient {
  private req: http.ClientRequest;
  private buffer = "";
  private frames: SseFrame[] = [];
  private returned = new Set<number>();

  private constructor(req: http.ClientRequest) {
    this.req = req;
  }

  static connect(port: number): Promise<SseTestClient> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/events`,
        { headers: { Accept: "text/event-stream" } },
        (res) => {
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => client.ingest(chunk));
        },
      );
      const client = new SseTestClient(req);
      req.on("error", reject);
      req.on("response", () => setTimeout(() => resolve(client), 20));
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        this.frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
      } catch {
        // Non-JSON keepalive / comment — ignore.
      }
    }
  }

  async waitFor(
    event: string,
    predicate: (data: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < this.frames.length; i++) {
        if (this.returned.has(i)) continue;
        const f = this.frames[i];
        if (f.event === event && predicate(f.data)) {
          this.returned.add(i);
          return f.data;
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`SSE waitFor("${event}") timed out after ${timeoutMs}ms`);
  }

  close(): void {
    this.req.destroy();
  }
}

const findCodex = (
  data: Record<string, unknown>,
): { hasRunnableModels?: boolean; reasoning?: { options: unknown[] } } | undefined =>
  (
    data.agents as
      | { id: string; hasRunnableModels?: boolean; reasoning?: { options: unknown[] } }[]
      | undefined
  )?.find((a) => a.id === "codex");

describe("Integration: Codex device-auth flow (HTTP -> SSE -> agent_list)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let codexAuthManager: CodexAuthManager;
  let fakeProc: FakeChildProcess;
  let authFilePath: string;
  let savedOpenAIKey: string | undefined;
  let sse: SseTestClient | null = null;

  const createCodexAccount = async (): Promise<string> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/provider-accounts",
      payload: { provider: "codex" },
    });
    expect(res.statusCode).toBe(200);
    const { account } = res.json() as { account: { id: string } };
    authFilePath = path.join(tmpDir, "provider-accounts", "codex", account.id, ".codex", "auth.json");
    fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
    return account.id;
  };

  const startAccountLogin = (accountId: string) =>
    app.inject({ method: "POST", url: `/api/provider-accounts/codex/${accountId}/login` });

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-codex-auth-"));
    // Disable the API-key fallback so it cannot mask device-auth failure.
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    authFilePath = path.join(tmpDir, "codex-auth.json");

    const { proc, spawnFn } = makeSpawn();
    fakeProc = proc;
    codexAuthManager = new CodexAuthManager({
      spawn: spawnFn,
      checkAuthFile: () => fs.existsSync(authFilePath) && fs.statSync(authFilePath).size > 0,
      timeoutMs: 60_000,
    });

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude" || binary === "codex",
      checkClaudeAuth: () => true,
      checkCodexAuth: () => codexAuthManager.checkCredentials(),
    });
    await registry.detect();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      codexAuthManager,
      // Keep account creation out of the real credentials directory.
      credentialsDir: tmpDir,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    sse?.close();
    sse = null;
    codexAuthManager.cancel();
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

  it("drives the device flow end to end and flips codex hasRunnableModels", async () => {
    sse = await SseTestClient.connect(port);

    const initial = await sse.waitFor("agent_list", (d) => !!findCodex(d));
    expect(findCodex(initial)?.hasRunnableModels).toBe(false);
    expect(findCodex(initial)?.reasoning?.options.length).toBeGreaterThan(0);

    const accountId = await createCodexAccount();
    const start = await startAccountLogin(accountId);
    expect(start.statusCode).toBe(202);
    expect(start.json()).toMatchObject({ success: true });

    fakeProc.stdout.push(Buffer.from(CANONICAL_OUTPUT, "utf-8"));
    const pending = await sse.waitFor(
      "agent_auth_pending",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    ) as { loginId: string; accountId?: string; details: { kind: string; verificationUri: string; userCode: string; expiresInSec: number } };
    expect(pending.accountId).toBe(accountId);
    expect(pending.details.kind).toBe("device-code");
    expect(pending.details.verificationUri).toBe("https://auth.openai.com/codex/device");
    expect(pending.details.userCode).toBe("K8RE-8MIGC");
    expect(pending.details.expiresInSec).toBeGreaterThan(0);

    fs.writeFileSync(authFilePath, JSON.stringify({ tokens: { access_token: "tok" } }));
    fakeProc.emit("close", 0);

    const complete = await sse.waitFor(
      "agent_auth_complete",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    ) as { loginId: string; accountId?: string };
    expect(complete.accountId).toBe(accountId);
    const after = await sse.waitFor(
      "agent_list",
      (d) => findCodex(d)?.hasRunnableModels === true,
    );
    expect(findCodex(after)?.hasRunnableModels).toBe(true);

    expect(fs.existsSync(authFilePath)).toBe(true);
  });

  it("broadcasts agent_auth_failed on non-zero exit and leaves codex unauthenticated", async () => {
    sse = await SseTestClient.connect(port);
    await sse.waitFor("agent_list", (d) => !!findCodex(d));

    const start = await startAccountLogin(await createCodexAccount());
    expect(start.statusCode).toBe(202);

    fakeProc.stdout.push(Buffer.from(CANONICAL_OUTPUT, "utf-8"));
    await sse.waitFor(
      "agent_auth_pending",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    );

    fakeProc.emit("close", 1);

    const failed = await sse.waitFor(
      "agent_auth_failed",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    ) as { loginId: string; accountId?: string; reason: string; message: string };
    expect(failed.accountId).toBeDefined();
    expect(failed.reason).toBe("error");
    expect(failed.message).toMatch(/code 1/);

    expect(fs.existsSync(authFilePath)).toBe(false);
    const boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(findCodex(boot.json())?.hasRunnableModels).toBe(false);
  });

  it("start is idempotent while a device flow is already in flight", async () => {
    sse = await SseTestClient.connect(port);

    const accountId = await createCodexAccount();
    const first = await startAccountLogin(accountId);
    expect(first.statusCode).toBe(202);

    fakeProc.stdout.push(Buffer.from(CANONICAL_OUTPUT, "utf-8"));
    await sse.waitFor(
      "agent_auth_pending",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    );

    const second = await startAccountLogin(accountId);
    expect(second.statusCode).toBe(202);

    const replay = await sse.waitFor(
      "agent_auth_pending",
      (d) => (d as { loginId?: string }).loginId === "openai-chatgpt",
    ) as { loginId: string; details: { kind: string; userCode: string } };
    expect(replay.details.userCode).toBe("K8RE-8MIGC");
  });
});
