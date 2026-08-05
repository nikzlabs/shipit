/**
 * docs/109 reqs 10–11 — retiring a finished background subagent's card.
 *
 * The fixtures here are lifted from a real CLI 2.1.219 run (the wire trace in
 * `subagent-completion.ts`): the acknowledgement is the exact block-array shape
 * the CLI writes, and the completion is the exact `task_notification` payload.
 */

import { describe, it, expect } from "vitest";
import {
  buildRetiredSubagentResult,
  retireBackgroundSubagentResult,
  retireInCarriers,
  toTerminalStatus,
  NO_REPORT_TEXT,
  STOPPED_TEXT,
  FAILED_FALLBACK_TEXT,
  type SubagentResultCarrier,
} from "./subagent-completion.js";
import { parseSubagentReport, parseReportMeta, isBackgroundLaunchAck } from "../shared/subagent-report.js";

const TOOL_ID = "toolu_013fUMwLfWGNwaaqVsj8ojXF";

/** The CLI's launch acknowledgement, verbatim from the probe run. */
const ACK = JSON.stringify([
  {
    type: "text",
    text: [
      "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
      "agentId: af0615944a51b4583 (internal ID - do not mention to user. Use SendMessage with to: 'af0615944a51b4583', summary: '<5-10 word recap>' to continue this agent.)",
      "The agent is working in the background. You will be notified automatically when it completes.",
      "output_file: /tmp/claude-1000/-tmp-probe/3bc49c90/tasks/af0615944a51b4583.output",
    ].join("\n"),
  },
]);

const REPORT = "## Probe report\n\nThe number seven holds profound significance.";

function carrier(overrides: Partial<SubagentResultCarrier> = {}): SubagentResultCarrier {
  return {
    toolUse: [{ id: TOOL_ID, name: "Agent" }],
    toolResults: [{ toolUseId: TOOL_ID, content: ACK }],
    ...overrides,
  };
}

describe("toTerminalStatus", () => {
  it("accepts the three terminal statuses the CLI emits", () => {
    expect(toTerminalStatus("completed")).toBe("completed");
    expect(toTerminalStatus("failed")).toBe("failed");
    expect(toTerminalStatus("stopped")).toBe("stopped");
  });

  /**
   * A status we do not model is not evidence the subagent finished. Guessing
   * would trade a card stuck on "running" for one that lies about being done.
   */
  it("rejects anything else, including undefined", () => {
    expect(toTerminalStatus("running")).toBeNull();
    expect(toTerminalStatus(undefined)).toBeNull();
  });
});

describe("buildRetiredSubagentResult", () => {
  it("uses the notification's summary as the report (req 11)", () => {
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "completed", summary: REPORT });
    expect(parseSubagentReport(built.content).text).toBe(REPORT);
    expect(built.isError).toBeUndefined();
  });

  /** The whole point: what replaces the ack must not still look like the ack. */
  it("produces content the launch-ack detector no longer matches", () => {
    expect(isBackgroundLaunchAck(parseSubagentReport(ACK).text)).toBe(true);
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "completed", summary: REPORT });
    expect(isBackgroundLaunchAck(parseSubagentReport(built.content).text)).toBe(false);
  });

  /**
   * req 5 — the chips are parsed out of a `key: value` text block, so the
   * accounting has to be emitted in that shape to render at all.
   */
  it("emits the usage as a footer the chip parser reads", () => {
    const built = buildRetiredSubagentResult({
      toolUseId: TOOL_ID,
      status: "completed",
      summary: REPORT,
      usage: { totalTokens: 10408, toolUses: 0, durationMs: 2757 },
    });
    const parsed = parseSubagentReport(built.content);
    expect(parsed.text).toBe(REPORT);
    expect(parseReportMeta(parsed.meta)).toEqual({ tokens: 10408, toolUses: 0, durationMs: 2757 });
  });

  /** req 5 — the internal agent id must never reach the reader. */
  it("never writes an agentId into the payload", () => {
    const built = buildRetiredSubagentResult({
      toolUseId: TOOL_ID,
      status: "completed",
      summary: REPORT,
      usage: { totalTokens: 1, toolUses: 2, durationMs: 3 },
    });
    expect(built.content).not.toContain("agentId");
  });

  it("keeps the plain-string shape when there is no usage to report", () => {
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "completed", summary: REPORT });
    expect(built.content).toBe(REPORT);
  });

  it("marks a failure as an error, carrying the reason (req 9)", () => {
    const built = buildRetiredSubagentResult({
      toolUseId: TOOL_ID,
      status: "failed",
      summary: "Agent stalled: no progress for 300s",
    });
    expect(built.isError).toBe(true);
    expect(built.content).toContain("Agent stalled");
  });

  it("falls back to its own words when a failure carries no reason", () => {
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "failed" });
    expect(built.content).toBe(FAILED_FALLBACK_TEXT);
    expect(built.isError).toBe(true);
  });

  /**
   * A stop is not a fault. Marking it `isError` would draw the red "Subagent
   * failed" panel and send the reader looking for a bug that is not there.
   */
  it("says a stopped subagent was stopped, without calling it an error", () => {
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "stopped", summary: "Review the diff" });
    expect(built.content).toBe(STOPPED_TEXT);
    expect(built.isError).toBeUndefined();
  });

  /** req 11's second half — the promise must be closed out either way. */
  it("says so plainly when a subagent finished without a report", () => {
    const built = buildRetiredSubagentResult({ toolUseId: TOOL_ID, status: "completed", summary: "   " });
    expect(built.content).toBe(NO_REPORT_TEXT);
  });
});

