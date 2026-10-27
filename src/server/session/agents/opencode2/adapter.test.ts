import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { Opencode2Adapter } from "./adapter.js";
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
  done: Promise<number>;
}

let testHome: string;
let configs: Record<string, unknown>[];

function makeAdapter(opts: { mcp?: boolean; messages?: unknown; holdCompaction?: Promise<void> } = {}): Omit<Harness, "done"> {
  const spawns: Harness["spawns"] = [];
  const requests: Harness["requests"] = [];
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
    const body = url.includes("/api/mcp")
      ? { data: opts.mcp ? [{ name: "playwright", status: { status: "connected" } }, { name: "broken", status: { status: "failed", error: "spawn ENOENT" } }] : [] }
      : url.includes("/message?") ? (opts.messages ?? MESSAGES) : url.endsWith("/compact") ? { data: { id: "msg_c" } } : url.includes("/message/msg_c") ? { data: { status: "completed" } } : undefined;
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const adapter = new Opencode2Adapter({ spawnFn, fetchFn });
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
  return { adapter, events, spawns, server: pick("serve"), client: pick("run"), requests };
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

  it("writes a v2-shaped config: tools that need a person off, Code Mode off for every MCP server", async () => {
    const h = start(makeAdapter({ mcp: true }), PARAMS);
    await announce(h);
    const config = configs[0];
    expect(config.tools).toEqual({ question: false, websearch: false, execute: false });
    const servers = (config.mcp as { servers: Record<string, { codemode?: boolean; type: string }> }).servers;
    expect(Object.keys(servers)).toEqual(["playwright", "broken"]);
    for (const server of Object.values(servers)) expect(server.codemode).toBe(false);
    expect(config.provider).toMatchObject({ shipit: { options: { apiKey: "{env:OPENCODE_PROVIDER_API_KEY}" } } });
    h.client().emit("close", 0, null);
    await h.done;
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
