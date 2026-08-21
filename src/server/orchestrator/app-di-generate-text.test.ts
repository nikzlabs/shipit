import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { makeInProcessGenerateText } from "./app-di.js";
import type { AgentEvent, AgentProcess } from "../shared/types.js";
import type { UsageManager } from "./usage.js";

/**
 * docs/252 phase 7 (planning#343) — the in-process generator is the SECOND
 * producer of work that resolves no model.
 *
 * `makeNonTurnGenerateText` hands it the `nothing_eligible` case, and under
 * `RUNTIME_MODE=local` it spawns a real CLI. Its tokens are as real as session
 * naming's and as unattributable, so they get the same row: legacy group,
 * unpriced. Cross-backend review found this half still dropping them.
 */

/** A scripted agent: emits the given events, then `done`, on `run()`. */
function fakeAgent(events: AgentEvent[], exitCode = 0): AgentProcess {
  const agent = new EventEmitter() as EventEmitter & { run: (o: unknown) => void };
  agent.run = () => {
    setImmediate(() => {
      for (const event of events) agent.emit("event", event);
      agent.emit("done", exitCode);
    });
  };
  return agent as unknown as AgentProcess;
}

const TEXT_EVENT: AgentEvent = {
  type: "agent_assistant",
  content: [{ type: "text", text: "## Summary\n\nDid a thing." }],
} as AgentEvent;

const RESULT_EVENT: AgentEvent = {
  type: "agent_result",
  status: "success",
  sessionId: "cli-1",
  // Claude DOES report a dollar figure. It must not become this row's price.
  cost: { totalUsd: 0.019 },
  tokens: { input: 1400, output: 60, cacheRead: 200 },
  durationMs: 2200,
} as AgentEvent;

function recorder() {
  const rows: { sessionId: string; costUsd: number; extra?: Record<string, unknown> }[] = [];
  const usageManager = {
    record: (
      sessionId: string,
      costUsd: number,
      _d: number,
      _i?: number,
      _o?: number,
      extra?: Record<string, unknown>,
    ) => {
      rows.push({ sessionId, costUsd, extra });
      return costUsd;
    },
  } as unknown as UsageManager;
  return { rows, usageManager };
}

describe("makeInProcessGenerateText", () => {
  it("degrades to empty text with no in-process agent, and records nothing", async () => {
    const { rows, usageManager } = recorder();
    const generate = makeInProcessGenerateText({
      agentFactory: undefined,
      defaultAgentId: "claude",
      usageManager,
    });

    expect(await generate("p", "/ws", { sessionId: "s1", purpose: "pr-description" })).toBe("");
    // Container production takes exactly this branch: nothing ran, nothing spent.
    expect(rows).toHaveLength(0);
  });

  it("records an unattributed, unpriced row for a run that named a session", async () => {
    const { rows, usageManager } = recorder();
    const generate = makeInProcessGenerateText({
      agentFactory: () => fakeAgent([TEXT_EVENT, RESULT_EVENT]),
      defaultAgentId: "claude",
      usageManager,
    });

    const text = await generate("p", "/ws", { sessionId: "s1", purpose: "pr-description" });

    expect(text).toBe("## Summary\n\nDid a thing.");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe("s1");
    // NOT the reported $0.019: with no service there is no rate table, and the
    // CLI's own figure is not a substitute for one.
    expect(rows[0]!.costUsd).toBe(0);
    expect(rows[0]!.extra?.attribution).toBeUndefined();
    expect(rows[0]!.extra?.subAgentId).toBe("claude");
    expect(rows[0]!.extra?.costSource).toBe("per-turn");
    expect(rows[0]!.extra?.cacheRead).toBe(200);
  });

  // The post-interrupt commit message. It has no session to attribute to, which
  // is why `makeNonTurnGenerateText` sends it here in the first place.
  it("records nothing when the caller named no session", async () => {
    const { rows, usageManager } = recorder();
    const generate = makeInProcessGenerateText({
      agentFactory: () => fakeAgent([TEXT_EVENT, RESULT_EVENT]),
      defaultAgentId: "claude",
      usageManager,
    });

    await generate("p", "/ws");

    expect(rows).toHaveLength(0);
  });

  // A run that produced nothing usable still burned the tokens.
  it("records the row even when the run ends with no text", async () => {
    const { rows, usageManager } = recorder();
    const generate = makeInProcessGenerateText({
      agentFactory: () => fakeAgent([RESULT_EVENT], 1),
      defaultAgentId: "claude",
      usageManager,
    });

    await expect(generate("p", "/ws", { sessionId: "s1", purpose: "session-naming" }))
      .rejects.toThrow(/exited with code 1/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBe(0);
  });
});
