/**
 * Integration test for lazy transcript bodies (docs/244, SHI-267).
 *
 * Drives the real orchestrator so the whole round-trip is exercised: a
 * transcript containing a megabyte tool output, a Write with a big file body,
 * and a base64 screenshot is persisted whole, served light, and the removed
 * bodies are fetchable from the three endpoints.
 *
 * The load-bearing assertion is the last one: serving the transcript must not
 * change what is stored. The projection sits next to `ChatHistoryManager`,
 * whose `fromRow` feeds several read-modify-write paths — putting the slice
 * there would make an ordinary card update silently persist the truncation and
 * destroy the body permanently. This test would catch that.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import {
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { ChatHistoryManager } from "../chat-history.js";
import { imageHash } from "../transcript-projection.js";
import { TRANSCRIPT_SLICE_LINES } from "../../shared/transcript-slice.js";

const HEAVY_OUTPUT = Array.from({ length: 40_000 }, (_, i) => `stdout line ${i}`).join("\n");
const FILE_BODY = Array.from({ length: 2_000 }, (_, i) => `const x${i} = ${i};`).join("\n");
const SCREENSHOT = Buffer.from("x".repeat(200_000)).toString("base64");

describe("Integration: lazy transcript bodies (SHI-267)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let history: ChatHistoryManager;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-bodies-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    history = new ChatHistoryManager(dbManager);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      chatHistoryManager: history,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;

    history.append(sessionId, {
      role: "user",
      text: "here is a screenshot",
      images: [{ data: SCREENSHOT, mediaType: "image/png" }],
    });
    history.append(sessionId, {
      role: "assistant",
      text: "running it",
      toolUse: [
        { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/a.ts", content: FILE_BODY } },
        { type: "tool_use", id: "task-1", name: "Task", input: { prompt: "review" } },
      ],
      toolResults: [
        { toolUseId: "bash-1", content: HEAVY_OUTPUT },
        { toolUseId: "write-1", content: "ok" },
        { toolUseId: "task-1", content: HEAVY_OUTPUT },
      ],
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function loadHistory() {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    return res.json() as {
      messages: {
        images?: { data?: string; src?: string }[];
        toolUse?: { id: string; name: string; input: Record<string, unknown>; bodyTruncated?: true; diffStats?: { added: number; removed: number } }[];
        toolResults?: { toolUseId: string; content: string; truncated?: true; totalLines?: number }[];
      }[];
    };
  }

  it("serves a transcript far smaller than what it stores (req 1)", async () => {
    // The direct assertion of requirement 1: nothing goes over the wire that
    // isn't visible without a click. Stored is >1 MB of bodies; served has to
    // be a small multiple of what the transcript actually draws.
    const stored = JSON.stringify(history.load(sessionId)).length;
    expect(stored).toBeGreaterThan(1_000_000);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const served = res.rawPayload.length;

    // The Task result is exempt (its final report renders whole), so it
    // dominates the served size; everything else is bounded by the slice.
    expect(served).toBeLessThan(stored / 2);

    // And none of the three heavy bodies appears in the payload beyond its slice.
    const body = res.rawPayload.toString("utf8");
    expect(body).not.toContain(SCREENSHOT.slice(0, 200));
    expect(body).not.toContain(FILE_BODY.slice(-200));
  });

  it("slices a heavy tool result and keeps the metadata the UI needs", async () => {
    const { messages } = await loadHistory();
    const bash = messages[1]!.toolResults!.find((r) => r.toolUseId === "bash-1")!;
    expect(bash.truncated).toBe(true);
    expect(bash.totalLines).toBe(40_000);
    expect(bash.content.split("\n")).toHaveLength(TRANSCRIPT_SLICE_LINES);
    expect(HEAVY_OUTPUT.startsWith(bash.content)).toBe(true);
  });

  it("never slices the subagent final report", async () => {
    const { messages } = await loadHistory();
    const task = messages[1]!.toolResults!.find((r) => r.toolUseId === "task-1")!;
    expect(task.truncated).toBeUndefined();
    expect(task.content).toBe(HEAVY_OUTPUT);
  });

  it("strips the Write body but keeps the +N -M the diff summary draws", async () => {
    const { messages } = await loadHistory();
    const write = messages[1]!.toolUse!.find((t) => t.id === "write-1")!;
    expect(write.bodyTruncated).toBe(true);
    expect(write.input.content).toBeUndefined();
    expect(write.diffStats).toEqual({ added: 2_000, removed: 0 });
    expect(write.input.file_path).toBe("/a.ts");
  });

  it("replaces the image payload with a content-addressed URL", async () => {
    const { messages } = await loadHistory();
    const img = messages[0]!.images![0]!;
    expect(img.data).toBeUndefined();
    expect(img.src).toBe(`/api/sessions/${sessionId}/images/${imageHash(SCREENSHOT)}`);
  });

  it("serves the full tool-result body from the fetch endpoint", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe(HEAVY_OUTPUT);
  });

  it("serves the stripped Write body from the fetch endpoint", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/write-1` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe(FILE_BODY);
  });

  it("serves the image, immutably cached", async () => {
    const hash = imageHash(SCREENSHOT);
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/images/${hash}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers.etag).toBe(`"${hash}"`);
    expect(res.rawPayload.toString("base64")).toBe(SCREENSHOT);

    const revalidated = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/images/${hash}`,
      headers: { "if-none-match": `"${hash}"` },
    });
    expect(revalidated.statusCode).toBe(304);
  });

  it("404s on an unknown id rather than serving something else", async () => {
    for (const url of [
      `/api/sessions/${sessionId}/tool-results/nope`,
      `/api/sessions/${sessionId}/tool-inputs/nope`,
      `/api/sessions/${sessionId}/images/${"0".repeat(64)}`,
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });

  it("does not persist the projection — serving must not narrow storage", async () => {
    // The regression guard for the single most dangerous way to build this:
    // slicing inside `fromRow`, which several read-modify-write paths would
    // then write straight back to disk.
    await loadHistory();
    await loadHistory();

    const stored = history.load(sessionId);
    const results = (stored[1] as { toolResults: { toolUseId: string; content: string }[] }).toolResults;
    expect(results.find((r) => r.toolUseId === "bash-1")!.content).toBe(HEAVY_OUTPUT);
    const tools = (stored[1] as { toolUse: { id: string; input: Record<string, unknown> }[] }).toolUse;
    expect(tools.find((t) => t.id === "write-1")!.input.content).toBe(FILE_BODY);
    const images = (stored[0] as { images: { data: string }[] }).images;
    expect(images[0]!.data).toBe(SCREENSHOT);

    // And the endpoints still return the whole thing after those loads.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` });
    expect((res.json() as { content: string }).content).toBe(HEAVY_OUTPUT);
  });
});
