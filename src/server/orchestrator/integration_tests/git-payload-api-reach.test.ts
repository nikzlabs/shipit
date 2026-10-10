/**
 * planning#668 (docs/266 req 16) — repository-controlled code that ShipIt's own
 * git runs (a hook, a `filter`/`fsmonitor`) executes as a child in the
 * orchestrator's OWN network namespace, so it can reach the orchestrator API
 * over loopback. The API's container-origin guard must refuse the orchestrator's
 * own loopback rather than trust it as the user.
 *
 * Real git, a real listener and a real request: the defect is what a child
 * process can reach, which no fake can reproduce. The app is built with
 * `trustOwnContainerLoopback: false` to exercise the production denial that test
 * mode would otherwise disable (the single-container dev stack trusts its own
 * loopback — see the guard). Before the fix every PROBE wrote a secret; the hole
 * was open.
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
import { SecretStore } from "../secret-store.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/org/repo";

describe("planning#668: a git payload cannot reach the API over the orchestrator's loopback", () => {
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

  // A curl of PUT /api/secrets; -s keeps curl's exit 0 on an HTTP error, so the
  // hook does not fail the commit — the test asserts only that the write did not land.
  function payload(marker: string): string {
    const body = JSON.stringify({ repoUrl: REPO_URL, set: { [marker]: "planted" } });
    return `curl -s -m 5 -X PUT http://127.0.0.1:${port}/api/secrets `
      + `-H 'content-type: application/json' -d '${body}' >/dev/null 2>&1 || true`;
  }

  // Read the store directly: under the denial every app.inject() is loopback too,
  // so the API cannot be used to verify what the payload could not write.
  function secretNames(): string[] {
    return new SecretStore(dbManager).loadSecretNames(REPO_URL);
  }

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-668-"));
    initGlobalGitConfig(tmpDir);
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      databaseManager: dbManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore: new CredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
      // Force the production denial that test mode would otherwise disable.
      trustOwnContainerLoopback: false,
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

  it("refuses a pre-commit hook's write, and the commit still lands", async () => {
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\n${payload("FROM_HOOK")}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeTruthy();
    expect(secretNames()).toEqual([]);
  });

  it("refuses core.fsmonitor's write on the auto-commit's first status, with hooks off", async () => {
    const script = path.join(repo, ".git", "fsmonitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\n${payload("FROM_FSMONITOR")}\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", script);

    // A clean tree: nothing is committed and no hook runs, but status still runs fsmonitor.
    const result = await new GitManager(repo).autoCommit("a turn");

    expect(result.commitHash).toBeNull();
    expect(secretNames()).toEqual([]);
  });

  it("refuses a clean filter's write when the auto-commit stages a file", async () => {
    git("config", "filter.pwn.clean", `sh -c '${payload("FROM_FILTER").replace(/'/g, `'\\''`)}; cat'`);
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=pwn\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "agent edit\n");

    await new GitManager(repo).autoCommit("a turn");

    expect(secretNames()).toEqual([]);
  });
});
