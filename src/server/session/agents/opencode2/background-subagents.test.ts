import { describe, it, expect } from "vitest";
import { backgroundSubagentSession, messageRunEvents, subagentNotice } from "./background-subagents.js";

describe("backgroundSubagentSession", () => {
  it("names the child session of a subagent that is still running", () => {
    const part = { type: "tool" as const, tool: "subagent", state: { status: "completed", metadata: { metadata: { sessionID: "ses_c", status: "running" } } } };
    expect(backgroundSubagentSession(part)).toBe("ses_c");
  });

  it("is undefined for a subagent that finished in the foreground, and for other tools", () => {
    const done = { type: "tool" as const, tool: "subagent", state: { metadata: { metadata: { sessionID: "ses_c", status: "completed" } } } };
    const shell = { type: "tool" as const, tool: "shell", state: { metadata: { metadata: { sessionID: "ses_c", status: "running" } } } };
    expect(backgroundSubagentSession(done)).toBeUndefined();
    expect(backgroundSubagentSession(shell)).toBeUndefined();
  });
});

describe("subagentNotice", () => {
  it("reads a failed subagent's report as failed", () => {
    expect(subagentNotice({
      type: "synthetic",
      text: '<subagent sessionID="ses_c" state="error" description="d">\nprovider down\n</subagent>',
      metadata: { source: "subagent", childID: "ses_c", state: "error" },
    })).toEqual({ childSessionId: "ses_c", status: "failed", report: "provider down" });
  });

  it("ignores other synthetic messages", () => {
    expect(subagentNotice({ type: "synthetic", text: "Command finished", metadata: { source: "shell" } })).toBeUndefined();
  });
});

describe("messageRunEvents", () => {
  it("prints a failed call's message and skips one still running", () => {
    const events = messageRunEvents("ses_p", {
      id: "msg_1",
      type: "assistant",
      content: [
        { type: "tool", id: "call_1", name: "read", state: { status: "error", input: { path: "/x" }, error: { message: "not found" } } },
        { type: "tool", id: "call_2", name: "shell", state: { status: "running", input: {} } },
      ],
    });
    expect(events.map((e) => e.type)).toEqual(["tool_use", "step_finish"]);
    expect(events[0].part).toMatchObject({ id: "call_1", tool: "read", state: { status: "error", error: "not found" } });
  });
});
