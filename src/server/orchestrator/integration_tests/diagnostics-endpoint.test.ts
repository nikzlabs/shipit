/**
 * Integration test for `GET /api/sessions/:id/diagnostics`.
 *
 * Verifies the route returns the shape the SessionDiagnosticsPanel polls
 * (health, services, runner, recentLogs, meta) without depending on Docker.
 * The component-level unit tests in `services/diagnostics.test.ts` cover
 * the aggregation logic; this test pins down the route wiring + response
 * envelope.
 *
 * See docs/124-session-rescue-and-diagnostics §3.3 (now §2.2 in the
 * delivered checklist).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";

describe("GET /api/sessions/:id/diagnostics", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-diag-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
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
      // ignore
    }
  });

  it("returns the diagnostics envelope for a known session", async () => {
    const sessionDir = path.join(tmpDir, "sessions", "diag-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track("diag-1", "Diag 1", sessionDir);

    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/diag-1/diagnostics",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      generatedAt: number;
      health: unknown;
      services: unknown[];
      stackStartError: string | null;
      runner: unknown;
      recentLogs: unknown[];
      parsedConfig: unknown;
      oomBreaker: unknown;
    };

    expect(body.sessionId).toBe("diag-1");
    expect(typeof body.generatedAt).toBe("number");
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.recentLogs)).toBe(true);
    // No container manager wired in this app → health degrades to { error }.
    expect(body.health).toMatchObject({ error: expect.any(String) as string });
    // No runner attached yet (no WS) → runner is null.
    expect(body.runner).toBeNull();
    // No stack-start error in clean state.
    expect(body.stackStartError).toBeNull();
    // No shipit.yaml in the workspace → parsedConfig falls back to defaults
    // (the same shape the parser returns for an empty file).
    expect(body.parsedConfig).toMatchObject({
      agent: { memory: 1536, cpu: 0.5, pids: 4096, install: [] },
      effectiveAgent: { memory: 1536, cpu: 0.5, pids: 4096, dockerAccess: false },
      warnings: [],
    });
  });

  it("surfaces the parsed shipit.yaml and migration warnings", async () => {
    const sessionDir = path.join(tmpDir, "sessions", "diag-cfg");
    fs.mkdirSync(sessionDir, { recursive: true });
    sessionManager.track("diag-cfg", "Diag cfg", sessionDir);

    fs.writeFileSync(
      path.join(sessionDir, "shipit.yaml"),
      [
        "agent:",
        "  memory: 3072",
        "  cpu: 2.0",
        "  pids: 2048",
        "compose:",
        "  file: docker-compose.yml",
        "  docker-socket: true",
        // Old-format key — should appear in `warnings` instead of overriding
        // memory back down to a silent 1 GiB.
        "resources:",
        "  memory: 8192",
        "",
      ].join("\n"),
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/diag-cfg/diagnostics",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      parsedConfig: {
        agent: { memory: number; cpu: number; pids: number; install: string[] };
        compose?: { file: string; dockerSocket: boolean };
        warnings: string[];
        parseError?: string;
      };
    };
    expect(body.parsedConfig.agent).toMatchObject({ memory: 3072, cpu: 2.0, pids: 2048 });
    expect(body.parsedConfig.compose).toEqual({ file: "docker-compose.yml", dockerSocket: true });
    expect(body.parsedConfig.warnings.join("\n")).toMatch(/`resources` block has been replaced/);
    expect(body.parsedConfig.parseError).toBeUndefined();
  });

  it("returns 404 for an unknown session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions/nope/diagnostics",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
  });
});
