import { describe, it, expect } from "vitest";
import { deriveSubagentRuns, describeRun, formatRunClock, runClock, type SubagentRun } from "./subagent-runs.js";
import type { ChatMessage, ToolUseBlock } from "../components/MessageList.js";
import type { SubAgentConsultCard } from "../../server/shared/types.js";
import { STOPPED_TEXT } from "../../server/shared/subagent-report.js";

const ACK = [
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
  "agentId: a90130de265682eb8 (internal ID - do not mention to user.)",
  "output_file: /tmp/claude-1000/-workspace/637e/tasks/a90130de265682eb8.output",
].join("\n");

function agentTool(id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: { description: `task ${id}`, subagent_type: "Explore", ...input },
    startedAt: "2026-11-05T10:00:00.000Z",
  };
}

function user(text = "go"): ChatMessage {
  return { role: "user", text };
}

function launch(tool: ToolUseBlock, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", text: "", toolUse: [tool], ...extra };
}

/** A launch in the turn that is still running. */
function live(tool: ToolUseBlock, extra: Partial<ChatMessage> = {}): ChatMessage {
  return launch(tool, { streaming: true, ...extra });
}

function card(over: Partial<SubAgentConsultCard> = {}): SubAgentConsultCard {
  return {
    cardId: "sac-1",
    spawnId: "spawn-1",
    subAgentId: "codex",
    status: "success",
    durationMs: 47000,
    createdAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

function only(runs: SubagentRun[]): SubagentRun {
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe("deriveSubagentRuns — Agent-tool sub-agents", () => {
  it("is running while its turn is live and it has no result", () => {
    const run = only(deriveSubagentRuns([user(), live(agentTool("t1"))], { turnRunning: true }));
    expect(run).toMatchObject({ kind: "native", status: "running", name: "task t1", detail: "Explore · 0 tool calls" });
  });

  it("counts the tool calls its nested events made", () => {
    const run = only(deriveSubagentRuns([user(), live(agentTool("t1"), {
      subagentEvents: [
        { kind: "assistant", parentToolUseId: "t1", text: "", toolUse: [agentTool("a"), agentTool("b")] },
        { kind: "assistant", parentToolUseId: "other", text: "", toolUse: [agentTool("c")] },
      ],
    })], { turnRunning: true }));
    expect(run.detail).toBe("Explore · 2 tool calls");
  });

  it("is stopped — failed — when its turn ended without a result", () => {
    const run = only(deriveSubagentRuns([user(), launch(agentTool("t1"))], { turnRunning: false }));
    expect(run).toMatchObject({ status: "failed", stopped: true, detail: "Explore · stopped · 0 tool calls" });
  });

  it("is stopped when a newer turn is the live one", () => {
    const runs = deriveSubagentRuns([user(), launch(agentTool("t1")), user("next"), live(agentTool("t2"))], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["failed", "running"]);
  });

  it("stays running when newer groups of its turn have taken the streaming mark", () => {
    const runs = deriveSubagentRuns([user(), launch(agentTool("t1")), { role: "assistant", text: "meanwhile", streaming: true }], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["running"]);
  });

  it("stays running when the user steers a message into its turn", () => {
    const runs = deriveSubagentRuns([user(), live(agentTool("t1")), { role: "user", text: "also check the tests", steered: true }], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["running"]);
  });

  it("stays running when a steered message and a newer group both follow it", () => {
    const runs = deriveSubagentRuns([
      user(), launch(agentTool("t1")), { role: "user", text: "also check the tests", steered: true },
      { role: "assistant", text: "checking", streaming: true },
    ], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["running"]);
  });

  it("is running after a reload of the in-progress turn, a steer in it included", () => {
    const runs = deriveSubagentRuns([
      user(), launch(agentTool("t1"), { inProgress: true }),
      { role: "user", text: "steer", inProgress: true }, { role: "assistant", text: "ok", inProgress: true },
    ], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["running"]);
  });

  it("is stopped when a crashed turn left its row in progress and a new turn runs", () => {
    const runs = deriveSubagentRuns([user(), launch(agentTool("t1"), { inProgress: true }), user("next")], { turnRunning: true });
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
  });

  it("is done with the report's duration and tool count", () => {
    const content = JSON.stringify([
      { type: "text", text: "Found it." },
      { type: "text", text: "agentId: abc\nsubagent_tokens: 1200\ntool_uses: 7\nduration_ms: 72000" },
    ]);
    const run = only(deriveSubagentRuns([user(), launch(agentTool("t1"), {
      toolResults: [{ toolUseId: "t1", content }],
    })], { turnRunning: false }));
    expect(run).toMatchObject({ status: "done", durationMs: 72000, detail: "Explore · 7 tool calls" });
  });

  it("is failed on an error result", () => {
    const run = only(deriveSubagentRuns([user(), launch(agentTool("t1"), {
      toolResults: [{ toolUseId: "t1", content: "boom", isError: true }],
    })], { turnRunning: false }));
    expect(run.status).toBe("failed");
  });

  it("stays running in the background after its turn ends (docs/109 reqs 10–11)", () => {
    const run = only(deriveSubagentRuns([user(), launch(agentTool("t1"), {
      toolResults: [{ toolUseId: "t1", content: ACK }],
    })], { turnRunning: false }));
    expect(run).toMatchObject({ status: "running", backgrounded: true, detail: "Explore · background · 0 tool calls" });
  });

  it("is failed once a background run is retired as stopped", () => {
    const content = JSON.stringify([{ type: "text", text: STOPPED_TEXT }, { type: "text", text: "tool_uses: 3" }]);
    const run = only(deriveSubagentRuns([user(), launch(agentTool("t1"), {
      toolResults: [{ toolUseId: "t1", content }],
    })], { turnRunning: false }));
    expect(run).toMatchObject({ status: "failed", stopped: true, detail: "Explore · stopped · 3 tool calls" });
  });

  it("ignores Skill and ordinary tools", () => {
    const skill: ToolUseBlock = { type: "tool_use", id: "s", name: "Skill", input: { skill: "x" } };
    const bash: ToolUseBlock = { type: "tool_use", id: "b", name: "Bash", input: {} };
    expect(deriveSubagentRuns([{ role: "assistant", text: "", toolUse: [skill, bash] }], { turnRunning: true })).toEqual([]);
  });
});

describe("deriveSubagentRuns — shipit agent run sub-agents", () => {
  it("maps the card's status", () => {
    const statuses = (["pending", "success", "error", "timeout", "cancelled"] as const).map((status) =>
      only(deriveSubagentRuns([{ role: "assistant", text: "", subAgentConsult: card({ status }) }], { turnRunning: false })).status,
    );
    expect(statuses).toEqual(["running", "done", "failed", "failed", "failed"]);
  });

  it("shows a spawn that has no card yet, and only once the card exists", () => {
    const spawns = [{ spawnId: "spawn-1", subAgentId: "codex" as const }];
    const before = only(deriveSubagentRuns([], { turnRunning: true, spawns }));
    expect(before).toMatchObject({ kind: "consult", status: "running", name: "Codex", detail: "starting" });

    const after = deriveSubagentRuns([{ role: "assistant", text: "", subAgentConsult: card({ status: "pending" }) }], { turnRunning: true, spawns });
    expect(after.map((r) => r.key)).toEqual(["consult:sac-1"]);
  });

  it("keeps both kinds in the order they appeared", () => {
    const runs = deriveSubagentRuns([
      user(),
      { role: "assistant", text: "", subAgentConsult: card() },
      live(agentTool("t1")),
    ], { turnRunning: true });
    expect(runs.map((r) => r.key)).toEqual(["consult:sac-1", "native:t1"]);
  });
});

describe("describeRun — run-on attribution (docs/261 req 9)", () => {
  const runOn = { serviceId: "anthropic", billingMode: "sub" as const, modelId: "claude-opus-5", reasoningEffort: "high" };

  it("names the MODEL, not the harness, and puts the rest on the attribution line", () => {
    expect(describeRun(card({ subAgentId: "claude", runOn }))).toEqual({
      subject: "Opus 5",
      attribution: "Anthropic · Subscription · Claude · High reasoning",
      effort: "High",
    });
  });

  it("leads with the role the run was started as", () => {
    expect(describeRun(card({ subAgentId: "claude", runOn, roleName: "reviewer" })).attribution)
      .toBe("as reviewer · Anthropic · Subscription · Claude · High reasoning");
  });

  it("falls back to the harness for a card with no run target", () => {
    expect(describeRun(card())).toEqual({ subject: "Codex", attribution: null, effort: null });
  });

  it("falls back to raw ids the catalogue no longer carries", () => {
    expect(describeRun(card({
      runOn: { serviceId: "retired-gw", billingMode: "key", modelId: "some-old-model", reasoningEffort: "turbo" },
    }))).toEqual({ subject: "some-old-model", attribution: "retired-gw · API key · Codex · turbo reasoning", effort: "turbo" });
  });

  it("gives the line a short detail: role, harness when it differs from the model, reasoning", () => {
    const run = only(deriveSubagentRuns([{
      role: "assistant", text: "", subAgentConsult: card({ subAgentId: "claude", runOn, roleName: "reviewer" }),
    }], { turnRunning: false }));
    expect(run).toMatchObject({ name: "Opus 5", detail: "reviewer · Claude · High" });
  });
});

describe("runClock", () => {
  it("ticks from the start while running, and shows the duration once finished", () => {
    const start = Date.parse("2026-11-05T10:00:00.000Z");
    const [running] = deriveSubagentRuns([user(), live(agentTool("t1"))], { turnRunning: true });
    expect(runClock(running!, start + 72_000)).toBe("1:12");

    const [done] = deriveSubagentRuns([{ role: "assistant", text: "", subAgentConsult: card() }], { turnRunning: false });
    expect(runClock(done!, start)).toBe("0:47");
  });

  it("formats past an hour", () => {
    expect(formatRunClock(3_725_000)).toBe("1:02:05");
  });
});
