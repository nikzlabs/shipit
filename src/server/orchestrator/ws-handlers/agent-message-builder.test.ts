import { describe, expect, it, vi } from "vitest";
import { SessionRunner } from "../session-runner.js";
import {
  accumulateAssistantGroups,
  attachToolResultsToGroup,
  findGroupContainingTool,
  recordSteeredMessage,
  requeueUndeliveredSteers,
} from "./agent-message-builder.js";
import type { ChatMessageGroup } from "../session-runner.js";
import type { ClaudeContentBlockToolUse, WsServerMessage } from "../../shared/types.js";

const tool = (id: string, name: string): ClaudeContentBlockToolUse =>
  ({ type: "tool_use", id, name, input: {} }) as ClaudeContentBlockToolUse;

function runner() {
  return new SessionRunner({ sessionId: "session-1", sessionDir: "/tmp/session-1", defaultAgentId: "codex" });
}

describe("accumulateAssistantGroups", () => {
  it("starts a fresh group when a boundary was marked, then appends within it", () => {
    const r = runner();
    r.needsNewMessageGroup = true;
    accumulateAssistantGroups(r, "hello", []);
    expect(r.chatMessageGroups).toHaveLength(1);
    expect(r.needsNewMessageGroup).toBe(false);

    accumulateAssistantGroups(r, " world", [tool("t1", "Read")]);
    expect(r.chatMessageGroups).toHaveLength(1);
    expect(r.chatMessageGroups[0].text).toBe("hello world");
    expect(r.chatMessageGroups[0].toolUse).toHaveLength(1);
    r.dispose({ force: true });
  });

  it("merges a standalone-only tool block into the previous group across a boundary", () => {
    const r = runner();
    accumulateAssistantGroups(r, "the plan", []);
    r.needsNewMessageGroup = true;
    accumulateAssistantGroups(r, "", [tool("p1", "ExitPlanMode")]);
    // Merged into the existing group, not a new empty-text group.
    expect(r.chatMessageGroups).toHaveLength(1);
    expect(r.chatMessageGroups[0].toolUse.map((t) => t.name)).toEqual(["ExitPlanMode"]);
    // Boundary stays armed so the next non-standalone event splits.
    expect(r.needsNewMessageGroup).toBe(true);
    r.dispose({ force: true });
  });
});

describe("findGroupContainingTool", () => {
  it("finds the group holding the tool id, including nested subagent assistants", () => {
    const groups: ChatMessageGroup[] = [
      { text: "a", toolUse: [tool("top", "Task")], subagentEvents: [{ kind: "assistant", parentToolUseId: "top", text: "", toolUse: [tool("nested", "Read")] }] },
    ];
    expect(findGroupContainingTool(groups, "top")).toBe(groups[0]);
    expect(findGroupContainingTool(groups, "nested")).toBe(groups[0]);
    expect(findGroupContainingTool(groups, "missing")).toBeUndefined();
  });
});

describe("attachToolResultsToGroup", () => {
  it("appends results to the last group and is a no-op when there are none", () => {
    const r = runner();
    attachToolResultsToGroup(r, [{ toolUseId: "x", content: "ok", isError: false }]);
    expect(r.chatMessageGroups).toHaveLength(0); // no group yet → no-op

    accumulateAssistantGroups(r, "", [tool("t1", "Read")]);
    attachToolResultsToGroup(r, [{ toolUseId: "t1", content: "ok", isError: false }]);
    expect(r.chatMessageGroups[0].toolResults).toHaveLength(1);
    r.dispose({ force: true });
  });
});

describe("requeueUndeliveredSteers (docs/140)", () => {
  it("re-queues an un-acked streaming steer and drops it from the steered set", () => {
    const r = runner();
    const emitted: WsServerMessage[] = [];
    recordSteeredMessage(r, "do the thing", { assembledPrompt: "do the thing" });
    expect(r.steeredMessages).toHaveLength(1);

    const count = requeueUndeliveredSteers(r, (m) => emitted.push(m));
    expect(count).toBe(1);
    expect(r.steeredMessages).toHaveLength(0);
    expect(r.messageQueue.map((m) => m.text)).toEqual(["do the thing"]);
    expect(emitted.find((m) => m.type === "message_queued")).toBeDefined();
    r.dispose({ force: true });
  });

  it("leaves a delivered steer alone (no re-queue)", () => {
    const r = runner();
    recordSteeredMessage(r, "acked", { assembledPrompt: "acked" });
    r.steeredMessages = r.steeredMessages.map((s) => ({ ...s, delivered: true }));
    expect(requeueUndeliveredSteers(r, vi.fn())).toBe(0);
    expect(r.steeredMessages).toHaveLength(1);
    r.dispose({ force: true });
  });
});
