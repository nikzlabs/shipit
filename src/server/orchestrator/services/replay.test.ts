import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boundStoredReplay,
  buildConversationReplay,
  REPLAY_INLINE_BUDGET_BYTES,
  replaySpillDirs,
} from "./replay.js";
import type { PersistedMessage } from "../chat-history.js";

/**
 * planning#610 / `docs/144-rewind-fork-ux` U8 — after a rewind or a fork the replay is the
 * only memory the next agent has. A replay that shows the words and hides the work is what
 * makes that agent redo finished work.
 */

const user = (text: string, extra: Partial<PersistedMessage> = {}): PersistedMessage =>
  ({ role: "user", text, ...extra });

const toolTurn = (
  name: string,
  input: Record<string, unknown>,
  result: string,
  text = "",
): PersistedMessage => ({
  role: "assistant",
  text,
  toolUse: [{ type: "tool_use", id: "t1", name, input }],
  toolResults: [{ toolUseId: "t1", content: result }],
});

describe("the replay carries the work, not only the words", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const spill = () => replaySpillDirs(dir, { containerized: false });

  it("names the tool and its input for a turn that produced no text", () => {
    // `chat-card-persistence.ts` keeps a group for its tool calls alone, so a tool-only
    // turn persists with text: "". Reading role and text alone renders it as "Assistant: ".
    const replay = buildConversationReplay([
      user("fix the rate limiter"),
      toolTurn("Edit", { file_path: "/workspace/src/mw.ts" }, "Applied 1 edit"),
    ]);
    expect(replay).toContain("[tool] Edit");
    expect(replay).toContain("/workspace/src/mw.ts");
    expect(replay).toContain("Applied 1 edit");
    expect(replay).not.toMatch(/^Assistant:\s*$\n\s*$/m);
  });

  it("keeps a short result inline", () => {
    const replay = buildConversationReplay([toolTurn("Bash", { command: "git status" }, "clean")], {
      spill: spill(),
    });
    expect(replay).toContain("[result] clean");
    expect(fs.existsSync(path.join(dir, "scratch", "replay"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "scratch", "replay"))).toEqual([]);
  });

  it("writes a result over 500 characters to a file and names it", () => {
    const body = "x".repeat(4000);
    const replay = buildConversationReplay([toolTurn("Bash", { command: "npm test" }, body)], {
      spill: spill(),
    });
    const spillDir = path.join(dir, "scratch", "replay");
    const written = fs.readdirSync(spillDir);
    expect(written).toHaveLength(1);
    expect(replay).toContain(path.join(spillDir, written[0]));
    expect(replay).not.toContain(body);
    // The file holds the whole thing, so the agent can still read what the tool said.
    expect(fs.readFileSync(path.join(spillDir, written[0]), "utf8")).toBe(body);
  });

  it("falls back to an excerpt when no spill directory is available", () => {
    const body = "y".repeat(4000);
    const replay = buildConversationReplay([toolTurn("Bash", { command: "npm test" }, body)]);
    expect(replay).toContain("(truncated)");
    expect(replay.length).toBeLessThan(2000);
  });

  it("empties the spill directory on each build so it cannot grow", () => {
    const long = "z".repeat(1000);
    // Different tool names, so a second build that failed to reset would leave both files
    // rather than overwriting the first — which a same-name pair could never show.
    buildConversationReplay([toolTurn("Bash", { command: "a" }, long)], { spill: spill() });
    buildConversationReplay([toolTurn("Grep", { pattern: "b" }, long)], { spill: spill() });
    expect(fs.readdirSync(path.join(dir, "scratch", "replay"))).toEqual(["001-Grep.txt"]);
  });

  it("names attachments without carrying their contents", () => {
    const replay = buildConversationReplay([
      user("fix the bug in the screenshot", {
        uploadPaths: ["/uploads/shot.png"],
        images: [{ mediaType: "image/png", data: "AAAA" }],
      }),
      toolTurn("Read", { file_path: "/workspace/a.ts" }, "ok", "looking"),
    ]);
    expect(replay).toContain("/uploads/shot.png");
    expect(replay).toContain("1 image");
    expect(replay).not.toContain("AAAA");
  });

  it("drops a row that carries neither text nor work", () => {
    // A persisted card row: it renders in the transcript but says nothing to a new agent.
    const replay = buildConversationReplay([
      user("hello"),
      { role: "assistant", text: "", branchSynced: {} as PersistedMessage["branchSynced"] },
      toolTurn("Read", { file_path: "/workspace/a.ts" }, "ok"),
    ]);
    // Counted, not pattern-matched: the tool turn legitimately renders a bare `Assistant:`
    // head above its detail lines, so only the count can show the card row was dropped.
    expect(replay.match(/^Assistant:/gm) ?? []).toHaveLength(1);
  });
});

