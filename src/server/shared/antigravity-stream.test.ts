import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AntigravityUsageAccumulator,
  antigravityStderrErrorText,
  parseAntigravityLine,
} from "./antigravity-stream.js";

const PROBES = path.join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "docs/301-antigravity-harness/probes",
);

function capture(name: string): ReturnType<typeof parseAntigravityLine>[] {
  return fs
    .readFileSync(path.join(PROBES, name), "utf8")
    .split("\n")
    .map(parseAntigravityLine)
    .filter((e) => e !== null);
}

function sumTurn(name: string): AntigravityUsageAccumulator {
  const acc = new AntigravityUsageAccumulator();
  for (const event of capture(name)) {
    if (event?.event === "step_update" && event.step_update) acc.observe(event.step_update);
  }
  return acc;
}

describe("the CLI's NDJSON stream, replayed from the vendored 1.x captures", () => {
  it("parses every line of a real turn into one of the three events", () => {
    const events = capture("plugin-mcp.ndjson");
    expect(events.length).toBeGreaterThan(5);
    expect(events[0]?.event).toBe("init");
    expect(events.at(-1)?.event).toBe("result");
    for (const event of events) {
      expect(["init", "step_update", "result"]).toContain(event?.event);
    }
  });

  it("ignores non-JSON noise rather than throwing", () => {
    expect(parseAntigravityLine("")).toBeNull();
    expect(parseAntigravityLine("not json")).toBeNull();
    expect(parseAntigravityLine('{"event":"something_new"}')).toBeNull();
    expect(parseAntigravityLine("{broken")).toBeNull();
  });

  /**
   * The whole point of summing the STEPS: `result.usage` is cumulative over the
   * conversation on a resumed run, so mapping it through would bill this turn
   * for every earlier one.
   */
  it("sums the turn's own steps instead of trusting a resumed result envelope", () => {
    const events = capture("compact-b.ndjson");
    const result = events.at(-1);
    expect(result?.event).toBe("result");
    const cumulative = result?.event === "result" ? result.result?.usage?.input_tokens ?? 0 : 0;
    const turn = sumTurn("compact-b.ndjson").tokens;
    expect(turn).toBeDefined();
    // The envelope counts the earlier turn too; the steps do not.
    expect(cumulative).toBeGreaterThan(turn!.input);
  });

  it("keeps cache reads outside input, because the wire does", () => {
    for (const name of ["plugin-mcp.ndjson", "compact-b.ndjson"]) {
      for (const event of capture(name)) {
        if (event?.event !== "step_update") continue;
        const usage = event.step_update?.usage;
        if (!usage?.total_tokens) continue;
        // total = input + output holds on every captured step; cache_read is extra.
        expect(usage.total_tokens, name).toBe((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0));
        expect((usage.thinking_tokens ?? 0), name).toBeLessThanOrEqual(usage.output_tokens ?? 0);
      }
    }
  });

  it("reports context occupancy as the last step's uncached input plus its cache reads", () => {
    const acc = sumTurn("compact-b.ndjson");
    const steps = capture("compact-b.ndjson")
      .filter((e) => e?.event === "step_update")
      .map((e) => (e?.event === "step_update" ? e.step_update?.usage : undefined))
      .filter((u) => u !== undefined && (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) > 0);
    const last = steps.at(-1)!;
    expect(acc.contextTokens).toBe((last.input_tokens ?? 0) + (last.cache_read_tokens ?? 0));
    expect(acc.contextTokens).toBeGreaterThan(last.input_tokens ?? 0);
  });

  it("counts a step reported twice (ACTIVE then DONE) once", () => {
    const acc = new AntigravityUsageAccumulator();
    const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 100 };
    acc.observe({ step_index: 1, state: "ACTIVE", usage });
    acc.observe({ step_index: 1, state: "DONE", usage });
    expect(acc.tokens).toEqual({ input: 10, output: 5, cacheRead: 100, thinking: 0 });
  });

  it("reports no tokens at all when the stream carried none, rather than zeros", () => {
    expect(new AntigravityUsageAccumulator().tokens).toBeUndefined();
  });

  /**
   * `result.status` / `result.error` describe the CONVERSATION: a recovered
   * mid-turn 503 reports ERROR beside a complete answer, and a resumed turn with
   * no error of its own repeats the previous turn's. Both are in the captures,
   * which is why the adapter reads neither.
   */
  it("carries a stale or misleading result.error the adapter must not surface", () => {
    const recovered = capture("plugin-mcp.ndjson").at(-1);
    expect(recovered?.event === "result" && recovered.result?.status).toBe("ERROR");
    expect(recovered?.event === "result" && (recovered.result?.response ?? "").length).toBeGreaterThan(0);

    const resumed = capture("compact-c.ndjson").at(-1);
    expect(resumed?.event === "result" && (resumed.result?.error ?? "").length).toBeGreaterThan(0);
    expect(resumed?.event === "result" && (resumed.result?.response ?? "").length).toBeGreaterThan(0);
  });

  it("finds no text on an error_message step, which is why stderr is the source", () => {
    const errorSteps = capture("plugin-mcp.ndjson")
      .filter((e) => e?.event === "step_update" && e.step_update?.step_type === "error_message");
    expect(errorSteps.length).toBeGreaterThan(0);
    for (const step of errorSteps) {
      const s = step?.event === "step_update" ? step.step_update : undefined;
      expect(s?.text_delta).toBeUndefined();
      expect(s?.tool_info).toBeUndefined();
    }
  });

  it("names the MCP server and tool on a call_mcp_tool step", () => {
    const call = capture("plugin-mcp.ndjson").find(
      (e) => e?.event === "step_update"
        && e.step_update?.tool_name === "call_mcp_tool"
        && e.step_update.state === "DONE",
    );
    const info = call?.event === "step_update" ? call.step_update?.tool_info : undefined;
    expect(info?.parameters?.ServerName).toBe("shipitprobe_pluginprobe");
    expect(info?.parameters?.ToolName).toBe("plugin_probe");
    expect(info?.output).toBe("[plugin_probe:hi]");
  });
});

describe("the stderr error line", () => {
  it("takes the sentence the CLI printed, without the prefix", () => {
    expect(antigravityStderrErrorText(
      'error: invalid model selection (--model "gemini-3.8-flash" --effort ""): '
      + "--model gemini-3.8-flash requires --effort (available: low, medium, high)\n",
    )).toBe(
      'invalid model selection (--model "gemini-3.8-flash" --effort ""): '
      + "--model gemini-3.8-flash requires --effort (available: low, medium, high)",
    );
  });

  // req 4 — Google's eligibility refusal is the case this exists for; it must
  // arrive whole, not cut at the first newline.
  it("keeps a multi-line refusal together up to the blank line", () => {
    const text = antigravityStderrErrorText(
      "some unrelated log line\n"
      + "error: Eligibility check failed: Your current account is not eligible for Antigravity.\n"
      + "To use Antigravity you must be 18 years old or older.\n"
      + "\n"
      + "trailing noise\n",
    );
    expect(text).toBe(
      "Eligibility check failed: Your current account is not eligible for Antigravity.\n"
      + "To use Antigravity you must be 18 years old or older.",
    );
  });

  it("reports nothing when the process printed no error line", () => {
    expect(antigravityStderrErrorText("")).toBeUndefined();
    expect(antigravityStderrErrorText("just a warning\n")).toBeUndefined();
  });
});
