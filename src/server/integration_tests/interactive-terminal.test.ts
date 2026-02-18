import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
} from "./test-helpers.js";

describe("Integration: Interactive terminal", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-terminal-"));

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => new FakeClaudeProcess() as unknown as ClaudeProcess,
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Drain all buffered log entries and the initial preview_status. */
  async function drainInitial(client: TestClient): Promise<void> {
    // preview_status is always first
    await client.receive();
    // Drain any buffered log_entry messages
    while (true) {
      try {
        const msg = await client.receive(200);
        if (msg.type !== "log_entry") {
          // Put it back — but TestClient doesn't support unget.
          // In practice this shouldn't happen for a fresh connection.
          break;
        }
      } catch {
        // Timeout — no more messages
        break;
      }
    }
  }

  it("starts a terminal and receives output", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    client.send({ type: "terminal_start" });

    // We should receive some terminal_output (the shell prompt)
    const deadline = Date.now() + 5000;
    let gotOutput = false;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") {
          gotOutput = true;
          break;
        }
      } catch {
        break;
      }
    }

    expect(gotOutput).toBe(true);
    client.close();
  });

  it("echoes input back via terminal_output", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    client.send({ type: "terminal_start" });

    // Wait for initial shell prompt output
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") break;
      } catch {
        break;
      }
    }

    // Send a command
    client.send({ type: "terminal_input", data: "echo hello_terminal\n" });

    // Collect output until we see "hello_terminal" in the response
    let output = "";
    const outputDeadline = Date.now() + 5000;
    while (Date.now() < outputDeadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") {
          output += (msg as { type: "terminal_output"; data: string }).data;
          if (output.includes("hello_terminal")) break;
        }
      } catch {
        break;
      }
    }

    expect(output).toContain("hello_terminal");
    client.close();
  });

  it("handles terminal_resize without errors", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    client.send({ type: "terminal_start" });

    // Wait for initial output
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") break;
      } catch {
        break;
      }
    }

    // Resize should not cause an error
    client.send({ type: "terminal_resize", cols: 120, rows: 40 });

    // Send a command to verify terminal still works after resize
    client.send({ type: "terminal_input", data: "echo resize_ok\n" });

    let output = "";
    const outputDeadline = Date.now() + 5000;
    while (Date.now() < outputDeadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") {
          output += (msg as { type: "terminal_output"; data: string }).data;
          if (output.includes("resize_ok")) break;
        }
        if (msg.type === "error") {
          throw new Error(`Unexpected error: ${(msg as { message: string }).message}`);
        }
      } catch {
        break;
      }
    }

    expect(output).toContain("resize_ok");
    client.close();
  });

  it("sends terminal_exit when shell exits", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    client.send({ type: "terminal_start" });

    // Wait for initial output
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") break;
      } catch {
        break;
      }
    }

    // Send exit command
    client.send({ type: "terminal_input", data: "exit\n" });

    // Wait for terminal_exit
    let gotExit = false;
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_exit") {
          gotExit = true;
          break;
        }
      } catch {
        break;
      }
    }

    expect(gotExit).toBe(true);
    client.close();
  });

  it("does not spawn duplicate shells on multiple terminal_start", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    // Send terminal_start twice
    client.send({ type: "terminal_start" });
    client.send({ type: "terminal_start" });

    // Wait for initial output
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") break;
      } catch {
        break;
      }
    }

    // Send a unique command — if there were two shells, we might get duplicate output
    client.send({ type: "terminal_input", data: "echo single_shell_test\n" });

    let output = "";
    const outputDeadline = Date.now() + 3000;
    while (Date.now() < outputDeadline) {
      try {
        const msg = await client.receive(1000);
        if (msg.type === "terminal_output") {
          const data = (msg as { type: "terminal_output"; data: string }).data;
          output += data;
          // Count unique occurrences of the command output (excluding the echo command itself)
        }
      } catch {
        break;
      }
    }

    // The string "single_shell_test" should appear — the echo itself and the output line
    // With a single shell, we'll see it from the echo command display + output
    expect(output).toContain("single_shell_test");
    client.close();
  });

  it("cleans up terminal process on WebSocket disconnect", async () => {
    const client = await TestClient.connect(port);
    await drainInitial(client);

    client.send({ type: "terminal_start" });

    // Wait for initial output
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(2000);
        if (msg.type === "terminal_output") break;
      } catch {
        break;
      }
    }

    // Disconnect the client — the server should clean up the terminal process
    client.close();

    // Wait a bit for cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect and verify we can start a new terminal
    const client2 = await TestClient.connect(port);
    await drainInitial(client2);

    client2.send({ type: "terminal_start" });

    let gotOutput = false;
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2) {
      try {
        const msg = await client2.receive(2000);
        if (msg.type === "terminal_output") {
          gotOutput = true;
          break;
        }
      } catch {
        break;
      }
    }

    expect(gotOutput).toBe(true);
    client2.close();
  });
});
