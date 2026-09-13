import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { runShim, type ShimIO } from "../../session/agent-shim/shipit.js";

// docs/299-agent-settings-access req 1: the agent reads ShipIt's settings itself,
// end to end — shim, relay path, orchestrator route, catalogue projection.

describe("Integration: agent settings access (docs/299)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  const sessionId = "settings-sess";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    sessionManager.track(sessionId, "Settings session", workspaceDir);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The shim's path, mapped the way the agent-ops relay maps it.
  async function runSettingsShim(
    argv: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    const io: ShimIO = {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      exit: (code) => { exitCode = code; throw new Error("__shim_exit__"); },
    };
    const call = async (
      method: "GET" | "POST" | "PATCH",
      reqPath: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const suffix = reqPath
        .replace("/agent-ops/settings/list", "/settings")
        .replace("/agent-ops/settings/get", "/settings/detail");
      const res = await app.inject({ method, url: `/api/sessions/${sessionId}${suffix}` });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };
    try {
      await runShim(argv, io, {}, call as never);
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode };
  }

  it("lists every declared setting with what it is set to", async () => {
    credentialStore.setDeclaredSetting("advanced.autoFixCi", true);
    const { stdout, exitCode } = await runSettingsShim(["settings", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("advanced.autoFixCi = true");
    expect(stdout).toContain("advanced.enableSubAgents = true");
    expect(stdout).toContain("Auto-fix CI when checks fail —");
  });

  it("answers the setting behind a blocked sub-agent run, not a generic pointer", async () => {
    credentialStore.setDeclaredSetting("advanced.enableSubAgents", false);
    const { stdout, exitCode } = await runSettingsShim([
      "settings", "get", "advanced.enableSubAgents",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Value: false");
    expect(stdout).toContain("Allow spawning another agent for a sub-task");
    // The whole description, the same words the dialog shows (req 7).
    expect(stdout).toContain("second-opinion review from a different model");
  });

  it("returns the whole catalogue as JSON, with no hard-coded list of settings", async () => {
    const { stdout } = await runSettingsShim(["settings", "list", "--json"]);
    const body = JSON.parse(stdout) as {
      settings: { key: string; readable: boolean }[];
      tabs: string[];
    };

    const { GLOBAL_SETTINGS } = await import("../../shared/settings-catalogue/index.js");
    expect(body.settings.map((s) => s.key).sort()).toEqual(Object.keys(GLOBAL_SETTINGS).sort());
    expect(body.tabs).toContain("network");
  });

  it("narrows to one tab", async () => {
    const { stdout } = await runSettingsShim(["settings", "list", "--tab", "git", "--json"]);
    const body = JSON.parse(stdout) as { settings: { key: string }[] };
    expect(body.settings.map((s) => s.key)).toEqual(["git.identity"]);
  });

  it("names an unknown key instead of returning an empty read", async () => {
    const { stderr, exitCode } = await runSettingsShim(["settings", "get", "advanced.nope"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("advanced.nope");
  });

  it("refuses a settings read for another session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-session/settings" });
    expect(res.statusCode).toBe(404);
  });
});
