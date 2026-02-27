import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
import { GitHubAuthManager } from "../github-auth.js";

import { ClaudeProcess } from "../claude.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

describe("Integration: Image upload", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-imageupload-"));
    lastClaude = undefined as unknown as FakeClaudeProcess;

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(path.join(tmpDir, "sessions.json")),
      chatHistoryManager: new ChatHistoryManager(path.join(tmpDir, "chat-history")),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  // A minimal 1x1 red PNG (valid base64)
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  it("send_message with valid images passes them to ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Make it look like this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "design.png" },
      ],
    });

    await waitForClaude(() => lastClaude);

    // The FakeClaudeProcess should have been called with images
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Make it look like this");
    expect(lastClaude.lastImages).toHaveLength(1);
    expect(lastClaude.lastImages![0].mediaType).toBe("image/png");
    expect(lastClaude.lastImages![0].data).toBe(TINY_PNG_BASE64);

    // Simulate Claude finishing
    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-session-1" });
    lastClaude.finish("img-session-1");

    client.close();
  });

  it("send_message with invalid MIME type returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Upload PDF",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "application/pdf", filename: "doc.pdf" },
      ],
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("unsupported type");

    client.close();
  });

  it("send_message with too many images returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const images = Array.from({ length: 6 }, (_, i) => ({
      data: TINY_PNG_BASE64,
      mediaType: "image/png",
      filename: `img${i}.png`,
    }));

    client.send({
      type: "send_message",
      text: "Too many",
      images,
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Too many images");

    client.close();
  });

  it("send_message with oversized image returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Create a base64 string that decodes to > 5MB
    // Each base64 char = 6 bits, so 4 chars = 3 bytes
    // 5MB = 5242880 bytes -> need ~7000000 base64 chars
    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString("base64");

    client.send({
      type: "send_message",
      text: "Big image",
      images: [
        { data: bigData, mediaType: "image/png", filename: "huge.png" },
      ],
    });

    const msg = await client.receive();
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("too large");

    client.close();
  });

  it("send_message with images persists them in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "Check this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "test.png" },
      ],
    });

    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-persist-test" });

    // Capture the app session UUID from session_started
    let appSessionId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const m = await client.receive();
      if (m.type === "session_started") {
        appSessionId = (m as any).session.id;
        break;
      }
    }
    expect(appSessionId).toBeTruthy();

    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "I see the image" }] },
    });
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "img-persist-test" });
    lastClaude.emit("done", 0);

    // Now load the chat history via HTTP using the app session UUID
    // (chat persistence is synchronous so it's already on disk)
    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${appSessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const chatHistory = historyRes.json();

    expect(chatHistory.messages.length).toBeGreaterThanOrEqual(2);
    // Find the first user message with images
    const userMsg = chatHistory.messages.find((m: any) => m.role === "user" && m.images?.length > 0);
    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe("Check this");
    expect(userMsg.images).toHaveLength(1);
    expect(userMsg.images[0].mediaType).toBe("image/png");

    client.close();
  });

  it("send_message with 0 images works normally (no validation error)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "No images",
      images: [],
    });

    // Should start Claude normally without error
    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("No images");
    expect(lastClaude.lastImages).toBeUndefined();

    lastClaude.finish();
    client.close();
  });
});
