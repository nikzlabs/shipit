import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { PreviewManager } from "../preview-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubPreviewManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  StubGitHubAuthManager,
} from "./test-helpers.js";

describe("Integration: Repo Docs (pre-session GitHub API docs)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let stubGithub: StubGitHubAuthManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-docs-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    const sessionManager = new SessionManager(sessionsFile);

    stubGithub = new StubGitHubAuthManager();
    stubGithub.setRepoDocFiles(["README.md", "docs/setup.md"]);
    stubGithub.setRepoDocContent("README.md", "# My Repo\nWelcome!");
    stubGithub.setRepoDocContent("docs/setup.md", "# Setup\nRun npm install");

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      previewManager: new StubPreviewManager() as unknown as PreviewManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      githubAuthManager: stubGithub as unknown as GitHubAuthManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      startPreview: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("list_repo_docs returns markdown files from GitHub API", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_repo_docs", repoFullName: "owner/repo" });
    const msg = await client.receive();

    expect(msg.type).toBe("repo_doc_list");
    expect((msg as any).files).toEqual(["README.md", "docs/setup.md"]);

    client.close();
  });

  it("get_repo_doc returns file content from GitHub API", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_repo_doc", repoFullName: "owner/repo", path: "README.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("repo_doc_content");
    expect((msg as any).path).toBe("README.md");
    expect((msg as any).content).toBe("# My Repo\nWelcome!");

    client.close();
  });

  it("get_repo_doc returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_repo_doc", repoFullName: "owner/repo", path: "nope.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read repo doc");

    client.close();
  });

  it("list_repo_docs rejects invalid repo name", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_repo_docs", repoFullName: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid repository name");

    client.close();
  });

  it("get_repo_doc rejects empty path", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_repo_doc", repoFullName: "owner/repo", path: "" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("File path is required");

    client.close();
  });
});
