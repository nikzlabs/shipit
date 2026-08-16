/**
 * OpencodeAdapter conformance tests (docs/268 req 4).
 *
 * The replayed stream lines are a REAL capture from `opencode run --format
 * json --auto` (CLI 1.18.15, 2026-08-16, DeepSeek turn in a container) —
 * trimmed of noise but byte-shaped as observed, not hand-idealized. The
 * decisive cases are the lossy ones: OpenCode has no terminal result event and
 * drops trailing events under its known upstream bugs, so the adapter must
 * synthesize `agent_result` from process exit — including when the final
 * `step_finish` never arrived — and must terminate the turn itself on a fatal
 * `error` event (the CLI hangs afterwards; verified).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { OpencodeAdapter } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

/** A scriptable stand-in for the spawned CLI. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    writable: true,
    written: "" as string,
    write(data: string) {
      this.written += data;
      return true;
    },
    end: vi.fn(),
    on: vi.fn(),
  };
  pid = 4242;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  emitStdout(lines: string[]): void {
    this.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
  }

  close(code: number): void {
    this.emit("close", code);
  }
}

// Real capture: step_start → tool_use(write) → step_finish(tool-calls) →
// step_start → text → step_finish(stop). Session/message ids shortened.
const SESSION = "ses_ff550b5c6ffei9GXdIgdXXVuAD";
const CAPTURED = [
  `{"type":"step_start","timestamp":1786885656568,"sessionID":"${SESSION}","part":{"id":"prt_1","messageID":"msg_1","sessionID":"${SESSION}","type":"step-start"}}`,
  `{"type":"tool_use","timestamp":1786885657565,"sessionID":"${SESSION}","part":{"type":"tool","tool":"write","callID":"call_00_ztuU","state":{"status":"completed","input":{"filePath":"/tmp/sandbox/hello.txt","content":"hi"},"output":"Wrote file successfully.","metadata":{"filepath":"/tmp/sandbox/hello.txt","exists":false},"title":"tmp/sandbox/hello.txt","time":{"start":1786885657550,"end":1786885657562}},"id":"prt_2","sessionID":"${SESSION}","messageID":"msg_1"}}`,
  `{"type":"step_finish","timestamp":1786885657617,"sessionID":"${SESSION}","part":{"id":"prt_3","reason":"tool-calls","messageID":"msg_1","sessionID":"${SESSION}","type":"step-finish","tokens":{"total":7409,"input":41,"output":72,"reasoning":0,"cache":{"write":0,"read":7296}},"cost":0.0000463288}}`,
  `{"type":"step_start","timestamp":1786885659290,"sessionID":"${SESSION}","part":{"id":"prt_4","messageID":"msg_2","sessionID":"${SESSION}","type":"step-start"}}`,
  `{"type":"text","timestamp":1786885659860,"sessionID":"${SESSION}","part":{"id":"prt_5","messageID":"msg_2","sessionID":"${SESSION}","type":"text","text":"Its content is \`hi\`.","time":{"start":1786885659692,"end":1786885659842}}}`,
  `{"type":"step_finish","timestamp":1786885659860,"sessionID":"${SESSION}","part":{"id":"prt_6","reason":"stop","messageID":"msg_2","sessionID":"${SESSION}","type":"step-finish","tokens":{"total":7543,"input":113,"output":6,"reasoning":0,"cache":{"write":0,"read":7424}},"cost":0.0000382872}}`,
];

// Real capture of the fatal-error shape (401 against a recorder endpoint).
const ERROR_EVENT = `{"type":"error","timestamp":1786886419607,"sessionID":"${SESSION}","error":{"name":"APIError","data":{"message":"bad key","statusCode":401,"isRetryable":false}}}`;

function makeAdapter(): { adapter: OpencodeAdapter; child: FakeChild; events: AgentEvent[] } {
  const child = new FakeChild();
  const adapter = new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess });
  const events: AgentEvent[] = [];
  adapter.on("event", (e) => events.push(e));
  return { adapter, child, events };
}

const RUN_PARAMS: AgentRunParams = { prompt: "create hello.txt", cwd: "/tmp" };

describe("OpencodeAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a full captured turn and synthesizes the terminal result from exit", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);
    expect(child.stdin.written).toBe("create hello.txt");

    child.emitStdout(CAPTURED);
    child.close(0);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent_init");
    const init = events[0];
    if (init.type === "agent_init") {
      expect(init.sessionId).toBe(SESSION);
      expect(init.agentId).toBe("opencode");
    }

    // The tool call surfaces as tool_use + tool_result back-to-back.
    const assistantToolUse = events.find(
      (e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "tool_use"),
    );
    expect(assistantToolUse).toBeDefined();
    const toolResult = events.find((e) => e.type === "agent_tool_result");
    expect(toolResult).toBeDefined();

    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") {
      expect(result.status).toBe("success");
      expect(result.sessionId).toBe(SESSION);
      // Token sums across both steps (disjoint semantics — verified live).
      expect(result.tokens).toEqual({
        input: 41 + 113,
        output: 72 + 6,
        cacheRead: 7296 + 7424,
        cacheWrite: 0,
      });
      // Context occupancy = the LAST step's prompt side, not the sum.
      expect(result.contextTokens).toBe(113 + 0 + 7424 + 0);
      expect(result.cost?.totalUsd).toBeCloseTo(0.0000463288 + 0.0000382872, 10);
    }
  });

  it("REQ 4: a stream truncated before its final step_finish still terminates with a correct result", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);

    // The known upstream loss shape: the last text/step_finish never flush.
    child.emitStdout(CAPTURED.slice(0, 3));
    child.close(0);

    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") {
      // Exit 0 with no error event is still a completed turn — what the
      // accumulator saw is the truth the result reports.
      expect(result.status).toBe("success");
      expect(result.sessionId).toBe(SESSION);
      expect(result.tokens).toEqual({ input: 41, output: 72, cacheRead: 7296, cacheWrite: 0 });
    }
  });

  it("a stream with NO events at all synthesizes an error result carrying the exit code", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run({ ...RUN_PARAMS, sessionId: "ses_resume_me" });

    child.close(1);

    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") {
      expect(result.status).toBe("error");
      // Falls back to the resume id so the turn stays attributable.
      expect(result.sessionId).toBe("ses_resume_me");
      expect(result.error).toContain("exited with code 1");
    }
  });

  it("treats the error event as terminal: kills the hanging process and fails the turn", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);

    child.emitStdout([CAPTURED[0], ERROR_EVENT]);
    // The CLI hangs after a fatal error (verified) — the adapter must kill it.
    vi.advanceTimersByTime(3_000);
    expect(child.kill).toHaveBeenCalled();

    child.close(143);
    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") {
      expect(result.status).toBe("error");
      expect(result.error).toBe("bad key");
    }
    const done = vi.fn();
    adapter.on("done", done);
  });

  it("kills a CLI that survives its own final step_finish, and the turn still succeeds", () => {
    // Verified live (1.18.15): with MCP servers configured the process NEVER
    // exits after the turn — the MCP children keep it alive — so the adapter
    // must terminate it, and the resulting signal exit must not fail the turn.
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);

    child.emitStdout(CAPTURED);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6_000);
    expect(child.kill).toHaveBeenCalled();

    child.close(143);
    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") {
      expect(result.status).toBe("success");
      expect(result.error).toBeUndefined();
    }
  });

  it("a mid-turn step_start cancels the armed stop-kill (the 'final' guess was wrong)", () => {
    const { adapter, child } = makeAdapter();
    adapter.run(RUN_PARAMS);

    // A non-tool-calls finish arms the kill…
    child.emitStdout(CAPTURED.slice(0, 6));
    // …but a following step_start (the turn continuing) must disarm it.
    child.emitStdout([CAPTURED[3]]);
    vi.advanceTimersByTime(6_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("emits done after the synthesized result so the drain sees a committed turn", () => {
    const { adapter, child } = makeAdapter();
    const order: string[] = [];
    adapter.on("event", (e) => {
      if (e.type === "agent_result") order.push("result");
    });
    adapter.on("done", () => order.push("done"));
    adapter.run(RUN_PARAMS);
    child.emitStdout(CAPTURED);
    child.close(0);
    expect(order).toEqual(["result", "done"]);
  });

  it("splits buffered chunks on line boundaries (block-buffered stdout arrives in one flush)", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);
    // One giant chunk — the whole turn in a single flush, as Bun's buffering
    // actually delivers it.
    child.stdout.emit("data", Buffer.from(`${CAPTURED.join("\n")}\n`));
    child.close(0);
    expect(events.filter((e) => e.type === "agent_assistant").length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.type).toBe("agent_result");
  });

  it("refuses to spawn against routing it cannot express, instead of misrouting", () => {
    const { adapter, events } = makeAdapter();
    const errors: Error[] = [];
    adapter.on("error", (e) => errors.push(e));
    adapter.run({
      ...RUN_PARAMS,
      model: "gpt-5.5",
      serviceRouting: {
        serviceId: "openai",
        serviceName: "OpenAI",
        billingMode: "key",
        style: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        credentialSourceEnv: "OPENAI_API_KEY",
        credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("openai-responses");
    expect(events).toHaveLength(0);
  });
});
