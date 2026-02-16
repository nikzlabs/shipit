import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildApp } from "../index.js";
import type { AuthManager } from "../auth.js";
import type { ViteManager } from "../vite-manager.js";
import type { ClaudeProcess } from "../claude.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { TestClient, FakeClaudeProcess, StubAuthManager, StubViteManager, StubGitHubAuthManager, waitForClaude } from "./test-helpers.js";

describe("Integration: Conversation branching workflow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-branching-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // best effort
    }
  });

  it("supports checkpoint -> branch -> switch flow", async () => {
    let latestClaude: FakeClaudeProcess | null = null;
    const app = await buildApp({
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      authManager: new StubAuthManager() as unknown as AuthManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        latestClaude = new FakeClaudeProcess();
        return latestClaude as unknown as ClaudeProcess;
      },
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const client = await TestClient.connect(port);

    await client.receiveSkipLogs(); // preview_status
    client.send({ type: "send_message", text: "hello" });

    const claude = await waitForClaude(() => latestClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-1" });
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    claude.finish("agent-1", 0);

    let sessionStarted = false;
    // Drain messages until session_started appears (ordering may vary with stream events)
    for (let i = 0; i < 6; i++) {
      const msg = await client.receiveSkipLogs();
      if (msg.type === "session_started") {
        sessionStarted = true;
        break;
      }
    }
    expect(sessionStarted).toBe(true);

    // Drain remaining turn messages
    await client.receiveSkipLogs();
    await client.receiveSkipLogs();

    client.send({ type: "create_checkpoint", label: "before change" });
    const checkpointMsg = await client.receiveSkipLogs();
    expect(checkpointMsg.type).toBe("checkpoint_created");
    const checkpointId = checkpointMsg.type === "checkpoint_created" ? checkpointMsg.checkpoint.id : "";

    client.send({ type: "list_branches" });
    const branchList = await client.receiveSkipLogs();
    expect(branchList.type).toBe("branch_list");

    client.send({ type: "branch_from_checkpoint", checkpointId, name: "experiment" });
    let switchedSeen = false;
    let listAfterBranch: any = null;
    for (let i = 0; i < 6; i++) {
      const msg = await client.receiveSkipLogs();
      if (msg.type === "branch_switched") switchedSeen = true;
      if (msg.type === "branch_list") listAfterBranch = msg;
      if (switchedSeen && listAfterBranch) break;
    }
    expect(switchedSeen).toBe(true);
    expect(listAfterBranch?.type).toBe("branch_list");

    client.close();
    await app.close();
  });

  it("returns error for invalid checkpoint id", async () => {
    const app = await buildApp({
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      authManager: new StubAuthManager() as unknown as AuthManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const client = await TestClient.connect(port);

    await client.receiveSkipLogs(); // preview_status
    client.send({ type: "branch_from_checkpoint", checkpointId: "missing" });
    const err = await client.receiveSkipLogs();
    expect(err.type).toBe("error");

    client.close();
    await app.close();
  });
});
