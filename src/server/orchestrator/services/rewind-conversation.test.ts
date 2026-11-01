import { describe, it, expect } from "vitest";
import type { PersistedMessage } from "../chat-history.js";
import { codeRollbackNotice, forkPointBefore, planChatRewind } from "./rewind-conversation.js";

const user = (text: string, agentMessageId?: string): PersistedMessage =>
  ({ role: "user", text, ...(agentMessageId ? { agentMessageId } : {}) });
const reply = (text: string, agentMessageId?: string): PersistedMessage =>
  ({ role: "assistant", text, ...(agentMessageId ? { agentMessageId } : {}) });

describe("forkPointBefore (docs/007 req 4)", () => {
  const chat: PersistedMessage[] = [
    user("first", "u1"),
    reply("done", "a1"),
    { role: "assistant", text: "", forkChild: { childSessionId: "c", title: "t", branch: "b" } },
    { role: "assistant", text: "Rolled back.", notice: true },
    { role: "assistant", text: "Error: refused", isError: true },
    user("second", "u2"),
    reply("done again", "a2"),
  ];

  it("is the last kept message the CLI has, past the rows ShipIt wrote itself", () => {
    expect(forkPointBefore(chat, 5)).toBe("a1");
    expect(forkPointBefore(chat, 7)).toBe("a2");
    expect(forkPointBefore(chat, 6)).toBe("u2");
  });

  it("is none at the start of the chat", () => {
    expect(forkPointBefore(chat, 0)).toBeNull();
  });

  it("is none when the kept prompt has no id: the fork would drop it", () => {
    const echoless = [user("first", "u1"), reply("done", "a1"), user("second")];
    expect(forkPointBefore(echoless, 3)).toBeNull();
  });

  it("is none over rows from before ids were recorded", () => {
    expect(forkPointBefore([user("first"), reply("done")], 2)).toBeNull();
  });
});

describe("planChatRewind (docs/007 reqs 6, 9)", () => {
  const chat = [user("first", "u1"), reply("done", "a1"), user("second", "u2")];

  it("forks a Claude conversation at the point", () => {
    expect(planChatRewind("claude", chat, 2)).toEqual({ resumeAt: "a1" });
  });

  it("refuses an agent that cannot fork at a message, naming fork", () => {
    const plan = planChatRewind("codex", chat, 2);
    expect(plan).toEqual({ refusal: expect.stringMatching(/^Codex cannot .*Fork from here instead\.$/) });
  });

  it("refuses when there is no message to fork at, naming fork", () => {
    expect(planChatRewind("claude", chat, 0)).toEqual({ refusal: expect.stringContaining("Fork from here instead") });
  });
});

describe("codeRollbackNotice (docs/007 req 3)", () => {
  it("is one line naming the short commit", () => {
    const notice = codeRollbackNotice("0123456789abcdef");
    expect(notice).toContain("commit 0123456.");
    expect(notice).not.toContain("\n");
  });
});