describe("the replay fits the spawn request (docs/007)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  // Multi-byte text, so a budget counted in characters would overshoot.
  const conversation = (count: number, size: number): PersistedMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      text: `message-${i} ${"é".repeat(size)}`,
    }));

  it("keeps the most recent messages inline under the budget and the whole transcript in a file", () => {
    const replay = buildConversationReplay(conversation(40, 500), {
      spill: replaySpillDirs(dir, { containerized: false }),
      inlineBudgetBytes: 8 * 1024,
    });

    expect(bytes(replay)).toBeLessThanOrEqual(8 * 1024);
    expect(replay).toContain("message-39 ");
    expect(replay).not.toContain("message-0 ");
    expect(replay).toMatch(/the most recent \d+ of its 40 messages/);
    const file = path.join(dir, "scratch", "replay", "transcript.md");
    expect(replay).toContain(file);
    const transcript = fs.readFileSync(file, "utf8");
    expect(transcript).toContain("message-0 ");
    expect(transcript).toContain("message-39 ");
  });

  it("keeps a session of thousands of messages well below the worker's 1 MiB request limit", () => {
    const replay = buildConversationReplay(conversation(4_800, 400), {
      spill: replaySpillDirs(dir, { containerized: true }),
    });

    expect(bytes(replay)).toBeLessThanOrEqual(REPLAY_INLINE_BUDGET_BYTES);
    expect(bytes(JSON.stringify({ systemPrompt: replay }))).toBeLessThan(512 * 1024);
    expect(replay).toContain("/persist/replay/transcript.md");
  });

  it("counts what JSON escaping adds, not only the UTF-8 bytes", () => {
    // A control character is one byte of text and six in the request (\u0000).
    const escaped: PersistedMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      text: `message-${i} ${"\u0000".repeat(2_000)}`,
    }));

    const replay = buildConversationReplay(escaped, { inlineBudgetBytes: 16 * 1024 });

    expect(bytes(JSON.stringify(replay))).toBeLessThanOrEqual(16 * 1024 + 2);
    expect(replay).toContain("message-19 ");
  });

  it("says the beginning is omitted when there is nowhere to write the transcript", () => {
    const replay = buildConversationReplay(conversation(40, 500), { inlineBudgetBytes: 8 * 1024 });

    expect(bytes(replay)).toBeLessThanOrEqual(8 * 1024);
    expect(replay).toContain("Its earlier part is omitted.");
    expect(replay).toContain("message-39 ");
  });

  it("writes no transcript file for a replay that fits", () => {
    const replay = buildConversationReplay(conversation(4, 10), {
      spill: replaySpillDirs(dir, { containerized: false }),
    });

    expect(replay).toContain("Here is the conversation so far.");
    expect(replay).toContain("message-0 ");
    expect(fs.existsSync(path.join(dir, "scratch", "replay", "transcript.md"))).toBe(false);
  });
});

describe("boundStoredReplay", () => {
  it("returns a replay within the budget unchanged", () => {
    expect(boundStoredReplay("User: hi\nAssistant: hello", 1024)).toBe("User: hi\nAssistant: hello");
  });

  it("counts JSON escaping when it cuts a stored replay", () => {
    const stored = Array.from({ length: 50 }, (_, i) => `User: turn-${i} ${"\u0001".repeat(500)}`).join("\n");

    const bounded = boundStoredReplay(stored, 4 * 1024);

    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(4 * 1024 + 2);
    expect(bounded).toContain("turn-49 ");
  });

  it("keeps the most recent part of an oversized stored replay, from a message boundary", () => {
    const stored = Array.from({ length: 200 }, (_, i) => `${i % 2 ? "Assistant" : "User"}: turn-${i} ${"é".repeat(40)}`)
      .join("\n");

    const bounded = boundStoredReplay(stored, 2 * 1024);

    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(bounded).toContain("turn-199 ");
    expect(bounded).not.toContain("turn-0 ");
    expect(bounded.split("\n\n")[1]).toMatch(/^(User|Assistant): turn-\d+ /);
  });
});
