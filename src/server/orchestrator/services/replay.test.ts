import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConversationReplay, armConversationReplay, replaySpillDirs } from "./replay.js";
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
    expect(replay).not.toMatch(/^Assistant: $/m);
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
    const messages = [toolTurn("Bash", { command: "a" }, "z".repeat(1000))];
    buildConversationReplay(messages, { spill: spill() });
    buildConversationReplay(messages, { spill: spill() });
    expect(fs.readdirSync(path.join(dir, "scratch", "replay"))).toHaveLength(1);
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
    expect(replay).not.toMatch(/^Assistant: $/m);
  });
});

describe("the replay does not carry the message that follows it", () => {
  it("drops the turn's own user row", () => {
    // The row is persisted before the replay is built (`turn-executor.ts`), so without
    // this the agent reads the same message twice: once as history, once as the prompt.
    const replay = buildConversationReplay(
      [user("first"), toolTurn("Read", { file_path: "/a" }, "ok", "done"), user("now the webhook")],
      { dropTrailingUserText: "now the webhook" },
    );
    expect(replay).not.toContain("now the webhook");
    expect(replay).toContain("first");
  });

  it("keeps an earlier user message that was never answered", () => {
    // Matched on text, not position: dropping by position would discard real history.
    const replay = buildConversationReplay([user("never answered"), user("this turn")], {
      dropTrailingUserText: "this turn",
    });
    expect(replay).toContain("never answered");
    expect(replay).not.toContain("this turn");
  });

  it("leaves history alone when the last row is not the turn's message", () => {
    const replay = buildConversationReplay([user("a"), toolTurn("Read", { f: 1 }, "ok", "b")], {
      dropTrailingUserText: "something else",
    });
    expect(replay).toContain("User: a");
  });
});

describe("armConversationReplay", () => {
  const history = (messages: PersistedMessage[]) => {
    const stored: string[] = [];
    const deps = {
      chatHistoryManager: { load: () => messages },
      sessionManager: { setConversationReplay: (_id: string, r: string) => { stored.push(r); } },
    };
    return { deps, stored };
  };

  it("counts a tool-only turn as a reply", () => {
    // `requireReply` used to demand non-empty assistant text, which a turn that only
    // called tools never has — so the transcript that most needs replaying was refused.
    const { deps, stored } = history([
      user("do the thing"),
      toolTurn("Edit", { file_path: "/a" }, "Applied 1 edit"),
      user("and again"),
    ]);
    expect(armConversationReplay(deps, "s1", {
      requireReply: true,
      dropTrailingUserText: "and again",
    })).toBe(true);
    expect(stored[0]).toContain("[tool] Edit");
  });

  it("refuses when the only message is the one being submitted", () => {
    const { deps } = history([user("first ever message")]);
    expect(armConversationReplay(deps, "s1", {
      dropTrailingUserText: "first ever message",
    })).toBe(false);
  });
});
