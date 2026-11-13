import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { Opencode2Adapter, isProviderEdgeBlock } from "./adapter.js";
import { transientProviderErrorKind } from "../../../shared/provider-errors.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";
import type { ServiceRouting } from "../../../shared/types/agent-types.js";
import { opencode2Roots } from "../../../shared/opencode-harness.js";
import { OPENCODE_ACCOUNT_MARKER } from "../../../shared/opencode-account.js";

vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(), killChild: vi.fn() };
});
import { killChild, killProcessTree } from "../../../shared/kill-child.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { written: "", write(data: string) { this.written += data; return true; }, end: vi.fn(), on: vi.fn() };
  pid = 4242;
  emitStdout(lines: string[]): void {
    this.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
  }
}

// CLI 2.1.1 captures (2026-10-27, mock provider), shortened ids. The last step_finish never arrives.
const SESSION = "ses_e80776fe0ffekLcg6G3mdKdKa6";
const TOOL_TURN = [
  `{"type":"step_start","timestamp":1793141018770,"sessionID":"${SESSION}","part":{"id":"prt_1","sessionID":"${SESSION}","messageID":"msg_1","type":"step-start"}}`,
  `{"type":"tool_use","timestamp":1793141018822,"sessionID":"${SESSION}","part":{"partID":"prt_2","sessionID":"${SESSION}","messageID":"msg_1","type":"tool","id":"call_phase0","tool":"shell","state":{"status":"completed","input":{"command":"echo phase0-tool-ran"},"output":"phase0-tool-ran\\n","title":"shell","time":{"start":1793141018773,"end":1793141018822}}}}`,
  `{"type":"step_finish","timestamp":1793141018831,"sessionID":"${SESSION}","part":{"id":"prt_3","sessionID":"${SESSION}","messageID":"msg_1","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":100,"output":12,"reasoning":0,"cache":{"read":20,"write":0}}}}`,
  `{"type":"step_start","timestamp":1793141018867,"sessionID":"${SESSION}","part":{"id":"prt_4","sessionID":"${SESSION}","messageID":"msg_2","type":"step-start"}}`,
  `{"type":"text","timestamp":1793141018873,"sessionID":"${SESSION}","part":{"id":"prt_5","sessionID":"${SESSION}","messageID":"msg_2","type":"text","text":"PHASE0-FINAL-AFTER-TOOL"}}`,
];
const ERROR_401 = [
  `{"type":"step_start","timestamp":1793141022318,"sessionID":"${SESSION}","part":{"id":"prt_1","sessionID":"${SESSION}","messageID":"msg_1","type":"step-start"}}`,
  `{"type":"error","timestamp":1793141022332,"sessionID":"${SESSION}","error":{"type":"provider.auth","message":"Incorrect API key provided (mock)","status":401,"response":{"body":"{}"}}}`,
];
// Shape of the 2026-11-13 incident: the tool result's follow-up call met Cloudflare's block page.
const CLOUDFLARE_PAGE = "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>";
const ERROR_CLOUDFLARE_403 = [
  ...TOOL_TURN.slice(0, 4),
  JSON.stringify({
    type: "error",
    timestamp: 1793141022332,
    sessionID: SESSION,
    error: {
      type: "provider.auth",
      message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare",
      status: 403,
      response: { body: CLOUDFLARE_PAGE },
    },
  }),
];
// The server's message list for the same tool turn, newest first.
const MESSAGES = {
  data: [
    { type: "idle", outcome: "succeeded" },
    { type: "assistant", tokens: { input: 130, output: 9, reasoning: 1, cache: { read: 20, write: 0 } }, cost: 0.002 },
    { type: "assistant", tokens: { input: 100, output: 12, reasoning: 0, cache: { read: 20, write: 0 } }, cost: 0.001 },
    { type: "user" },
    { type: "assistant", tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 9 },
  ],
  cursor: {},
};

const ROUTING: ServiceRouting = {
  serviceId: "deepseek",
  serviceName: "DeepSeek",
  billingMode: "key",
  style: "openai-chat-completions",
  baseUrl: "https://api.deepseek.com/v1",
  credentialSourceEnv: "DEEPSEEK_TEST_SECRET",
  credentialTarget: { kind: "env", name: "OPENCODE_PROVIDER_API_KEY" },
};

interface Harness {
  adapter: Opencode2Adapter;
  events: AgentEvent[];
  spawns: { args: string[]; opts: SpawnOptions; child: FakeChild }[];
  server: () => FakeChild;
  client: () => FakeChild;
  requests: { url: string; method: string; body?: string }[];
  inbox: Set<string>;
  /** Sends one event down the turn server's event stream. */
  serverEvent: (event: unknown) => void;
  done: Promise<number>;
}

let testHome: string;
let configs: Record<string, unknown>[];

