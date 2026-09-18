import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: Image upload", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;
  let sessions: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-imageupload-"));
    sessions = new SessionManager(dbManager);
    lastClaude = undefined as unknown as FakeClaudeProcess;

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: sessions,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  it("send_message with valid images saves them to uploads and references in prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Make it look like this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "design.png" },
      ],
    });

    await waitForClaude(() => lastClaude);

    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toContain("Make it look like this");
    expect(lastClaude.lastPrompt).toContain("<attached_images>");
    expect(lastClaude.lastPrompt).toContain("/uploads/");
    expect(lastClaude.lastPrompt).toContain(".png");
    expect(lastClaude.lastImages).toBeUndefined();

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-session-1" });
    lastClaude.finish("img-session-1");

    client.close();
  });

  it("refuses an image when the session is pinned to a text-only model (planning#460)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setModelSelection(client.sessionId, {
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "deepseek/deepseek-v4-flash",
    });

    client.send({
      type: "send_message",
      text: "What is in this screenshot?",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "shot.png" },
      ],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("V4 Flash");
    expect((msg as any).message).toContain("cannot read images");
    expect(lastClaude).toBeFalsy();

    client.close();
  });

  it("refuses the composer's shape too — an image arrives as an upload ref (planning#460)", async () => {
    // Extension-based rejection must work before the upload is read from disk.
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setModelSelection(client.sessionId, {
      serviceId: "zai",
      billingMode: "sub",
      modelId: "glm-5.2[1m]",
    });

    client.send({
      type: "send_message",
      text: "What is in this screenshot?",
      uploads: [{ path: "/uploads/shot.png", type: "upload" }],
    });

    const msg = await client.receiveType("error");
    expect((msg as any).message).toContain("GLM-5.2");
    expect(lastClaude).toBeFalsy();

    client.close();
  });

  it("still sends the image when the pinned model can see (planning#460)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setModelSelection(client.sessionId, {
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-sonnet-5",
    });

    client.send({
      type: "send_message",
      text: "What is in this screenshot?",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "shot.png" },
      ],
    });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toContain("<attached_images>");

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-vision-ok" });
    lastClaude.finish("img-vision-ok");
    client.close();
  });

  it("send_message with invalid MIME type returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Upload PDF",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "application/pdf", filename: "doc.pdf" },
      ],
    });

    const msg = await client.receiveType("error");
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("unsupported type");

    client.close();
  });

  it("send_message with too many images returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

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

    const msg = await client.receiveType("error");
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Too many images");

    client.close();
  });

  it("send_message with oversized image returns error", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const bigData = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41).toString("base64");

    client.send({
      type: "send_message",
      text: "Big image",
      images: [
        { data: bigData, mediaType: "image/png", filename: "huge.png" },
      ],
    });

    const msg = await client.receiveType("error");
    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("too large");

    client.close();
  });

  it("send_message with images persists them in chat history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "Check this",
      images: [
        { data: TINY_PNG_BASE64, mediaType: "image/png", filename: "test.png" },
      ],
    });

    await waitForClaude(() => lastClaude);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-persist-test" });

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

    const historyRes = await app.inject({ method: "GET", url: `/api/sessions/${appSessionId}/history` });
    expect(historyRes.statusCode).toBe(200);
    const chatHistory = historyRes.json();

    expect(chatHistory.messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = chatHistory.messages.find((m: any) => m.role === "user" && m.images?.length > 0);
    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe("Check this");
    expect(userMsg.images).toHaveLength(1);
    expect(userMsg.images[0].mediaType).toBe("image/png");

    client.close();
  });

  it("uploaded image stays at original /uploads/ path so hydration recognizes it as sent", async () => {
    const client = await TestClient.connect(port);
    const sessionId = client.sessionId;
    await client.receive();

    const crypto = await import("node:crypto");
    const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
    const fileBuf = Buffer.from(TINY_PNG_BASE64, "base64");
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="screenshot.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
      ),
      fileBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/files/uploads`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(uploadRes.statusCode).toBe(200);
    const { files: uploaded } = uploadRes.json() as { files: { path: string; name: string }[] };
    expect(uploaded).toHaveLength(1);
    const uploadedPath = uploaded[0].path;
    expect(uploadedPath).toMatch(/^\/uploads\//);

    client.send({
      type: "send_message",
      text: "What's in this image?",
      uploads: [{ path: uploadedPath, type: "upload" }],
    });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastPrompt).toContain("<attached_images>");
    expect(lastClaude.lastPrompt).toContain(uploadedPath);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-hydrate-test" });
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "img-hydrate-test" });
    lastClaude.emit("done", 0);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads`,
    });
    expect(listRes.statusCode).toBe(200);
    const { files: onDisk } = listRes.json() as { files: { path: string }[] };
    const onDiskPaths = onDisk.map((f) => f.path);
    expect(onDiskPaths).toContain(uploadedPath);
    expect(onDiskPaths).toHaveLength(1);

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/history`,
    });
    expect(historyRes.statusCode).toBe(200);
    const chatHistory = historyRes.json() as { messages: { role: string; uploadPaths?: string[] }[] };
    const userMsg = chatHistory.messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.uploadPaths).toEqual([uploadedPath]);

    client.close();
  });

  it("send_message with 0 images works normally (no validation error)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({
      type: "send_message",
      text: "No images",
      images: [],
    });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("No images");
    expect(lastClaude.lastImages).toBeUndefined();

    lastClaude.finish();
    client.close();
  });
});
