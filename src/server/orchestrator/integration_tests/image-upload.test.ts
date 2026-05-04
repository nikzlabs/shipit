import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../auth.js";
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

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-imageupload-"));
    lastClaude = undefined as unknown as FakeClaudeProcess;

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
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

  // A minimal 1x1 red PNG (valid base64)
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  it("send_message with valid images saves them to uploads and references in prompt", async () => {
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

    // Images are saved to disk by the orchestrator and referenced in the prompt.
    // The agent receives the modified prompt, not inline base64 images.
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toContain("Make it look like this");
    expect(lastClaude.lastPrompt).toContain("<attached_images>");
    expect(lastClaude.lastPrompt).toContain("/uploads/");
    expect(lastClaude.lastPrompt).toContain(".png");
    // Images are NOT passed inline — they're saved to disk instead
    expect(lastClaude.lastImages).toBeUndefined();

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

  it("uploaded image stays at original /uploads/ path so hydration recognizes it as sent", async () => {
    // Regression test for: "Attached image in one turn often reappears as
    // attached in subsequent turn." The previous behavior unlinked the
    // uploaded file from /uploads/ and re-saved it under a randomized name,
    // which broke the round-trip between chat history's `uploadPaths`
    // (original name) and the GET /files/uploads listing (renamed file) —
    // so hydrateUploads couldn't match them and re-marked the image as
    // pending.
    const client = await TestClient.connect(port);
    const sessionId = client.sessionId;
    await client.receive(); // preview_status

    // 1) Upload an image via the upload endpoint (same path the browser uses).
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
    const uploadedPath = uploaded[0].path; // e.g. "/uploads/screenshot.png"
    expect(uploadedPath).toMatch(/^\/uploads\//);

    // 2) Send a message referencing the upload (this is what browser does).
    client.send({
      type: "send_message",
      text: "What's in this image?",
      uploads: [{ path: uploadedPath, type: "upload" }],
    });
    await waitForClaude(() => lastClaude);

    // The agent prompt should reference the ORIGINAL upload path (not a
    // renamed copy). This is what makes uploadPaths in chat history
    // match the actual file on disk.
    expect(lastClaude.lastPrompt).toContain("<attached_images>");
    expect(lastClaude.lastPrompt).toContain(uploadedPath);

    lastClaude.emit("event", { type: "system", subtype: "init", session_id: "img-hydrate-test" });
    lastClaude.emit("event", { type: "result", subtype: "success", session_id: "img-hydrate-test" });
    lastClaude.emit("done", 0);

    // 3) The original uploaded file MUST still exist on disk (we used to unlink it).
    const listRes = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads`,
    });
    expect(listRes.statusCode).toBe(200);
    const { files: onDisk } = listRes.json() as { files: { path: string }[] };
    const onDiskPaths = onDisk.map((f) => f.path);
    expect(onDiskPaths).toContain(uploadedPath);
    // No phantom renamed duplicate should have been created.
    expect(onDiskPaths).toHaveLength(1);

    // 4) Chat history must record the same path under uploadPaths so the
    //    client-side hydrateUploads can match them.
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