function makeAdapter(opts: { mcp?: boolean; messages?: unknown; holdCompaction?: Promise<void> } = {}): Omit<Harness, "done"> {
  // A function answers per URL; a value is every session's list.
  const listMessages = (url: string): unknown =>
    typeof opts.messages === "function" ? (opts.messages as (url: string) => unknown)(url) : opts.messages ?? MESSAGES;
  const spawns: Harness["spawns"] = [];
  const requests: Harness["requests"] = [];
  const inbox = new Set<string>();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const serverEvent = (event: unknown): void => {
    for (const stream of streams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const spawnFn = (_cmd: string, args: string[], spawnOpts: SpawnOptions): ChildProcess => {
    const child = new FakeChild();
    spawns.push({ args, opts: spawnOpts, child });
    const configPath = (spawnOpts.env as Record<string, string> | undefined)?.OPENCODE_CONFIG;
    if (args[0] === "serve" && configPath) configs.push(JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>);
    if (args[0] === "auth") setImmediate(() => child.emit("close", 0, null));
    return child as unknown as ChildProcess;
  };
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.includes("/message/msg_c") && opts.holdCompaction) await opts.holdCompaction;
    if (url.includes("/api/event?")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          controller.enqueue(new TextEncoder().encode(`data: {"id":"evt_0","type":"server.connected","data":{}}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            streams.splice(streams.indexOf(controller), 1);
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/prompt")) {
      const id = `msg_steer${String(inbox.size + 1)}`;
      inbox.add(id);
      return new Response(JSON.stringify({ data: { id } }), { status: 200 });
    }
    if (url.endsWith("/inbox")) return new Response(JSON.stringify({ data: [...inbox].map((id) => ({ id })) }), { status: 200 });
    if (init?.method === "DELETE") {
      inbox.delete(url.split("/").pop() ?? "");
      return new Response(null, { status: 204 });
    }
    const body = url.includes("/api/mcp")
      ? { data: opts.mcp ? [{ name: "playwright", status: { status: "connected" } }, { name: "broken", status: { status: "failed", error: "spawn ENOENT" } }] : [] }
      : url.includes("/message?") ? listMessages(url) : url.endsWith("/compact") ? { data: { id: "msg_c" } } : url.includes("/message/msg_c") ? { data: { status: "completed" } } : undefined;
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new Opencode2Adapter({ spawnFn, fetchFn, backgroundPollMs: 5 });
  if (opts.mcp) {
    adapter.writeMcpConfig({
      servers: [{ type: "stdio", name: "broken", command: "nope" }],
      shipitBridge: null,
      onServerFailed: () => {},
    } as never);
  }
  const events: AgentEvent[] = [];
  adapter.on("event", (e) => events.push(e));
  const pick = (verb: string) => (): FakeChild => {
    const found = spawns.find((s) => s.args[0] === verb);
    if (!found) throw new Error(`no ${verb} spawn yet`);
    return found.child;
  };
  return { adapter, events, spawns, server: pick("serve"), client: pick("run"), requests, inbox, serverEvent };
}

function start(h: Omit<Harness, "done">, params: AgentRunParams): Harness {
  const done = new Promise<number>((resolve) => h.adapter.once("done", resolve));
  h.adapter.run(params);
  return { ...h, done };
}

async function announce(h: Harness): Promise<void> {
  await vi.waitFor(() => h.server());
  h.server().stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:41234\n"));
  await vi.waitFor(() => h.client(), { timeout: 3_000 });
}

const PARAMS: AgentRunParams = { prompt: "run it", cwd: "/tmp", model: "deepseek-v4-flash", serviceRouting: ROUTING };

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode2-adapter-test-"));
  vi.stubEnv("AGENT_HOME", testHome);
  vi.stubEnv("DEEPSEEK_TEST_SECRET", "sk-test");
  configs = [];
  vi.mocked(killProcessTree).mockClear();
  vi.mocked(killChild).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("Opencode2Adapter — per-turn server", () => {
  it("starts a private server, sends the turn to it, and reads every step's usage from it", async () => {
    const h = start(makeAdapter(), { ...PARAMS, reasoningEffort: "high", sessionId: SESSION });
    await announce(h);
    expect(h.server().stdout.listenerCount("data")).toBe(0);
    const run = h.spawns.find((s) => s.args[0] === "run")!;
    expect(run.args).toEqual([
      "run", "--format", "json", "--auto", "--session", SESSION,
      "--model", "shipit/deepseek-v4-flash#high", "--server", "http://127.0.0.1:41234",
    ]);
    expect(h.client().stdin.written).toBe("run it");
    expect(h.client().stdin.end).toHaveBeenCalled();
    h.client().emitStdout(TOOL_TURN);
    h.client().emit("close", 0, null);
    expect(await h.done).toBe(0);

    const result = h.events.find((e) => e.type === "agent_result");
    // Both steps of this turn, including the one the stream never finished; never an older turn's.
    expect(result).toMatchObject({
      status: "success",
      sessionId: SESSION,
      tokens: { input: 230, output: 22, cacheRead: 40, cacheWrite: 0 },
      cost: { totalUsd: 0.003 },
      requests: [
        { input: 100, output: 12, cacheRead: 20, cacheWrite: 0 },
        { input: 130, output: 10, cacheRead: 20, cacheWrite: 0 },
      ],
    });
    expect(h.requests.some((r) => r.url === `http://127.0.0.1:41234/api/session/${SESSION}/message?order=desc&limit=100`)).toBe(true);
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(h.server(), "SIGTERM", { label: "opencode2-server" });
  });

  it("maps 2.x tool events with `part.id` as the call id", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN);
    h.client().emit("close", 0, null);
    await h.done;
    const toolUse = h.events.flatMap((e) => (e.type === "agent_assistant" ? e.content : [])).find((b) => b.type === "tool_use");
    const toolResult = h.events.flatMap((e) => (e.type === "agent_tool_result" ? e.content : [])).find((b) => (b as { type?: string }).type === "tool_result");
    expect(toolUse).toEqual({ type: "tool_use", id: "call_phase0", name: "Bash", input: { command: "echo phase0-tool-ran" } });
    expect(toolResult).toMatchObject({ tool_use_id: "call_phase0", content: "phase0-tool-ran\n" });
    expect(h.events[0]).toMatchObject({ type: "agent_init", agentId: "opencode2", sessionId: SESSION });
  });

  it("passes on the image a read returned, as Claude's tool results carry one", async () => {
    // CLI 2.2.5 capture (2026-11-10, mock provider) of a read of a 4x4 PNG, shortened ids.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";
    const readImage = `{"type":"tool_use","timestamp":1794320149288,"sessionID":"${SESSION}","part":{"partID":"prt_2","sessionID":"${SESSION}","messageID":"msg_1","type":"tool","id":"call_1","tool":"read","state":{"status":"completed","input":{"path":"/w/a.png"},"output":"Image read successfully","title":"read","metadata":{"metadata":{"truncated":false},"content":[{"type":"text","text":"Image read successfully"},{"type":"file","uri":"data:image/png;base64,${png}","mime":"image/png","name":"/w/a.png"}],"providerCall":{"executed":false},"providerResult":{"executed":false},"rawInput":"{\\"path\\":\\"/w/a.png\\"}"},"time":{"start":1794320149254,"end":1794320149288}}}}`;
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0], readImage]);
    h.client().emit("close", 0, null);
    await h.done;
    const toolResult = h.events.flatMap((e) => (e.type === "agent_tool_result" ? e.content : [])).find((b) => (b as { type?: string }).type === "tool_result");
    expect(toolResult).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: [
        { type: "text", text: "Image read successfully" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      ],
    });
  });

  it("keeps the stream's usage when the server cannot list the messages", async () => {
    const h = start(makeAdapter({ messages: { data: "not a list" } }), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN);
    h.client().emit("close", 0, null);
    await h.done;
    expect(h.events.find((e) => e.type === "agent_result")).toMatchObject({ tokens: { input: 100, output: 12 } });
  });

  it("waits for every configured MCP server, then reports their states", async () => {
    const h = start(makeAdapter({ mcp: true }), PARAMS);
    const statuses: unknown[] = [];
    h.adapter.on("mcp_status", (s) => statuses.push(s));
    await announce(h);
    expect(h.requests[0].url).toBe(`http://127.0.0.1:41234/api/mcp?location%5Bdirectory%5D=${encodeURIComponent("/tmp")}`);
    expect(statuses).toEqual([[
      { name: "playwright", state: "loaded" },
      { name: "broken", state: "failed", reason: "spawn ENOENT" },
    ]]);
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("writes a v2-shaped config: tools that need a person off, Code Mode left on", async () => {
    const h = start(makeAdapter({ mcp: true }), PARAMS);
    await announce(h);
    const config = configs[0];
    expect(config.tools).toEqual({ question: false, websearch: false });
    const servers = (config.mcp as { servers: Record<string, { codemode?: boolean; type: string }> }).servers;
    expect(Object.keys(servers)).toEqual(["playwright", "broken"]);
    for (const server of Object.values(servers)) expect(server).not.toHaveProperty("codemode");
    expect(config.provider).toMatchObject({ shipit: { options: { apiKey: "{env:OPENCODE_PROVIDER_API_KEY}" } } });
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("turns Code Mode off for `execute` and every MCP server when the setting is off", async () => {
    const h = start(makeAdapter({ mcp: true }), { ...PARAMS, codeMode: false });
    await announce(h);
    expect(configs[0].tools).toEqual({ question: false, websearch: false, execute: false });
    const servers = (configs[0].mcp as { servers: Record<string, { codemode?: boolean }> }).servers;
    for (const server of Object.values(servers)) expect(server.codemode).toBe(false);
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("shows a Code Mode error as an error, and a failed tool's message", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    // 2.2.5 captures: a throw inside `execute` reports `completed`; a failed tool has `error`, no `output`.
    h.client().emitStdout([
      `{"type":"tool_use","sessionID":"${SESSION}","part":{"type":"tool","id":"call_x","tool":"execute","state":{"status":"completed","input":{"code":"throw new Error('boom')"},"output":"Error: boom","metadata":{"metadata":{"toolCalls":[],"error":true,"truncated":false}}}}}`,
      `{"type":"tool_use","sessionID":"${SESSION}","part":{"type":"tool","id":"call_y","tool":"read","state":{"status":"error","input":{"path":"/nope"},"error":"File not found: /nope"}}}`,
    ]);
    h.client().emit("close", 0, null);
    await h.done;
    const results = h.events.flatMap((e) => (e.type === "agent_tool_result" ? e.content : []));
    expect(results).toEqual([
      { type: "tool_result", tool_use_id: "call_x", content: "Error: boom", is_error: true },
      { type: "tool_result", tool_use_id: "call_y", content: "File not found: /nope", is_error: true },
    ]);
  });

  it("turns every tool off for a tools-off run, MCP servers included", async () => {
    const h = start(makeAdapter({ mcp: true }), { ...PARAMS, toolsOff: true });
    await announce(h);
    expect(configs[0].tools).toEqual({ "*": false });
    expect(configs[0].mcp).toBeUndefined();
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("gives OpenCode 2 its own data, state and config roots and a per-turn password", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    const env = h.spawns[0].opts.env as Record<string, string>;
    const roots = opencode2Roots(testHome);
    expect(env.XDG_DATA_HOME).toBe(roots.data);
    expect(env.XDG_STATE_HOME).toBe(roots.state);
    expect(env.OPENCODE_CONFIG_DIR).toBe(roots.config);
    expect(env.XDG_DATA_HOME.includes(".local/share/opencode/")).toBe(false);
    expect(env.PWD).toBe("/tmp");
    expect(env.OPENCODE_PASSWORD.length).toBeGreaterThan(20);
    expect(env.OPENCODE_PROVIDER_API_KEY).toBe("sk-test");
    expect((h.spawns.find((s) => s.args[0] === "run")!.opts.env as Record<string, string>).OPENCODE_PASSWORD).toBe(env.OPENCODE_PASSWORD);
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("reports the 2.x error line as an error result", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(ERROR_401);
    h.client().emit("close", 1, null);
    await h.done;
    expect(h.events.find((e) => e.type === "agent_result")).toMatchObject({
      status: "error",
      error: "Incorrect API key provided (mock)",
    });
  });

  it("settles a server that never starts with one error result and one done", async () => {
    const h = start(makeAdapter(), PARAMS);
    await vi.waitFor(() => h.server());
    h.server().stderr.emit("data", Buffer.from("boom\n"));
    h.server().emit("exit", 1, null);
    expect(await h.done).toBe(1);
    const results = h.events.filter((e) => e.type === "agent_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "error" });
    expect((results[0] as { error: string }).error).toContain("exited (code 1) before it was ready: boom");
  });

  it("ends an interrupted startup silently, with one done", async () => {
    const h = start(makeAdapter(), PARAMS);
    await vi.waitFor(() => h.server());
    h.adapter.interrupt();
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(h.server(), "SIGTERM", { label: "opencode2-interrupt" });
    h.server().emit("exit", null, "SIGTERM");
    await h.done;
    expect(h.events.filter((e) => e.type === "agent_result")).toEqual([]);
  });

  it("sends SIGINT to a running turn and emits no result for it", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN.slice(0, 2));
    h.adapter.interrupt();
    expect(vi.mocked(killChild)).toHaveBeenCalledWith(h.client(), "SIGINT");
    h.client().emit("close", null, "SIGINT");
    await h.done;
    expect(h.events.filter((e) => e.type === "agent_result")).toEqual([]);
  });

  it("emits no result for a turn the user stopped after an error line", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(ERROR_401);
    h.adapter.interrupt();
    h.client().emit("close", 1, null);
    await h.done;
    expect(h.events.filter((e) => e.type === "agent_result")).toEqual([]);
  });

  it("reports nothing for a compaction the user stopped, even if it then completed", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = start(makeAdapter({ holdCompaction: held }), { ...PARAMS, compact: true, sessionId: SESSION, prompt: "" });
    await vi.waitFor(() => h.server());
    h.server().stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:41234\n"));
    await vi.waitFor(() => expect(h.requests.some((r) => r.url.includes("/message/msg_c"))).toBe(true));
    h.adapter.interrupt();
    release();
    await h.done;
    expect(h.events.filter((e) => e.type === "agent_result" || e.type === "agent_compacted")).toEqual([]);
  });

  it("compacts through the turn's server on the selected model", async () => {
    const h = start(makeAdapter(), { ...PARAMS, compact: true, sessionId: SESSION, prompt: "" });
    await vi.waitFor(() => h.server());
    h.server().stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:41234\n"));
    expect(await h.done).toBe(0);
    const posts = h.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.url)).toEqual([
      `http://127.0.0.1:41234/api/session/${SESSION}/model`,
      `http://127.0.0.1:41234/api/session/${SESSION}/compact`,
    ]);
    expect(JSON.parse(posts[0].body!)).toEqual({ model: { providerID: "shipit", id: "deepseek-v4-flash" } });
    expect(h.events.map((e) => e.type)).toEqual(["agent_compaction_started", "agent_compacted", "agent_result"]);
    expect(h.spawns.some((s) => s.args[0] === "run")).toBe(false);
  });
});

