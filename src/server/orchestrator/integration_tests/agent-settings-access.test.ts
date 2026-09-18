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
import { resolveMcpServer } from "../../session/mcp-resolve.js";
import { addMcpServer } from "../services/mcp.js";

// docs/299-agent-settings-access req 1: the agent reads ShipIt's settings
// itself — the shim, the orchestrator route, and the catalogue projection.

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

  // The shim against the real orchestrator routes. The relay in between is
  // mapped the way `agent-ops-routes.ts` maps it and is tested there.
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
    expect(stdout).toContain("advanced.autoFixCi = on");
    expect(stdout).toContain("advanced.enableSubAgents = on");
    expect(stdout).toContain("Auto-fix CI when checks fail —");
    // Both dialogs, not just the payload scalars (req 5).
    expect(stdout).toContain("roles[].model");
    expect(stdout).toContain("project.allowAgentMerge");
  });

  it("answers the setting behind a blocked sub-agent run, not a generic pointer", async () => {
    credentialStore.setDeclaredSetting("advanced.enableSubAgents", false);
    const { stdout, exitCode } = await runSettingsShim([
      "settings", "get", "advanced.enableSubAgents",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Value: off");
    expect(stdout).toContain("Allow spawning another agent for a sub-task");
    // The whole description, the same words the dialog shows (req 7).
    expect(stdout).toContain("second-opinion review from a different model");
  });

  it("returns the whole catalogue as JSON, read from the catalogue rather than a list here", async () => {
    const { stdout } = await runSettingsShim(["settings", "list", "--json"]);
    const body = JSON.parse(stdout) as {
      settings: { key: string; readable: boolean }[];
      tabs: string[];
    };

    const { ALL_SETTINGS } = await import("../../shared/settings-catalogue/index.js");
    expect(body.settings.map((s) => s.key).sort()).toEqual(
      ALL_SETTINGS.map((d) => d.key).sort(),
    );
    expect(body.tabs).toContain("network");
    expect(body.tabs).toContain("keyboard");
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

  /**
   * req 3 across the layer boundary: the surface that exists to explain a
   * blocker has to see the blocker the runtime sees. Only an integration test
   * can pin this — the orchestrator may not import `session/`, so neither side's
   * own unit test can hold both answers about one configuration.
   */
  it("agrees with the session's own MCP resolver about a missing argument secret", async () => {
    const config = {
      name: "demo",
      type: "stdio" as const,
      command: "npx",
      // A provider's token is routinely passed as an argument.
      args: ["--token", "$secret:mcp__demo__TOKEN"],
      enabled: true,
    };
    addMcpServer(credentialStore, config, {});

    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/settings/detail?key=${encodeURIComponent("mcp.servers[].args")}`,
    });
    const body = res.json() as { items?: { address: string; display: string; notes?: string[] }[] };
    const item = body.items?.find((i) => i.address === "demo");

    expect(item?.display).toBe("not configured");
    expect(item?.notes?.join(" ")).toContain("cannot start until it is set");
    // The runtime, on the same configuration: the server is omitted from the
    // turn entirely, and it names the credential that is missing.
    expect(resolveMcpServer(config, {})).toEqual({
      resolved: null,
      missing: ["mcp__demo__TOKEN"],
    });
  });

  // Keeping a container to its OWN session is the container guard's job and is
  // covered by its golden route table; this only pins that an unknown session
  // is a 404 rather than a listing of defaults.
  it("404s a read for a session that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/not-a-session/settings" });
    expect(res.statusCode).toBe(404);
  });
});
