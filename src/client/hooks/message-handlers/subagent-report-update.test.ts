import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { handleSubagentReportUpdate } from "./subagent-report-update.js";
import type { HandlerContext } from "./types.js";
import type { WsSubagentReportUpdate } from "../../../server/shared/types.js";
import { isBackgroundLaunchAck } from "../../utils/group-events-by-parent.js";

const ctx: HandlerContext = { terminalRef: { current: null }, queuedMessageStash: new Map() };

const TOOL_ID = "toolu_013fUMwLfWGNwaaqVsj8ojXF";

const ACK = [
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it.)",
  "agentId: af0615944a51b4583 (internal ID - do not mention to user.)",
  "output_file: /tmp/claude-1000/x/tasks/af0615944a51b4583.output",
].join("\n");

const REPORT = "## Probe report\n\nThe number seven holds profound significance.";

const event = (over: Partial<WsSubagentReportUpdate> = {}): WsSubagentReportUpdate => ({
  type: "subagent_report_update",
  sessionId: "s1",
  toolUseId: TOOL_ID,
  result: { toolUseId: TOOL_ID, content: REPORT },
  ...over,
});

beforeEach(() => {
  useSessionStore.setState({
    messages: [
      { role: "user", text: "Look into the number seven" },
      {
        role: "assistant",
        text: "Launched a subagent.",
        toolUse: [{ type: "tool_use", id: TOOL_ID, name: "Agent", input: {} }],
        toolResults: [{ toolUseId: TOOL_ID, content: ACK }],
      },
    ],
  });
});

describe("handleSubagentReportUpdate (docs/109 reqs 10–11)", () => {
  /**
   * The card has no state of its own: it renders as "running" purely because
   * the stored result still IS the launch acknowledgement. Swapping the content
   * is therefore the whole retirement.
   */
  it("swaps the launch acknowledgement for the report in place", () => {
    handleSubagentReportUpdate(ctx, event());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(2);
    const result = messages[1].toolResults![0];
    expect(result.content).toBe(REPORT);
    expect(isBackgroundLaunchAck(result.content)).toBe(false);
  });

  it("carries the projection's clamp metadata so the modal can fetch the rest", () => {
    handleSubagentReportUpdate(ctx, event({
      result: { toolUseId: TOOL_ID, content: "## Probe report", truncated: true, totalLines: 90, totalBytes: 9000 },
    }));
    expect(useSessionStore.getState().messages[1].toolResults![0]).toMatchObject({
      truncated: true,
      totalLines: 90,
    });
  });

  it("marks a failed subagent's result as an error", () => {
    handleSubagentReportUpdate(ctx, event({
      result: { toolUseId: TOOL_ID, content: "Agent stalled", isError: true },
    }));
    expect(useSessionStore.getState().messages[1].toolResults![0].isError).toBe(true);
  });

  it("leaves other tool results in the same message alone", () => {
    useSessionStore.setState({
      messages: [{
        role: "assistant",
        text: "",
        toolUse: [{ type: "tool_use", id: TOOL_ID, name: "Agent", input: {} }],
        toolResults: [
          { toolUseId: "other", content: "untouched" },
          { toolUseId: TOOL_ID, content: ACK },
        ],
      }],
    });
    handleSubagentReportUpdate(ctx, event());
    const results = useSessionStore.getState().messages[0].toolResults!;
    expect(results[0].content).toBe("untouched");
    expect(results[1].content).toBe(REPORT);
  });

  /** A replay must not throw or corrupt a transcript that doesn't hold the card. */
  it("is a no-op when no loaded message holds that tool result", () => {
    const before = useSessionStore.getState().messages;
    handleSubagentReportUpdate(ctx, event({ toolUseId: "nope", result: { toolUseId: "nope", content: "x" } }));
    expect(useSessionStore.getState().messages).toBe(before);
  });
});