describe("Opencode2Adapter — tool calls shown as they start", () => {
  // CLI 2.2.5 server events (2026-11-10, mock provider, `sleep 4` shell call), shortened ids.
  const inputStarted = (id: string, name: string, sessionID = SESSION) => ({
    id: "evt_1", type: "session.tool.input.started", data: { sessionID, assistantMessageID: "msg_1", id, name },
  });
  const called = (id: string, input: Record<string, unknown>, sessionID = SESSION) => ({
    id: "evt_2", type: "session.tool.called", data: { sessionID, assistantMessageID: "msg_1", id, input, executed: false },
  });
  const toolUses = (h: Harness) => h.events.flatMap((e) => (e.type === "agent_assistant" ? e.content : [])).filter((b) => b.type === "tool_use");
  const toolResults = (h: Harness) => h.events.filter((e) => e.type === "agent_tool_result");

  it("subscribes to the turn server's tool-start events before the turn is sent", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    const stream = h.requests.find((r) => r.url.includes("/api/event?"));
    expect(stream?.url).toBe(
      "http://127.0.0.1:41234/api/event?types=session.tool.input.started&types=session.tool.called"
      + "&types=session.text.started&types=session.text.ended&types=session.tool.progress",
    );
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("shows a call below the text written before it, which the server ends after the call starts", async () => {
    const text = (type: string, extra: Record<string, unknown> = {}, sessionID = SESSION, assistantMessageID = "msg_1") => ({
      id: "evt_t", type, data: { sessionID, assistantMessageID, ordinal: 0, ...extra },
    });
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.serverEvent(text("session.text.started", {}, "ses_child", "msg_child"));
    h.serverEvent(text("session.text.started"));
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "ls" }));
    h.serverEvent(text("session.text.ended", { text: "Let me run it." }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toolUses(h)).toEqual([]);

    h.client().emitStdout([
      `{"type":"text","timestamp":2,"sessionID":"${SESSION}","part":{"id":"prt_t","sessionID":"${SESSION}","messageID":"msg_1","type":"text","text":"Let me run it."}}`,
    ]);
    const blocks = h.events.flatMap((e) => (e.type === "agent_assistant" ? e.content : []));
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("does not hold a call behind text that stdout printed before the server's start reached it", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([
      TOOL_TURN[0],
      `{"type":"text","timestamp":2,"sessionID":"${SESSION}","part":{"id":"prt_t","sessionID":"${SESSION}","messageID":"msg_1","type":"text","text":"Let me run it."}}`,
    ]);
    h.serverEvent({ id: "evt_t", type: "session.text.started", data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0 } });
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "ls" }));
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(1));
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("ignores a text start that arrives after stdout printed its step's end", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN.slice(0, 3));
    h.serverEvent({ id: "evt_t", type: "session.text.started", data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0 } });
    h.serverEvent(inputStarted("call_next", "shell"));
    h.serverEvent(called("call_next", { command: "ls" }));
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(2));
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("does not hold a call behind text that ends empty", async () => {
    const text = (type: string, extra: Record<string, unknown> = {}) => ({
      id: "evt_t", type, data: { sessionID: SESSION, assistantMessageID: "msg_1", ordinal: 0, ...extra },
    });
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.serverEvent(text("session.text.started"));
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "ls" }));
    h.serverEvent(text("session.text.ended", { text: "" }));
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(1));
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("shows a long call when it starts, then adds only its result when it finishes", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "echo phase0-tool-ran" }));
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(1));
    expect(toolUses(h)[0]).toEqual({ type: "tool_use", id: "call_phase0", name: "Bash", input: { command: "echo phase0-tool-ran" } });
    expect(toolResults(h)).toEqual([]);

    h.client().emitStdout(TOOL_TURN.slice(1));
    h.client().emit("close", 0, null);
    await h.done;
    expect(toolUses(h)).toHaveLength(1);
    expect(toolResults(h)).toEqual([
      { type: "agent_tool_result", content: [{ type: "tool_result", tool_use_id: "call_phase0", content: "phase0-tool-ran\n" }] },
    ]);
    const kinds = h.events.map((e) => e.type).filter((t) => t === "agent_assistant" || t === "agent_tool_result");
    expect(kinds).toEqual(["agent_assistant", "agent_tool_result", "agent_assistant"]);
  });

  it("still emits both halves for a call whose start it never saw", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN);
    h.client().emit("close", 0, null);
    await h.done;
    expect(toolUses(h).map((b) => (b as { id: string }).id)).toEqual(["call_phase0"]);
    expect(toolResults(h)).toHaveLength(1);
  });

  it("ignores a start that arrives after the call finished", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout(TOOL_TURN.slice(0, 2));
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "echo phase0-tool-ran" }));
    h.client().emitStdout(TOOL_TURN.slice(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.client().emit("close", 0, null);
    await h.done;
    expect(toolUses(h)).toHaveLength(1);
    expect(toolResults(h)).toHaveLength(1);
  });

  it("posts no new call after the user stopped the turn", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.adapter.interrupt();
    h.serverEvent(inputStarted("call_late", "shell"));
    h.serverEvent(called("call_late", { command: "ls" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.client().emit("close", null, "SIGINT");
    await h.done;
    expect(toolUses(h)).toEqual([]);
  });

  it("does not take a call's name from another session's call with the same id", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.serverEvent(inputStarted("call_1", "shell"));
    h.serverEvent(inputStarted("call_1", "read", "ses_child"));
    h.serverEvent(called("call_1", { path: "/x" }, "ses_child"));
    h.serverEvent(called("call_1", { command: "ls" }));
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(1));
    expect(toolUses(h)[0]).toMatchObject({ id: "call_1", name: "Bash", input: { command: "ls" } });
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("holds a start until the turn names its session, and drops another session's calls", async () => {
    const h = start(makeAdapter(), PARAMS);
    await announce(h);
    h.serverEvent(inputStarted("call_child", "shell", "ses_child"));
    h.serverEvent(called("call_child", { command: "ls" }, "ses_child"));
    h.serverEvent(inputStarted("call_phase0", "shell"));
    h.serverEvent(called("call_phase0", { command: "echo phase0-tool-ran" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.events).toEqual([]);

    h.client().emitStdout([TOOL_TURN[0]]);
    await vi.waitFor(() => expect(toolUses(h)).toHaveLength(1));
    expect(h.events[0]).toMatchObject({ type: "agent_init" });
    expect((toolUses(h)[0] as { id: string }).id).toBe("call_phase0");
    h.client().emit("close", 0, null);
    await h.done;
  });
});

describe("Opencode2Adapter — background subagents", () => {
  // CLI 2.2.5 capture (2026-11-11, DeepSeek), shortened ids and launch note.
  const CHILD = "ses_child1";
  const ACK = `The subagent is working in the background (sessionID: ${CHILD}). You will be notified automatically when it finishes.\nDO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work.`;
  const LAUNCH = [
    `{"type":"step_start","timestamp":1,"sessionID":"${SESSION}","part":{"id":"prt_1","sessionID":"${SESSION}","messageID":"msg_1","type":"step-start"}}`,
    JSON.stringify({
      type: "tool_use", timestamp: 2, sessionID: SESSION,
      part: {
        partID: "prt_2", sessionID: SESSION, messageID: "msg_1", type: "tool", id: "call_bg", tool: "subagent",
        state: {
          status: "completed",
          input: { agent: "general", description: "Probe sleep", prompt: "sleep", background: true },
          output: ACK, title: "subagent",
          metadata: { metadata: { sessionID: CHILD, status: "running", truncated: false }, content: [{ type: "text", text: ACK }] },
        },
      },
    }),
    `{"type":"step_finish","timestamp":3,"sessionID":"${SESSION}","part":{"id":"prt_3","sessionID":"${SESSION}","messageID":"msg_1","type":"step-finish","reason":"tool-calls","cost":0,"tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}}}`,
    `{"type":"text","timestamp":4,"sessionID":"${SESSION}","part":{"id":"prt_4","sessionID":"${SESSION}","messageID":"msg_2","type":"text","text":"launched"}}`,
  ];
  const tokens = (input: number) => ({ input, output: 5, reasoning: 0, cache: { read: 0, write: 0 } });
  // Newest first, as the server lists them.
  const AT_EXIT = [
    { id: "msg_idle1", type: "idle", outcome: "succeeded" },
    { id: "msg_2", type: "assistant", finish: "stop", time: { completed: 5 }, tokens: tokens(120), content: [{ type: "text", text: "launched" }] },
    { id: "msg_1", type: "assistant", finish: "tool-calls", time: { completed: 3 }, tokens: tokens(100), content: [] },
    { id: "msg_0", type: "user", text: "run it" },
  ];
  const NOTICE = {
    id: "msg_note", type: "synthetic", description: "Probe sleep",
    text: `<subagent sessionID="${CHILD}" state="completed" description="Probe sleep">\nDONE-PROBE\n</subagent>`,
    metadata: { source: "subagent", childID: CHILD, agent: "General", state: "completed" },
  };
  const REPLY = {
    id: "msg_3", type: "assistant", finish: "stop", time: { completed: 9 }, tokens: tokens(140),
    content: [
      { type: "text", text: "GOT-IT" },
      { type: "tool", id: "call_after", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a.txt" }], metadata: {} } },
    ],
  };

  it("keeps the turn open until the subagent reports, puts the report on its card, and shows the parent's reply", async () => {
    let messages: unknown[] = AT_EXIT;
    const h = start(makeAdapter({ messages: (url: string) => ({ data: url.includes(CHILD) ? [] : messages, cursor: {} }) }), PARAMS);
    await announce(h);
    h.client().emitStdout(LAUNCH);
    h.client().emit("close", 0, null);

    await vi.waitFor(() => expect(h.requests.filter((r) => r.url.includes("/message?")).length).toBeGreaterThan(1));
    expect(h.events.some((e) => e.type === "agent_result")).toBe(false);
    expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();
    const ackResult = h.events.find((e) => e.type === "agent_tool_result");
    expect(ackResult).toMatchObject({ content: [{ tool_use_id: "call_bg", content: ACK }] });

    // The report, then the parent's own reply to it, still in progress.
    messages = [{ id: "msg_3", type: "assistant", time: {}, content: [] }, NOTICE, ...AT_EXIT];
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "agent_self_wake")).toBe(true));
    messages = [{ id: "msg_idle2", type: "idle", outcome: "succeeded" }, REPLY, NOTICE, ...AT_EXIT];
    expect(await h.done).toBe(0);

    expect(h.events.find((e) => e.type === "agent_self_wake")).toEqual({
      type: "agent_self_wake", taskId: CHILD, toolUseId: "call_bg", status: "completed", summary: "DONE-PROBE",
    });
    const after = h.events.slice(h.events.findIndex((e) => e.type === "agent_self_wake") + 1);
    expect(after.map((e) => e.type)).toEqual(["agent_assistant", "agent_assistant", "agent_tool_result", "agent_result"]);
    expect(after[0]).toEqual({ type: "agent_assistant", content: [{ type: "text", text: "GOT-IT" }] });
    expect(after[1]).toMatchObject({ content: [{ type: "tool_use", id: "call_after", name: "Bash", input: { command: "ls" } }] });
    expect(after[2]).toMatchObject({ content: [{ tool_use_id: "call_after", content: "a.txt" }] });
    expect(after[3]).toMatchObject({ status: "success", requests: [{ input: 100 }, { input: 120 }, { input: 140 }] });
    // Only the messages after `run` exited are shown here: `run` printed the rest.
    expect(h.events.filter((e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "text" && b.text === "launched"))).toHaveLength(1);
  });

  it("shows a reply the parent finished before the first look, and rides out a failed one", async () => {
    let calls = 0;
    const messages = (url: string): unknown => {
      if (url.includes(CHILD)) return { data: [], cursor: {} };
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return { data: [{ id: "msg_idle2", type: "idle" }, REPLY, NOTICE, ...AT_EXIT], cursor: {} };
    };
    const h = start(makeAdapter({ messages }), PARAMS);
    await announce(h);
    h.client().emitStdout(LAUNCH);
    h.client().emit("close", 0, null);
    expect(await h.done).toBe(0);
    expect(h.events.find((e) => e.type === "agent_self_wake")).toMatchObject({ toolUseId: "call_bg", status: "completed" });
    expect(h.events.some((e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "text" && b.text === "GOT-IT"))).toBe(true);
    expect(h.events.filter((e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "text" && b.text === "launched"))).toHaveLength(1);
  });

  it("ends the turn as an error when the server stops answering while it waits", async () => {
    const h = start(makeAdapter({ messages: () => { throw new Error("connection refused"); } }), PARAMS);
    await announce(h);
    h.client().emitStdout(LAUNCH);
    h.client().emit("close", 0, null);
    await h.done;
    expect(h.events.find((e) => e.type === "agent_self_wake")).toMatchObject({ toolUseId: "call_bg", status: "stopped" });
    expect(h.events.find((e) => e.type === "agent_result")).toMatchObject({ status: "error", error: expect.stringContaining("connection refused") });
  });

  it("marks a subagent still running when the user stops the turn as stopped", async () => {
    const h = start(makeAdapter({ messages: { data: AT_EXIT, cursor: {} } }), PARAMS);
    await announce(h);
    h.client().emitStdout(LAUNCH);
    h.client().emit("close", 0, null);
    await vi.waitFor(() => expect(h.requests.filter((r) => r.url.includes("/message?")).length).toBeGreaterThan(1));

    h.adapter.interrupt();
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(h.server(), "SIGTERM", { label: "opencode2-interrupt" });
    expect(await h.done).toBe(0);
    expect(h.events.find((e) => e.type === "agent_self_wake")).toEqual({
      type: "agent_self_wake", taskId: CHILD, toolUseId: "call_bg", status: "stopped",
    });
    expect(h.events.some((e) => e.type === "agent_result")).toBe(false);
  });

  it("does not wait when `run` failed, and marks the subagent stopped", async () => {
    const h = start(makeAdapter({ messages: { data: AT_EXIT, cursor: {} } }), PARAMS);
    await announce(h);
    h.client().emitStdout(LAUNCH);
    h.client().emit("close", 1, null);
    expect(await h.done).toBe(1);
    const kinds = h.events.map((e) => e.type);
    expect(kinds.indexOf("agent_self_wake")).toBeLessThan(kinds.indexOf("agent_result"));
    expect(h.events.find((e) => e.type === "agent_self_wake")).toMatchObject({ toolUseId: "call_bg", status: "stopped" });
  });
});

