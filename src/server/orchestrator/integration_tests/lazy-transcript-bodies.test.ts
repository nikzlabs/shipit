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

const HEAVY_OUTPUT = Array.from({ length: 40_000 }, (_, i) => `stdout line ${i}`).join("\n");
const FILE_BODY = Array.from({ length: 2_000 }, (_, i) => `const x${i} = ${i};`).join("\n");
const SCREENSHOT = Buffer.from("x".repeat(200_000)).toString("base64");
// Distinct from HEAVY_OUTPUT on purpose: the Task result is the exempt subagent
// report and MUST still ship whole, so the assertions below can only tell the
// two cases apart if their bodies differ.
const SUBAGENT_REPORT = Array.from({ length: 5_000 }, (_, i) => `finding ${i}`).join("\n");
// A cross-agent consult's verbatim output (SHI-297). Deliberately distinct from
// SUBAGENT_REPORT above, which is EXEMPT and must still ship whole in the same
// payload — so an "is it on the wire?" assertion can tell the two apart.
const CONSULT_OUTPUT = Array.from({ length: 5_000 }, (_, i) => `review note ${i}`).join("\n");

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

    // None of the three heavy bodies appears in the payload at all. The Bash
    // output can now be asserted absolutely rather than "beyond its slice":
    // nothing renders it without a click, so not one line of it ships.
    const body = res.rawPayload.toString("utf8");
    expect(body).not.toContain(SCREENSHOT.slice(0, 200));
    expect(body).not.toContain(FILE_BODY.slice(-200));
    expect(body).not.toContain("stdout line 0");
    expect(body).not.toContain("stdout line 39999");
    // ...while the exempt subagent report still ships whole, since the
    // transcript renders it inline with no expand affordance.
    expect(body).toContain("finding 4999");
  });

  it("ships no body at all for a modal-only result, keeping only its metadata", async () => {
    // Requirement 1 at full strength: a Bash result is drawn nowhere until the
    // tool-call modal opens, so the transcript carries none of it. What stays
    // is exactly the metadata requirement 3 names, plus the line count the
    // modal's expander needs.
    const { messages } = await loadHistory();
    const bash = messages[1]!.toolResults!.find((r) => r.toolUseId === "bash-1")!;
    expect(bash.content).toBe("");
    expect(bash.truncated).toBe(true);
    expect(bash.totalLines).toBe(40_000);
  });

  it("never slices the subagent final report", async () => {
    const { messages } = await loadHistory();
    const task = messages[1]!.toolResults!.find((r) => r.toolUseId === "task-1")!;
    expect(task.truncated).toBeUndefined();
    expect(task.content).toBe(SUBAGENT_REPORT);
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

  it("resolves ids nested inside a subagent, not just top-level ones", async () => {
    // A Task's innards are rendered by the same components as top-level tools,
    // so they get sliced the same way — which means the fetch endpoints have to
    // find them too. They live in the `subagent_events` column, not
    // `tool_results`/`tool_use`, so a lookup that only scanned the top level
    // would strip these bodies and then 404 on the expand.
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

    // Served light…
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

    // …and both bodies are still reachable by their own tool-use ids.
    const result = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/sub-bash-1` });
    expect(result.statusCode).toBe(200);
    expect((result.json() as { content: string }).content).toBe(HEAVY_OUTPUT);

    const input = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-inputs/sub-write-1` });
    expect(input.statusCode).toBe(200);
    expect((input.json() as { content: string }).content).toBe(FILE_BODY);
  });

  it("a rewind takes the row and its body away together", async () => {
    // The requirements resolved "what shows when a body is no longer
    // fetchable?" as a false premise: a chat rewind deletes the rows, and the
    // client drops the same rows from the transcript in the same handler, so
    // the expand affordance disappears with the row it belonged to. That
    // invariant is what makes a 404 an ordinary error rather than a state the
    // UI has to design for — so it is worth pinning rather than assuming.
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` })).statusCode).toBe(200);

    // Keep only the opening user message — the assistant row owning bash-1 goes.
    history.truncate(sessionId, 1);

    const { messages } = await loadHistory();
    expect(messages).toHaveLength(1);
    expect(messages.some((m) => m.toolResults?.some((r) => r.toolUseId === "bash-1"))).toBe(false);

    // No visible row references it any more, so the now-404 is unreachable
    // from the UI rather than a dangling affordance.
    expect((await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/tool-results/bash-1` })).statusCode).toBe(404);
  });

  it("serves a tool-result image whose block omits source.type", async () => {
    // The projection substitutes any image block carrying `source.data`, so the
    // lookup has to recognise the same set. It used to pre-filter on the
    // literal text "base64" — which this shape does not contain — so the
    // projection handed the client an /images/ URL that then 404'd forever.
    // MCP image results in the wild take this shape (see ToolResult.test.tsx).
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

    // The URL the client is actually handed, taken from the served transcript
    // rather than reconstructed — so this fails if the two ever disagree.
    const { messages } = await loadHistory();
    const served = messages.at(-1)!.toolResults!.find((r) => r.toolUseId === "shot-1")!;
    const url = (JSON.parse(served.content) as { source?: { shipit_url?: string } }[])
      .find((b) => b.source?.shipit_url)!.source!.shipit_url!;

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.toString("base64")).toBe(png);
  });

  it("serves an image whose block type is JSON-escaped", async () => {
    // The projection's test is semantic — parse, then check `type === "image"`.
    // Any lexical pre-filter in the lookup is therefore a different predicate,
    // and the gap between them is a permanent 404. `"image"` is valid JSON
    // that parses to exactly "image", so it is projected but was invisible to a
    // substring check. This is the shape that proves the two agree.
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

  it("does not 304 an image that doesn't exist", async () => {
    // A conditional request carries the client's own ETag, so matching on it
    // alone answers "not modified" for anything — including a hash the session
    // has never held. The existence check has to come first.
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

  it("serves a sub-agent consult as its preview line, with the output behind a fetch (SHI-297)", async () => {
    // A cross-agent review is routinely tens of kilobytes and the card face
    // draws one 140-character line of it, so the rest is modal-only content —
    // the same shape as a tool result, and the same treatment.
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
    // …while the exempt subagent final report in the same payload still ships
    // whole, so this asserts a distinction rather than an empty transcript.
    expect(res.rawPayload.toString("utf8")).toContain("finding 4999");
    // The summary line ("Consulted Codex · 900s") is drawn without a click, so
    // its inputs stay on the wire.
    expect(card.status).toBe("success");
    expect(card.durationMs).toBe(900_000);

    // …and the whole output is one fetch away, from the still-whole stored card.
    const full = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/sub-agent-consults/consult-1` });
    expect(full.statusCode).toBe(200);
    expect((full.json() as { outputMarkdown: string }).outputMarkdown).toBe(CONSULT_OUTPUT);

    // `shipit agent result` reads the persisted card directly — it must never
    // see the preview, or the agent's copy and the user's copy stop being one
    // artifact (docs/236).
    expect(history.listSubAgentConsultCards(sessionId)[0]!.outputMarkdown).toBe(CONSULT_OUTPUT);
  });

  it("a read-modify-write updater does not write back a sliced body", async () => {
    // The specific mechanism the design is built to avoid, exercised rather
    // than argued: `updateLastMessage` decodes a row via `fromRow`, mutates one
    // field, and writes the WHOLE row back through `toRow`. If the projection
    // ever moved into `fromRow`, this single unrelated card update would
    // silently persist the truncation and destroy the tail forever — and every
    // other test here would still pass, because they only read.
    await loadHistory();

    history.updateLastMessage(sessionId, { commitHash: "abc123" });

    const stored = history.load(sessionId);
    const last = stored[stored.length - 1] as {
      commitHash?: string;
      toolResults?: { toolUseId: string; content: string }[];
      toolUse?: { id: string; input: Record<string, unknown> }[];
    };
    expect(last.commitHash).toBe("abc123");
    // The mutation landed AND the bodies in that same row are still whole.
    expect(last.toolResults!.find((r) => r.toolUseId === "bash-1")!.content).toBe(HEAVY_OUTPUT);
    expect(last.toolUse!.find((t) => t.id === "write-1")!.input.content).toBe(FILE_BODY);
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
