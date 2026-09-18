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
import { parseSubagentReport } from "../../shared/subagent-report.js";
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
import { COMMAND_SUMMARY_CHARS } from "../../shared/transcript-input-policy.js";

const HEAVY_OUTPUT = Array.from({ length: 40_000 }, (_, i) => `stdout line ${i}`).join("\n");
const FILE_BODY = Array.from({ length: 2_000 }, (_, i) => `const x${i} = ${i};`).join("\n");
const SCREENSHOT = Buffer.from("x".repeat(200_000)).toString("base64");
const SUBAGENT_REPORT = Array.from({ length: 5_000 }, (_, i) => `finding ${i}`).join("\n");
const CONSULT_OUTPUT = Array.from({ length: 5_000 }, (_, i) => `review note ${i}`).join("\n");
const HEAVY_COMMAND = `gh pr create --body-file - <<'EOF'\n${Array.from({ length: 800 }, (_, i) => `body line ${i}`).join("\n")}\nEOF`;
const TASK_PROMPT = Array.from({ length: 400 }, (_, i) => `instruction ${i}`).join("\n");
const PLAN_BODY = Array.from({ length: 300 }, (_, i) => `## Step ${i}`).join("\n");

describe("Integration: lazy transcript bodies (planning#269)", () => {
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
        { type: "tool_use", id: "bash-1", name: "Bash", input: { command: HEAVY_COMMAND } },
        { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/a.ts", content: FILE_BODY } },
        { type: "tool_use", id: "plan-1", name: "Write", input: { file_path: "/w/.claude/plans/p.md", content: PLAN_BODY } },
        { type: "tool_use", id: "task-1", name: "Task", input: { description: "review", prompt: TASK_PROMPT } },
      ],
      toolResults: [
        { toolUseId: "bash-1", content: HEAVY_OUTPUT },
        { toolUseId: "write-1", content: "ok" },
        { toolUseId: "plan-1", content: "ok" },
        { toolUseId: "task-1", content: SUBAGENT_REPORT },
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
        toolUse?: {
          id: string;
          name: string;
          input: Record<string, unknown>;
          bodyTruncated?: true;
          diffStats?: { added: number; removed: number };
          inputChars?: Record<string, number>;
        }[];
        toolResults?: { toolUseId: string; content: string; truncated?: true; totalLines?: number }[];
      }[];
    };
  }

  it("serves a transcript far smaller than what it stores (req 1)", async () => {
    const stored = JSON.stringify(history.load(sessionId)).length;
    expect(stored).toBeGreaterThan(1_000_000);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const served = res.rawPayload.length;

    expect(served).toBeLessThan(stored / 2);

    const body = res.rawPayload.toString("utf8");
    expect(body).not.toContain(SCREENSHOT.slice(0, 200));
    expect(body).not.toContain(FILE_BODY.slice(-200));
    expect(body).not.toContain("stdout line 0");
    expect(body).not.toContain("stdout line 39999");
    expect(body).not.toContain("body line 799");
    expect(body).not.toContain("instruction 399");
    expect(body).not.toContain("finding 4999");
    expect(body).toContain("finding 0");
  });

  it("ships no body at all for a modal-only result, keeping only its metadata", async () => {
    const { messages } = await loadHistory();
    const bash = messages[1]!.toolResults!.find((r) => r.toolUseId === "bash-1")!;
    expect(bash.content).toBe("");
    expect(bash.truncated).toBe(true);
    expect(bash.totalLines).toBe(40_000);
  });

  it("serves the clamped head of the subagent final report, not the whole thing", async () => {
    const { messages } = await loadHistory();
    const task = messages[1]!.toolResults!.find((r) => r.toolUseId === "task-1")!;

    expect(task.truncated).toBe(true);
    expect(task.totalLines).toBe(5_000);
    expect(task.content).not.toBe("");
    expect(SUBAGENT_REPORT.startsWith(task.content)).toBe(true);
    expect(task.content.length).toBeLessThan(SUBAGENT_REPORT.length / 100);
  });

  it("serves the whole report from the fetch endpoint the modal opens", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/tool-results/task-1`,
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe(SUBAGENT_REPORT);
  });

  it("strips the Write body but keeps the +N -M the diff summary draws", async () => {
    const { messages } = await loadHistory();
    const write = messages[1]!.toolUse!.find((t) => t.id === "write-1")!;
    expect(write.bodyTruncated).toBe(true);
    expect(write.input.content).toBeUndefined();
    expect(write.diffStats).toEqual({ added: 2_000, removed: 0 });
    expect(write.input.file_path).toBe("/a.ts");
  });

  it("ships only the characters of a command the tool line draws", async () => {
    const { messages } = await loadHistory();
    const bash = messages[1]!.toolUse!.find((t) => t.id === "bash-1")!;
    expect(bash.input.command).toBe(HEAVY_COMMAND.slice(0, COMMAND_SUMMARY_CHARS));
    expect(bash.inputChars).toEqual({ command: HEAVY_COMMAND.length });
    expect(bash.bodyTruncated).toBe(true);
  });

  it("drops a subagent prompt but keeps the length its toggle is labelled with", async () => {
    const { messages } = await loadHistory();
    const task = messages[1]!.toolUse!.find((t) => t.id === "task-1")!;
    expect(task.input.prompt).toBeUndefined();
    expect(task.inputChars?.prompt).toBe(TASK_PROMPT.length);
    expect(task.input.description).toBe("review");
  });

  it("keeps a plan document's body, which the transcript renders inline", async () => {
    const { messages } = await loadHistory();
    const plan = messages[1]!.toolUse!.find((t) => t.id === "plan-1")!;
    expect(plan.input.content).toBe(PLAN_BODY);
    expect(plan.bodyTruncated).toBeUndefined();
  });

  it("serves the whole command back from the fetch endpoint", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/bash-1` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { input: { command: string } }).input.command).toBe(HEAVY_COMMAND);
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

  it("serves the whole stored input from the fetch endpoint", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/write-1` });
    expect(res.statusCode).toBe(200);
    const { input } = res.json() as { input: Record<string, unknown> };
    expect(input.content).toBe(FILE_BODY);
    expect(input.file_path).toBe("/a.ts");
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

  it("resolves ids nested inside a subagent, not just top-level ones", async () => {
    history.append(sessionId, {
      role: "assistant",
      text: "delegating",
      toolUse: [{ type: "tool_use", id: "task-2", name: "Task", input: { prompt: "go" } }],
      subagentEvents: [
        {
          kind: "assistant",
          parentToolUseId: "task-2",
          text: "writing it",
          toolUse: [
            { type: "tool_use", id: "sub-bash-1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "sub-write-1", name: "Write", input: { file_path: "/b.ts", content: FILE_BODY } },
          ],
        },
        {
          kind: "tool_result",
          parentToolUseId: "task-2",
          toolResults: [{ toolUseId: "sub-bash-1", content: HEAVY_OUTPUT }],
        },
      ],
    });

    const { messages } = await loadHistory();
    const nested = messages.at(-1) as unknown as {
      subagentEvents: { kind: string; toolUse?: { id: string; bodyTruncated?: true; diffStats?: { added: number; removed: number } }[]; toolResults?: { toolUseId: string; truncated?: true; totalLines?: number }[] }[];
    };
    const nestedResult = nested.subagentEvents.find((e) => e.kind === "tool_result")!.toolResults![0]!;
    expect(nestedResult.truncated).toBe(true);
    expect(nestedResult.totalLines).toBe(40_000);

    const nestedWrite = nested.subagentEvents.find((e) => e.kind === "assistant")!.toolUse!.find((t) => t.id === "sub-write-1")!;
    expect(nestedWrite.bodyTruncated).toBe(true);
    expect(nestedWrite.diffStats).toEqual({ added: 2_000, removed: 0 });

    const result = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/sub-bash-1` });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { content: string }).content).toBe(HEAVY_OUTPUT);

    const input = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/sub-write-1` });
    expect(input.statusCode).toBe(200);
    expect((input.json() as { input: { content: string } }).input.content).toBe(FILE_BODY);
  });

  it("a rewind takes the row and its body away together", async () => {
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` })).statusCode).toBe(200);

    history.truncate(sessionId, 1);

    const { messages } = await loadHistory();
    expect(messages).toHaveLength(1);
    expect(messages.some((m) => m.toolResults?.some((r) => r.toolUseId === "bash-1"))).toBe(false);

    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` })).statusCode).toBe(404);
  });

  it("serves a tool-result image whose block omits source.type", async () => {
    const png = Buffer.from("nested-png-bytes").toString("base64");
    history.append(sessionId, {
      role: "assistant",
      text: "shot",
      toolUse: [{ type: "tool_use", id: "shot-1", name: "mcp__playwright__browser_take_screenshot", input: {} }],
      toolResults: [{
        toolUseId: "shot-1",
        content: JSON.stringify([
          { type: "text", text: "captured" },
          { type: "image", source: { data: png, media_type: "image/png" } },
        ]),
      }],
    });

    const { messages } = await loadHistory();
    const served = messages.at(-1)!.toolResults!.find((r) => r.toolUseId === "shot-1")!;
    const url = (JSON.parse(served.content) as { source?: { shipit_url?: string } }[])
      .find((b) => b.source?.shipit_url)!.source!.shipit_url!;

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString("base64")).toBe(png);
  });

  it("serves an image whose block type is JSON-escaped", async () => {
    const png = Buffer.from("escaped-png-bytes").toString("base64");
    history.append(sessionId, {
      role: "assistant",
      text: "shot",
      toolUse: [{ type: "tool_use", id: "shot-2", name: "mcp__playwright__browser_take_screenshot", input: {} }],
      toolResults: [{
        toolUseId: "shot-2",
        content: `[{"type":"im\\u0061ge","source":{"data":"${png}","media_type":"image/png"}}]`,
      }],
    });

    const { messages } = await loadHistory();
    const served = messages.at(-1)!.toolResults!.find((r) => r.toolUseId === "shot-2")!;
    const url = (JSON.parse(served.content) as { source?: { shipit_url?: string } }[])
      .find((b) => b.source?.shipit_url)!.source!.shipit_url!;

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString("base64")).toBe(png);
  });

  it("substitutes images in the fetched tool-result body instead of re-sending base64", async () => {
    const png = Buffer.from("modal-fetch-png-bytes").toString("base64");
    history.append(sessionId, {
      role: "assistant",
      text: "shot",
      toolUse: [{ type: "tool_use", id: "shot-3", name: "mcp__playwright__browser_take_screenshot", input: {} }],
      toolResults: [{
        toolUseId: "shot-3",
        content: JSON.stringify([
          { type: "text", text: "### Result\ncaptured the viewport" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ]),
      }],
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/shot-3` });
    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    expect(content).not.toContain(png);
    expect(content).toContain("captured the viewport");
    const url = (JSON.parse(content) as { source?: { shipit_url?: string } }[])
      .find((b) => b.source?.shipit_url)!.source!.shipit_url!;
    const img = await app.inject({ method: "GET", url });
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.toString("base64")).toBe(png);
  });

  it("keeps a report's accounting footer a separate block when substituting its images", async () => {
    const png = Buffer.from("report-png-bytes").toString("base64");
    const footer = "subagent_tokens: 4210\ntool_uses: 7\nduration_ms: 91000";
    history.append(sessionId, {
      role: "assistant",
      text: "task",
      toolUse: [{ type: "tool_use", id: "task-img", name: "Task", input: { description: "d" } }],
      toolResults: [{
        toolUseId: "task-img",
        content: JSON.stringify([
          { type: "text", text: "Here is what I found.\nIt took a while." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: footer },
        ]),
      }],
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/task-img` });
    expect(res.statusCode).toBe(200);
    const { content } = res.json() as { content: string };
    expect(content).not.toContain(png);

    const { text, meta } = parseSubagentReport(content);
    expect(meta).toBe(footer);
    expect(text).toBe("Here is what I found.\nIt took a while.");
  });

  it("does not 304 an image that doesn't exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/images/${"0".repeat(64)}`,
      headers: { "if-none-match": `"${"0".repeat(64)}"` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s on an unknown id rather than serving something else", async () => {
    for (const url of [
      `/api/sessions/${sessionId}/tool-results/nope`,
      `/api/sessions/${sessionId}/tool-inputs/nope`,
      `/api/sessions/${sessionId}/sub-agent-consults/nope`,
      `/api/sessions/${sessionId}/images/${"0".repeat(64)}`,
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });

  it("serves a sub-agent consult as its preview line, with the output behind a fetch (planning#299)", async () => {
    history.append(sessionId, {
      role: "assistant",
      text: "",
      subAgentConsult: {
        cardId: "consult-1",
        spawnId: "spawn-1",
        subAgentId: "codex",
        status: "success",
        durationMs: 900_000,
        costUsd: 0,
        outputMarkdown: CONSULT_OUTPUT,
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const card = (res.json() as { messages: { subAgentConsult?: {
      outputMarkdown?: string; outputTruncated?: true; status: string; durationMs?: number;
    } }[] }).messages.at(-1)!.subAgentConsult!;

    expect(card.outputTruncated).toBe(true);
    expect(card.outputMarkdown!.length).toBeLessThan(200);
    expect(res.rawPayload.toString("utf8")).not.toContain("review note 4999");
    expect(res.rawPayload.toString("utf8")).toContain("finding 0");
    expect(res.rawPayload.toString("utf8")).not.toContain("review note 0\nreview note 1");
    expect(card.status).toBe("success");
    expect(card.durationMs).toBe(900_000);

    const full = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/sub-agent-consults/consult-1` });
    expect(full.statusCode).toBe(200);
    expect((full.json() as { outputMarkdown: string }).outputMarkdown).toBe(CONSULT_OUTPUT);

    expect(history.listSubAgentConsultCards(sessionId)[0]!.outputMarkdown).toBe(CONSULT_OUTPUT);
  });

  it("a read-modify-write updater does not write back a sliced body", async () => {
    // Updating one field rewrites the row; decoded bodies must remain complete.
    await loadHistory();

    history.updateLastMessage(sessionId, { commitHash: "abc123" });

    const stored = history.load(sessionId);
    const last = stored[stored.length - 1] as {
      commitHash?: string;
      toolResults?: { toolUseId: string; content: string }[];
      toolUse?: { id: string; input: Record<string, unknown> }[];
    };
    expect(last.commitHash).toBe("abc123");
    expect(last.toolResults!.find((r) => r.toolUseId === "bash-1")!.content).toBe(HEAVY_OUTPUT);
    expect(last.toolUse!.find((t) => t.id === "write-1")!.input.content).toBe(FILE_BODY);
  });

  it("does not persist the projection — serving must not narrow storage", async () => {
    await loadHistory();
    await loadHistory();

    const stored = history.load(sessionId);
    const results = (stored[1] as { toolResults: { toolUseId: string; content: string }[] }).toolResults;
    expect(results.find((r) => r.toolUseId === "bash-1")!.content).toBe(HEAVY_OUTPUT);
    const tools = (stored[1] as { toolUse: { id: string; input: Record<string, unknown> }[] }).toolUse;
    expect(tools.find((t) => t.id === "write-1")!.input.content).toBe(FILE_BODY);
    const images = (stored[0] as { images: { data: string }[] }).images;
    expect(images[0]!.data).toBe(SCREENSHOT);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` });
    expect((res.json() as { content: string }).content).toBe(HEAVY_OUTPUT);
  });
});