describe("Opencode2Adapter — a subagent's own work", () => {
  // CLI 2.2.5 capture (2026-11-11, DeepSeek), shortened ids.
  const CHILD = "ses_child2";
  const PROGRESS = {
    id: "evt_p", type: "session.tool.progress",
    data: { sessionID: SESSION, assistantMessageID: "msg_1", id: "call_fg", metadata: { sessionID: CHILD, status: "running" } },
  };
  const CHILD_WORK = [
    { id: "msg_c1", type: "assistant", time: { completed: 2 }, content: [
      { type: "tool", id: "call_echo", name: "shell", state: { status: "completed", input: { command: "echo one" }, content: [{ type: "text", text: "one\n" }], metadata: {} } },
    ] },
    { id: "msg_cu", type: "user", text: "You are a subagent spawned by another session." },
  ];
  const report = `<subagent sessionID="${CHILD}" state="completed">\nDONE\n</subagent>`;
  const FINISHED = JSON.stringify({
    type: "tool_use", timestamp: 3, sessionID: SESSION,
    part: {
      sessionID: SESSION, messageID: "msg_1", type: "tool", id: "call_fg", tool: "subagent",
      state: {
        status: "completed", input: { agent: "general", description: "Two steps", prompt: "go" }, output: report,
        metadata: { metadata: { sessionID: CHILD, status: "completed" }, content: [{ type: "text", text: report }] },
      },
    },
  });
  const nested = (h: Harness) => h.events.filter((e) => (e as { parentToolUseId?: string }).parentToolUseId === "call_fg");

  it("posts a running subagent's calls under its card, all before the turn's result", async () => {
    let child: unknown[] = [];
    const h = start(makeAdapter({ messages: (url: string) => ({ data: url.includes(CHILD) ? child : MESSAGES.data, cursor: {} }) }), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0]]);
    h.serverEvent({ id: "evt_1", type: "session.tool.input.started", data: { sessionID: SESSION, assistantMessageID: "msg_1", id: "call_fg", name: "subagent" } });
    h.serverEvent({ id: "evt_2", type: "session.tool.called", data: { sessionID: SESSION, assistantMessageID: "msg_1", id: "call_fg", input: { agent: "general", description: "Two steps", prompt: "go" } } });
    h.serverEvent(PROGRESS);
    child = CHILD_WORK;
    await vi.waitFor(() => expect(nested(h)).toHaveLength(2));
    // The launching call is in the transcript first, or its work would have nowhere to go.
    const launch = h.events.findIndex((e) => e.type === "agent_assistant" && e.content.some((b) => b.type === "tool_use" && b.id === "call_fg"));
    expect(launch).toBeGreaterThanOrEqual(0);
    expect(launch).toBeLessThan(h.events.indexOf(nested(h)[0]));
    expect(nested(h)[0]).toMatchObject({ type: "agent_assistant", content: [{ type: "tool_use", id: "call_echo", name: "Bash" }] });
    expect(nested(h)[1]).toMatchObject({ type: "agent_tool_result", content: [{ tool_use_id: "call_echo", content: "one\n" }] });

    child = [{ id: "msg_c2", type: "assistant", time: { completed: 4 }, content: [{ type: "text", text: "DONE" }] }, ...CHILD_WORK];
    h.client().emitStdout([FINISHED]);
    h.client().emit("close", 0, null);
    await h.done;
    expect(nested(h).map((e) => e.type)).toEqual(["agent_assistant", "agent_tool_result", "agent_assistant"]);
    expect(nested(h)[2]).toMatchObject({ content: [{ type: "text", text: "DONE" }] });
    const kinds = h.events.map((e) => e.type);
    expect(h.events.indexOf(nested(h)[2])).toBeLessThan(kinds.indexOf("agent_result"));
  });

  it("still reads a finished subagent's work when the progress event never came", async () => {
    const h = start(makeAdapter({ messages: (url: string) => ({ data: url.includes(CHILD) ? CHILD_WORK : MESSAGES.data, cursor: {} }) }), PARAMS);
    await announce(h);
    h.client().emitStdout([TOOL_TURN[0], FINISHED]);
    h.client().emit("close", 0, null);
    await h.done;
    expect(nested(h).map((e) => e.type)).toEqual(["agent_assistant", "agent_tool_result"]);
  });
});