describe("retireBackgroundSubagentResult", () => {
  const completion = { toolUseId: TOOL_ID, status: "completed" as const, summary: REPORT };
  const built = () => buildRetiredSubagentResult(completion);

  it("replaces the acknowledgement in place and names the owning tool", () => {
    const c = carrier();
    const hit = retireBackgroundSubagentResult(c, completion, built());
    expect(hit?.toolName).toBe("Agent");
    expect(c.toolResults![0].content).toBe(REPORT);
  });

  it("works for the legacy `Task` name as well as `Agent`", () => {
    const c = carrier({ toolUse: [{ id: TOOL_ID, name: "Task" }] });
    expect(retireBackgroundSubagentResult(c, completion, built())).not.toBeNull();
  });

  /**
   * The dangerous one. `task_notification` also fires for background *shell*
   * commands, whose `tool_use_id` points at a Bash call holding real output —
   * and whose summary is a one-liner. Rewriting that would destroy the command's
   * result and replace it with `Background command "npm test" completed`.
   */
  it("refuses to touch a result that is not a report tool's", () => {
    const c: SubagentResultCarrier = {
      toolUse: [{ id: TOOL_ID, name: "Bash" }],
      toolResults: [{ toolUseId: TOOL_ID, content: "total 48\ndrwxr-xr-x 12 root root" }],
    };
    expect(retireBackgroundSubagentResult(c, completion, built())).toBeNull();
    expect(c.toolResults![0].content).toBe("total 48\ndrwxr-xr-x 12 root root");
  });

  /**
   * The CLI warns that "the same task-id may notify more than once" (an agent
   * resumed with `SendMessage` notifies again). A second notification must not
   * overwrite the report already sitting there — including with an older one.
   */
  it("is idempotent: a repeat notification leaves the existing report alone", () => {
    const c = carrier();
    expect(retireBackgroundSubagentResult(c, completion, built())).not.toBeNull();
    const second = buildRetiredSubagentResult({ ...completion, summary: "STALE" });
    expect(retireBackgroundSubagentResult(c, completion, second)).toBeNull();
    expect(c.toolResults![0].content).toBe(REPORT);
  });

  it("leaves an error result alone", () => {
    const c = carrier({ toolResults: [{ toolUseId: TOOL_ID, content: ACK, isError: true }] });
    expect(retireBackgroundSubagentResult(c, completion, built())).toBeNull();
  });

  it("is a no-op when the carrier has no result for that id yet", () => {
    const c = carrier({ toolResults: [] });
    expect(retireBackgroundSubagentResult(c, completion, built())).toBeNull();
  });

  it("finds the card in whichever carrier holds it", () => {
    const carriers = [
      { toolUse: [{ id: "other", name: "Read" }], toolResults: [{ toolUseId: "other", content: "x" }] },
      carrier(),
    ];
    const hit = retireInCarriers(carriers, completion, built());
    expect(hit?.slot.content).toBe(REPORT);
  });
});
