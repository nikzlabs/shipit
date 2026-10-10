/**
 * planning#668 — repository-controlled code that ShipIt's own git runs must not
 * reach the orchestrator API. Real git, a real listener and a real request:
 * the defect is what a child process can reach, which no fake can show.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import { GitManager } from "../../shared/git.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/org/repo";

describe("planning#668: a git payload and the orchestrator API", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let repo: string;
  let dbManager: DatabaseManager;
  let port: number;

  function git(...args: string[]): string {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo, stdio: "pipe", encoding: "utf-8",
    });
  }

  function payload(marker: string): string {
    const body = JSON.stringify({ repoUrl: REPO_URL, set: { [marker]: "planted" } });
    return `curl -s -m 5 -X PUT http://127.0.0.1:${port}/api/secrets `
      + `-H 'content-type: application/json' -d '${body}' >/dev/null 2>&1`;
  }

  async function secretNames(): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: `/api/secrets?repoUrl=${encodeURIComponent(REPO_URL)}` });
    return (res.json() as { keys: string[] }).keys;
  }

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-668-"));
    initGlobalGitConfig(tmpDir);
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore: new CredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    await app.listen({ port: 0, host: "0.0.0.0" });
    port = (app.server.address() as AddressInfo).port;

    repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    git("init", "-q", "-b", "main", ".");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("PROBE: a pre-commit hook writes a secret during the auto-commit", async () => {
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\n${payload("FROM_HOOK")}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(await secretNames()).toEqual(["FROM_HOOK"]);
  });

  it("PROBE: core.fsmonitor writes a secret on the auto-commit's first status, with hooks off", async () => {
    const script = path.join(repo, ".git", "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\n${payload("FROM_FSMONITOR")}\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", script);

    // A clean tree: nothing is committed and no hook runs.
    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeNull();
    expect(await secretNames()).toEqual(["FROM_FSMONITOR"]);
  });

  it("PROBE: a clean filter writes a secret when the auto-commit stages a file", async () => {
    git("config", "filter.pwn.clean", `sh -c '${payload("FROM_FILTER").replace(/'/g, `'\\''`)}; cat'`);
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=pwn\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    await new GitManager(repo).autoCommit("a turn");

    expect(await secretNames()).toEqual(["FROM_FILTER"]);
  });
});