describe("Opencode2Adapter — live steering (planning#707)", () => {
  const STEERED_MESSAGES = {
    data: [
      { type: "idle", outcome: "succeeded" },
      { id: "msg_a2", type: "assistant", tokens: { input: 130, output: 9, reasoning: 1, cache: { read: 20, write: 0 } }, cost: 0.002 },
      { id: "msg_steer1", type: "user" },
      { id: "msg_a1", type: "assistant", tokens: { input: 100, output: 12, reasoning: 0, cache: { read: 20, write: 0 } }, cost: 0.001 },
      { id: "msg_u1", type: "user" },
      { id: "msg_old", type: "assistant", tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 9 },
    ],
    cursor: {},
  };
  const types = (h: Harness) => h.events.map((e) => e.type).filter((t) => t.startsWith("agent_steer") || t === "agent_user_replay" || t === "agent_result");

  it("declares steering", () => {
    expect(new Opencode2Adapter().capabilities.supportsSteering).toBe(true);
  });

  it("sends a steer once the turn has its prompt, acknowledges it at a step, and counts the steps on both sides of it", async () => {
    const h = start(makeAdapter({ messages: STEERED_MESSAGES }), { ...PARAMS, sessionId: SESSION });
    await announce(h);
    h.adapter.sendUserMessage("also run the linter");
    await Promise.resolve();
    expect(h.requests.some((r) => r.url.endsWith("/prompt"))).toBe(false);

    h.client().emitStdout([TOOL_TURN[0]]);
    await vi.waitFor(() => expect(h.inbox.size).toBe(1));
    const steer = h.requests.find((r) => r.url.endsWith("/prompt"))!;
    expect(steer.url).toBe(`http://127.0.0.1:41234/api/session/${SESSION}/prompt`);
    expect(JSON.parse(steer.body!)).toEqual({ text: "also run the linter", delivery: "steer", resume: false });

    h.inbox.clear();
    h.client().emitStdout(TOOL_TURN.slice(1));
    await vi.waitFor(() => expect(types(h)).toEqual(["agent_user_replay"]));
    expect(h.events.find((e) => e.type === "agent_user_replay")).toEqual({ type: "agent_user_replay", text: "also run the linter" });

    h.client().emit("close", 0, null);
    expect(await h.done).toBe(0);
    expect(types(h)).toEqual(["agent_user_replay", "agent_result"]);
    expect(h.events.find((e) => e.type === "agent_result")).toMatchObject({
      status: "success",
      tokens: { input: 230, output: 22, cacheRead: 40, cacheWrite: 0 },
    });
  });

  it("takes back a steer the turn never read, before the result", async () => {
    const h = start(makeAdapter(), { ...PARAMS, sessionId: SESSION });
    await announce(h);
    h.client().emitStdout(TOOL_TURN);
    h.adapter.sendUserMessage("too late");
    await vi.waitFor(() => expect(h.inbox.size).toBe(1));

    h.client().emit("close", 0, null);
    await h.done;
    expect(types(h)).toEqual(["agent_steer_rejected", "agent_result"]);
    expect(h.inbox.size).toBe(0);
    expect(h.requests.some((r) => r.method === "DELETE" && r.url.endsWith(`/inbox/msg_steer1`))).toBe(true);
  });

  it("emits the result only once the turn's server is gone, right before done", async () => {
    const h = start(makeAdapter(), { ...PARAMS, sessionId: SESSION });
    await announce(h);
    const order: string[] = [];
    h.adapter.on("event", (e) => {
      if (e.type !== "agent_result") return;
      const serverKilled = vi.mocked(killProcessTree).mock.calls.some(([, , opts]) => opts?.label === "opencode2-server");
      order.push(serverKilled ? "result-after-teardown" : "result-before-teardown");
    });
    h.adapter.on("done", () => order.push("done"));
    h.client().emitStdout(TOOL_TURN);
    h.client().emit("close", 0, null);
    await h.done;
    expect(order).toEqual(["result-after-teardown", "done"]);
  });

  it("refuses a steer during a compaction at once", async () => {
    const h = start(makeAdapter(), { ...PARAMS, sessionId: SESSION, compact: true });
    h.adapter.sendUserMessage("not now");
    expect(h.events).toEqual([{ type: "agent_steer_rejected", text: "not now" }]);
    h.server().stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:41234\n"));
    await h.done;
  });
});

