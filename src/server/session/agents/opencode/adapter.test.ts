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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { OpencodeAdapter } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

// Real implementation, made observable. planning#509 — an OpenCode turn ends
// with the adapter killing the CLI (with MCP servers configured it never exits
// on its own), and that kill has to take the CLI's descendants with it.
vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) };
});
import { killProcessTree } from "../../../shared/kill-child.js";

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

  close(code: number | null, signal: string | null = null): void {
    this.emit("close", code, signal);
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

  it("declares supportsReview, and names the two tools that earn it", () => {
    // planning#459 / docs/266 item 15 — chat-native review needs a shell tool
    // and a subagent primitive, and (since docs/220) no MCP surface at all.
    // Probed live at depth 0: an opencode session ran
    // `shipit agent run --role reviewer --prompt-file -` itself and returned
    // material findings; on a non-zero exit it fell back to `task`.
    const { adapter } = makeAdapter();
    expect(adapter.capabilities.supportsReview).toBe(true);
    expect(adapter.capabilities.toolNames).toContain("bash");
    expect(adapter.capabilities.toolNames).toContain("task");
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

    // The tool call surfaces as tool_use + tool_result back-to-back — with the
    // wire's lowercase name and camelCase keys normalized to the transcript
    // vocabulary (planning#432): `write`/`filePath` miss every recognition
    // registry and would render as a bare row with no diff or path.
    const assistantToolUse = events.find(
      (e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "tool_use"),
    );
    expect(assistantToolUse).toBeDefined();
    if (assistantToolUse?.type === "agent_assistant") {
      const block = assistantToolUse.content.find((b) => b.type === "tool_use");
      if (block?.type === "tool_use") {
        expect(block.name).toBe("Write");
        expect(block.input).toEqual({ file_path: "/tmp/sandbox/hello.txt", content: "hi" });
      }
    }
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

  it("unwraps the task result wrapper on the emitted tool result (planning#434 wiring)", () => {
    // The normalizer's unwrap is covered next door; this pins the one line
    // that connects it — mapEvent applying it to the emitted content — so
    // dropping the call site goes red server-side, not only in the DOM test.
    // Result shape verbatim from the 2026-08-18 docs/272 capture.
    const taskLine = `{"type":"tool_use","timestamp":1786885657565,"sessionID":"${SESSION}","part":{"type":"tool","tool":"task","callID":"call_00_task1","state":{"status":"completed","input":{"description":"Count files in repo root","prompt":"Count the files.","subagent_type":"general"},"output":"<task id=\\"ses_8f214c2af\\" state=\\"completed\\">\\n<task_result>\\n11\\n</task_result>\\n</task>"},"id":"prt_t","sessionID":"${SESSION}","messageID":"msg_1"}}`;
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);

    child.emitStdout([taskLine]);

    const toolResult = events.find((e) => e.type === "agent_tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "agent_tool_result") {
      // The event type carries `unknown[]` blocks; the adapter emits the
      // Claude-shaped tool_result block.
      const block = toolResult.content[0] as { type: string; content: string };
      expect(block.type).toBe("tool_result");
      expect(block.content).toBe("11");
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
    // planning#509 — and it takes the CLI's descendants with it. This is the
    // ordinary end of every OpenCode turn, and MCP servers are exactly what
    // leaves a browser behind.
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(
      child,
      "SIGTERM",
      expect.objectContaining({ label: "opencode" }),
    );

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

  it("a signal death mid-turn emits NO result, so the orchestrator settles it as interrupted", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);
    // Half a turn, then the user's interrupt kills the process: Node reports
    // close(null, "SIGTERM"). Synthesizing a success here would record every
    // user stop as a completed turn (review finding 1).
    child.emitStdout(CAPTURED.slice(0, 3));
    adapter.interrupt();
    child.close(null, "SIGTERM");
    expect(events.some((e) => e.type === "agent_result")).toBe(false);
  });

  it("but a signal death AFTER the final step_finish is the adapter's own stop-kill — still success", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);
    child.emitStdout(CAPTURED);
    vi.advanceTimersByTime(6_000);
    child.close(null, "SIGTERM");
    const result = events.at(-1);
    expect(result?.type).toBe("agent_result");
    if (result?.type === "agent_result") expect(result.status).toBe("success");
  });

  it("a stale interrupt escalation never kills the NEXT turn's process", () => {
    const child1 = new FakeChild();
    const child2 = new FakeChild();
    const children = [child1, child2];
    const adapter = new OpencodeAdapter({ spawnFn: () => children.shift() as unknown as ChildProcess });
    adapter.run(RUN_PARAMS);
    adapter.interrupt();
    // The first turn dies on the SIGINT; a new turn starts inside the 5s
    // escalation window.
    child1.close(null, "SIGINT");
    adapter.run(RUN_PARAMS);
    vi.advanceTimersByTime(6_000);
    expect(child2.kill).not.toHaveBeenCalled();
  });

  it("exit 0 with no events at all emits NO result (silent zero-output turn)", () => {
    const { adapter, child, events } = makeAdapter();
    adapter.run(RUN_PARAMS);
    child.close(0);
    expect(events.some((e) => e.type === "agent_result")).toBe(false);
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

  it("delivers the Zen key through the provider block, never the CLI's own name (docs/272)", () => {
    // Two variables, deliberately different. ShipIt stores OpenCode's own
    // service credential under `OPENCODE_ZEN_API_KEY`, and the adapter must
    // hand it to the CLI ONLY as the provider block's
    // `OPENCODE_PROVIDER_API_KEY`. `OPENCODE_API_KEY` — the name the CLI
    // auto-detects and would out-prefer the provider block with — stays
    // scrubbed from the spawn even when the host exports one, which is the
    // whole reason a redirected turn cannot silently bill the wrong product.
    vi.stubEnv("OPENCODE_ZEN_API_KEY", "sk-zen-secret");
    vi.stubEnv("OPENCODE_API_KEY", "sk-ambient-vendor-key");
    let spawnEnv: Record<string, string> = {};
    const child = new FakeChild();
    const adapter = new OpencodeAdapter({
      spawnFn: (_cmd, _args, opts) => {
        spawnEnv = (opts?.env ?? {}) as Record<string, string>;
        return child as unknown as ChildProcess;
      },
    });
    adapter.run({
      ...RUN_PARAMS,
      model: "glm-5.2",
      serviceRouting: {
        serviceId: "opencode",
        serviceName: "OpenCode",
        billingMode: "key",
        style: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/v1",
        credentialSourceEnv: "OPENCODE_ZEN_API_KEY",
        credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
      },
    });
    expect(spawnEnv.OPENCODE_PROVIDER_API_KEY).toBe("sk-zen-secret");
    expect(spawnEnv.OPENCODE_API_KEY).toBeUndefined();
    child.close(0);
  });

  // 2026-08-21 incident — a same-harness sub-agent spawn's isolated per-spawn
  // HOME (`AgentRunParams.homeDir`) outranks the constructor resolver, so the
  // CLI's XDG data root (auth.json + session store) resolves inside it instead
  // of the session subtree the live primary reads.
  it("prefers a per-spawn homeDir over the resolver for the CLI's HOME", () => {
    // A real, writable dir: run() materializes `$HOME/.local/share/opencode`.
    const spawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-spawn-home-"));
    try {
      let spawnEnv: Record<string, string> = {};
      const child = new FakeChild();
      const adapter = new OpencodeAdapter({
        resolveHome: () => "/credentials/provider-accounts/opencode/acct-a",
        spawnFn: (_cmd, _args, opts) => {
          spawnEnv = (opts?.env ?? {}) as Record<string, string>;
          return child as unknown as ChildProcess;
        },
      });
      adapter.run({ ...RUN_PARAMS, homeDir: spawnHome });
      expect(spawnEnv.HOME).toBe(spawnHome);
      expect(fs.existsSync(path.join(spawnHome, ".local", "share", "opencode"))).toBe(true);
      child.close(0);
    } finally {
      fs.rmSync(spawnHome, { recursive: true, force: true });
    }
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

/**
 * docs/276 — the compaction spawn. `compaction.test.ts` covers the HTTP
 * mechanism; what matters here is that this path SETTLES THE TURN on every
 * exit, including the ones that never reach the server.
 *
 * That is the load-bearing part. A compaction spawn starts no long-lived
 * `this.proc` whose `exit` would synthesize `agent_result` for it, and the
 * orchestrator's whole post-turn sequence — the local commit above all
 * (CLAUDE.md post-turn invariant 2) — hangs off that event. A refusal that
 * returned quietly would strand the session `running` forever.
 */
describe("OpencodeAdapter — compaction (docs/276)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const COMPACT_PARAMS: AgentRunParams = {
    prompt: "/compact",
    cwd: "/workspace",
    sessionId: SESSION,
    model: "anthropic/claude-sonnet-4",
    compact: true,
  };

  it("never spawns `opencode run` — the trigger is not a turn", () => {
    const child = new FakeChild();
    const spawned: string[][] = [];
    const adapter = new OpencodeAdapter({
      spawnFn: (_cmd, args) => {
        spawned.push(args);
        return child as unknown as ChildProcess;
      },
    });
    adapter.run(COMPACT_PARAMS);
    expect(spawned).toHaveLength(1);
    // `serve`, never `run`: `/compact` as an ordinary prompt would reach the
    // model verbatim and burn a turn (verified — see compaction.ts).
    expect(spawned[0][0]).toBe("serve");
    expect(spawned[0]).not.toContain("run");
  });

  it("settles the turn with an error when there is no session to compact", () => {
    const { adapter, events } = makeAdapter();
    adapter.run({ ...COMPACT_PARAMS, sessionId: undefined });
    const result = events.filter((e) => e.type === "agent_result");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "error" });
    expect((result[0] as { error: string }).error).toMatch(/has not run a turn yet/);
  });

  it("settles the turn with an error when no model is selected", () => {
    const { adapter, events } = makeAdapter();
    adapter.run({ ...COMPACT_PARAMS, model: undefined });
    const result = events.filter((e) => e.type === "agent_result");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "error" });
    expect((result[0] as { error: string }).error).toMatch(/no model is selected/);
  });

  it("emits started -> compacted -> success result on the happy path", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("true") }),
    );
    const child = new FakeChild();
    const { adapter, events } = {
      adapter: new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess }),
      events: [] as AgentEvent[],
    };
    adapter.on("event", (e) => events.push(e));
    adapter.run(COMPACT_PARAMS);
    child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_result")).toBe(true));

    expect(events.map((e) => e.type)).toEqual([
      "agent_compaction_started",
      "agent_compacted",
      "agent_result",
    ]);
    // OpenCode's summarize answers a bare `true` — no figures to report, so the
    // card degrades rather than inventing them.
    expect(events[1]).toEqual({ type: "agent_compacted", trigger: "manual" });
    expect(events[2]).toMatchObject({ status: "success", sessionId: SESSION });
  });

  it("reports a failed compaction as a failed RESULT, never a compacted card", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve("not available yet") }),
    );
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const adapter = new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.on("event", (e) => events.push(e));
    adapter.run(COMPACT_PARAMS);
    child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_result")).toBe(true));

    // The whole point: no "Context compacted" card over work that did not happen.
    expect(events.some((e) => e.type === "agent_compacted")).toBe(false);
    const result = events.find((e) => e.type === "agent_result");
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toMatch(/Compaction failed.*503/s);
  });

  it("kill() stops the transient server, which settles the turn exactly once", async () => {
    vi.useRealTimers();
    let rejectFetch: ((e: Error) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_res, rej) => { rejectFetch = rej; })));
    const child = new FakeChild();
    const events: AgentEvent[] = [];
    const adapter = new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.on("event", (e) => events.push(e));
    adapter.run(COMPACT_PARAMS);
    child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    // A compaction sets no `this.proc`, so before docs/276 this was a no-op and
    // the turn hung for the whole summarize window.
    adapter.kill();
    expect(child.kill).toHaveBeenCalled();

    // Killing the server aborts the request; the turn settles through the
    // ordinary failure path rather than hanging.
    rejectFetch?.(new Error("socket hang up"));
    await vi.waitFor(() => expect(events.some((e) => e.type === "agent_result")).toBe(true));
    expect(events.filter((e) => e.type === "agent_result")).toHaveLength(1);
    expect(events.some((e) => e.type === "agent_compacted")).toBe(false);
  });

  it("interrupt() stops the transient server too", async () => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => { /* never settles */ })));
    const child = new FakeChild();
    const adapter = new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.run(COMPACT_PARAMS);
    child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    adapter.interrupt();
    expect(child.kill).toHaveBeenCalled();
  });

  // planning#476 — the wedge these three lock is a REAL measured shape, not a
  // hypothetical: at CLI 1.18.18, a response the CLI never finishes reading
  // (body never ended, or a connection accepted and never answered) leaves
  // stdout, stderr AND the CLI's own log completely empty, with no exit. A
  // well-formed 429 is NOT that case — it reports and exits 1 after ~72 s, and
  // "maps a fatal error event" above already covers it.
  describe("stall deadline", () => {
    const DEADLINE_MS = 45 * 60_000;
    const homes: string[] = [];
    afterEach(() => {
      for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
    });

    /** A spawn HOME with a controllable CLI log directory. */
    function tempHome(withLog: boolean): { home: string; logFile: string } {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-stall-"));
      homes.push(home);
      const logDir = path.join(home, ".local", "share", "opencode", "log");
      if (withLog) fs.mkdirSync(logDir, { recursive: true });
      return { home, logFile: path.join(logDir, "run.log") };
    }

    it("ends a turn that never produced output and never exited", () => {
      const { adapter, child, events } = makeAdapter();
      const { home } = tempHome(false);
      adapter.run({ ...RUN_PARAMS, homeDir: home });

      // The measured wedge: not one byte, on any channel, ever.
      vi.advanceTimersByTime(DEADLINE_MS);
      expect(child.kill).toHaveBeenCalled();

      // And the kill has to SETTLE the turn. A signal death with no completed
      // step normally emits no result at all (that is how a user interrupt
      // reads as interrupted), so without the stall reason this would still
      // strand the turn — just with a dead process.
      child.close(null, "SIGTERM");
      const result = events.at(-1);
      expect(result?.type).toBe("agent_result");
      expect(result).toMatchObject({ status: "error" });
      if (result?.type === "agent_result") {
        expect(result.error).toMatch(/no output and showed no activity/);
      }
    });

    it("postpones on a log heartbeat, and still fires once that goes stale", () => {
      const { adapter, child } = makeAdapter();
      const { home, logFile } = tempHome(true);
      adapter.run({ ...RUN_PARAMS, homeDir: home });

      // A turn doing real work appends to the CLI's log throughout, even while
      // stdout stays empty (it is only written at exit).
      const beat = new Date(Date.now() + 60_000);
      fs.writeFileSync(logFile, "working");
      fs.utimesSync(logFile, beat, beat);

      vi.advanceTimersByTime(DEADLINE_MS);
      expect(child.kill).not.toHaveBeenCalled();

      // The postponement is exactly the remainder, not a fresh full window:
      // the CLI logs during startup on every turn, so a whole-window re-arm
      // would hand every wedge a free second window and double the worst case.
      vi.advanceTimersByTime(61_000);
      expect(child.kill).toHaveBeenCalled();
    });

    it("re-arms on output, so a turn still producing events is never cut short", () => {
      const { adapter, child } = makeAdapter();
      const { home } = tempHome(false);
      adapter.run({ ...RUN_PARAMS, homeDir: home });

      vi.advanceTimersByTime(DEADLINE_MS - 60_000);
      // A step_start alone: enough to prove liveness, and deliberately NOT a
      // final stop, which would arm the post-turn stop-kill instead.
      child.emitStdout([CAPTURED[0]]);
      vi.advanceTimersByTime(DEADLINE_MS - 60_000);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("never turns a user interrupt into a stall failure", () => {
      const { adapter, child, events } = makeAdapter();
      const { home } = tempHome(false);
      adapter.run({ ...RUN_PARAMS, homeDir: home });

      // The user interrupts a second before the deadline. The CLI is known to
      // survive SIGINT for a while, so the timer would otherwise fire into the
      // gap and relabel the interrupt as an adapter-detected failure.
      vi.advanceTimersByTime(DEADLINE_MS - 1_000);
      adapter.interrupt();
      vi.advanceTimersByTime(10 * 60_000);

      child.close(null, "SIGTERM");
      // A signal death with no completed step emits NO result — that is how the
      // runner tells an interrupt from a failure.
      expect(events.some((e) => e.type === "agent_result")).toBe(false);
    });

    it("carries no stall state into the next turn on a reused adapter", () => {
      // One adapter, two turns — the production shape: the instance outlives
      // every turn it runs.
      const children = [new FakeChild(), new FakeChild()];
      let spawned = 0;
      const adapter = new OpencodeAdapter({
        spawnFn: () => children[spawned++] as unknown as ChildProcess,
      });
      const events: AgentEvent[] = [];
      adapter.on("event", (e) => events.push(e));
      const { home } = tempHome(false);

      adapter.run({ ...RUN_PARAMS, homeDir: home });
      vi.advanceTimersByTime(DEADLINE_MS);
      children[0].close(null, "SIGTERM");
      expect(events.filter((e) => e.type === "agent_result")).toHaveLength(1);

      // The second turn succeeds. It must inherit neither the stall reason
      // (which would report a success as failed) nor a live timer from the
      // first turn (which would kill this process).
      events.length = 0;
      adapter.run({ ...RUN_PARAMS, homeDir: home });
      vi.advanceTimersByTime(DEADLINE_MS - 1_000);
      children[1].emitStdout(CAPTURED);
      children[1].close(0);

      expect(children[1].kill).not.toHaveBeenCalled();
      const result = events.at(-1);
      expect(result).toMatchObject({ type: "agent_result", status: "success" });
      if (result?.type === "agent_result") expect(result.error).toBeUndefined();
    });
  });

  it("no-ops a mid-turn compact() instead of throwing", () => {
    const child = new FakeChild();
    const errors: Error[] = [];
    const adapter = new OpencodeAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.on("error", (e) => errors.push(e));
    expect(() => adapter.compact()).not.toThrow();
    expect(errors).toHaveLength(0);
  });
});