describe("Opencode2Adapter — ChatGPT route", () => {
  const ACCOUNT_ROUTING: ServiceRouting = {
    serviceId: "openai",
    serviceName: "OpenAI",
    billingMode: "sub",
    style: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    credentialTarget: { kind: "openai-chatgpt", accountId: "route-1" },
  } as ServiceRouting;

  function project(): string {
    const account = opencode2Roots(testHome).account;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.sig`;
    fs.mkdirSync(path.join(account, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(account, OPENCODE_ACCOUNT_MARKER), JSON.stringify({ id: "b", accountId: "route-1", identity: "acct-1", dataHome: account }));
    fs.writeFileSync(path.join(account, "opencode", "auth.json"), JSON.stringify({ openai: { type: "oauth", access, refresh: "", expires: exp * 1000, accountId: "acct-1" } }));
    return access;
  }

  it("asks for sign-in before spawning anything when no projection exists", () => {
    const h = makeAdapter();
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    h.adapter.run({ ...PARAMS, model: "gpt-6-luna", serviceRouting: ACCOUNT_ROUTING });
    expect(auth).toBe(1);
    expect(h.spawns).toEqual([]);
  });

  it("imports the token through the turn's server before the turn, and treats a 401 as a sign-in problem", async () => {
    project();
    const h = start(makeAdapter(), { ...PARAMS, model: "gpt-6-luna", reasoningEffort: "low", serviceRouting: ACCOUNT_ROUTING });
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    await announce(h);
    const verbs = h.spawns.map((s) => s.args.slice(0, 2).join(" "));
    expect(verbs).toEqual(["serve --port", "auth import", "auth switch", "run --format"]);
    for (const s of h.spawns.filter((x) => x.args[0] === "auth")) expect(s.args.slice(-2)).toEqual(["--server", "http://127.0.0.1:41234"]);
    expect(h.spawns.find((s) => s.args[0] === "run")!.args).toContain("openai/gpt-6-luna#low");
    const env = h.spawns[0].opts.env as Record<string, string>;
    expect(Object.keys(env).filter((k) => k.startsWith("OPENAI_"))).toEqual([]);
    h.client().emitStdout(ERROR_401);
    h.client().emit("close", 1, null);
    await h.done;
    expect(auth).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(opencode2Roots(testHome).data, ".shipit-chatgpt-credential.json"), "utf8")) as { id: string };
    expect(state.id).toMatch(/^shipit-[0-9a-f]{24}$/);
  });
});

describe("Opencode2Adapter — Claude route (docs/340)", () => {
  const CLAUDE_ROUTING: ServiceRouting = {
    serviceId: "anthropic",
    serviceName: "Anthropic",
    billingMode: "sub",
    style: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    credentialTarget: { kind: "anthropic-oauth", accountId: "route-c" },
  };

  function provisionClaudeLogin(): void {
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(testHome, ".claude", ".credentials.json"), "{}");
  }

  it("asks for sign-in before spawning anything when the session holds no Claude login", () => {
    const h = makeAdapter();
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    h.adapter.run({ ...PARAMS, model: "claude-opus-5-5", serviceRouting: CLAUDE_ROUTING });
    expect(auth).toBe(1);
    expect(h.spawns).toEqual([]);
  });

  it("runs the catalogue model on the built-in claude-agent provider, with no ChatGPT credential and no Anthropic override", async () => {
    provisionClaudeLogin();
    // A ChatGPT turn in this home left its credential in OpenCode 2's database.
    const roots = opencode2Roots(testHome);
    fs.mkdirSync(roots.data, { recursive: true });
    fs.writeFileSync(path.join(roots.data, ".shipit-chatgpt-credential.json"), JSON.stringify({ id: "shipit-old", stale: [] }));
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const h = start(makeAdapter(), { ...PARAMS, model: "claude-opus-5-5", reasoningEffort: "minimal", serviceRouting: CLAUDE_ROUTING });
    await announce(h);
    const run = h.spawns.find((s) => s.args[0] === "run")!;
    // `minimal` is no Claude effort, so the provider default applies.
    expect(run.args).toContain("claude-agent/claude-opus-5-5");
    expect(configs[0]?.provider).toEqual({
      "claude-agent": { models: { "claude-opus-5-5": expect.objectContaining({ id: "claude-opus-5-5[1m]" }) as unknown } },
    });
    expect(configs[0]?.enabled_providers).toEqual(["claude-agent"]);
    // The leftover ChatGPT credential's logout is requested on the turn's server before the turn.
    const verbs = h.spawns.map((s) => s.args.slice(0, 4).join(" "));
    expect(verbs.indexOf("auth logout openai shipit-old")).toBeGreaterThan(-1);
    expect(verbs.indexOf("auth logout openai shipit-old")).toBeLessThan(verbs.findIndex((v) => v.startsWith("run ")));
    const env = h.spawns[0].opts.env as Record<string, string>;
    expect(env.HOME).toBe(testHome);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // No ChatGPT import: the turn's server only had any previous credential cleared.
    expect(h.spawns.some((s) => s.args[0] === "auth" && s.args[1] === "import")).toBe(false);
    h.client().emit("close", 0, null);
    await h.done;
  });

  it("treats a 401 as a sign-in problem", async () => {
    provisionClaudeLogin();
    const h = start(makeAdapter(), { ...PARAMS, model: "claude-opus-5-5", reasoningEffort: "high", serviceRouting: CLAUDE_ROUTING });
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    await announce(h);
    expect(h.spawns.find((s) => s.args[0] === "run")!.args).toContain("claude-agent/claude-opus-5-5#high");
    h.client().emitStdout(ERROR_401);
    h.client().emit("close", 1, null);
    await h.done;
    expect(auth).toBe(1);
    expect(h.events.some((e) => e.type === "agent_assistant" && e.synthetic)).toBe(false);
  });

  it("shows a Cloudflare 403 block in the chat and does not ask for sign-in", async () => {
    provisionClaudeLogin();
    const h = start(makeAdapter(), { ...PARAMS, model: "claude-opus-5-5", serviceRouting: CLAUDE_ROUTING });
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    await announce(h);
    // Reported twice, shown once.
    h.client().emitStdout([...ERROR_CLOUDFLARE_403, ERROR_CLOUDFLARE_403[ERROR_CLOUDFLARE_403.length - 1]]);
    h.client().emit("close", 1, null);
    await h.done;
    expect(auth).toBe(0);
    const notices = h.events.filter((e) => e.type === "agent_assistant" && e.synthetic);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    expect(notice).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Cloudflare at api.anthropic.com") as unknown }] });
    expect(JSON.stringify(notice)).toContain("Signing in again will not help");
    expect(JSON.stringify(notice)).toContain("Sending your message again later usually works");
    const result = h.events.find((e) => e.type === "agent_result");
    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("Cloudflare") as unknown });
    expect(JSON.stringify(result)).not.toContain("<html");
    // docs/342-transient-provider-retry — the turn executor reads this as a temporary error.
    expect(transientProviderErrorKind((result as { error?: string }).error)).toBe("edge-block");
  });

  it("reports an overloaded model as a temporary error, not a sign-in problem", async () => {
    provisionClaudeLogin();
    const h = start(makeAdapter(), { ...PARAMS, model: "claude-opus-5-5", serviceRouting: CLAUDE_ROUTING });
    let auth = 0;
    h.adapter.on("auth_required", () => { auth++; });
    await announce(h);
    h.client().emitStdout([
      ...TOOL_TURN.slice(0, 4),
      JSON.stringify({
        type: "error",
        timestamp: 1793141022332,
        sessionID: SESSION,
        error: { type: "provider.api", message: "Overloaded", status: 529 },
      }),
    ]);
    h.client().emit("close", 1, null);
    await h.done;
    expect(auth).toBe(0);
    const result = h.events.find((e) => e.type === "agent_result");
    expect(result).toMatchObject({ status: "error" });
    expect(transientProviderErrorKind((result as { error?: string }).error)).toBe("overloaded");
  });
});

describe("isProviderEdgeBlock", () => {
  it.each([
    ["the CLI's message alone", { message: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" }, true],
    ["a 403 with an HTML body", { status: 403, message: "Forbidden", response: { body: "<!DOCTYPE html><html>no</html>" } }, true],
    ["a v1 403 naming Cloudflare", { name: "APIError", data: { statusCode: 403, message: "blocked by Cloudflare" } }, true],
    ["a real 401", { type: "provider.auth", status: 401, message: "Incorrect API key provided" }, false],
    ["a 401 that carries the block page's title", { type: "provider.auth", status: 401, message: "Attention Required! | Cloudflare" }, false],
    ["a JSON 403", { status: 403, message: "permission_error", response: { body: "{\"type\":\"error\"}" } }, false],
    ["no error", undefined, false],
  ])("%s", (_label, error, expected) => {
    expect(isProviderEdgeBlock(error)).toBe(expected);
  });
});
