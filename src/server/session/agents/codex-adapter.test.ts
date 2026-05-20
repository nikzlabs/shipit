import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { CodexAdapter } from "./codex-adapter.js";
import type { AgentEvent } from "./agent-process.js";

/**
 * To test the CodexAdapter without spawning a real process, we mock child_process.spawn.
 * The FakeCodexProcess simulates stdin/stdout/stderr and the JSON-RPC protocol.
 */
class FakeStdio extends EventEmitter {
  writable = true;
  written: string[] = [];
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeStdio();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }

  /** Simulate the app-server sending a JSON-RPC response. */
  sendResponse(id: number, result: unknown): void {
    const line = `${JSON.stringify({ id, result })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  /** Simulate the app-server sending a JSON-RPC error response. */
  sendErrorResponse(id: number, code: number, message: string): void {
    const line = `${JSON.stringify({ id, error: { code, message } })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  /** Simulate the app-server sending a notification. */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    const line = `${JSON.stringify({ method, params: params ?? {} })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  /** Get parsed JSON-RPC requests that were written to stdin. */
  getRequests(): { method: string; id?: number; params?: unknown }[] {
    return this.stdin.written.map((line) => JSON.parse(line.trim()));
  }

  /** Get the last request written to stdin. */
  getLastRequest(): { method: string; id?: number; params?: unknown } | undefined {
    const reqs = this.getRequests();
    return reqs[reqs.length - 1];
  }
}

// Mock child_process.spawn to return our fake process. Also capture the env
// the spawn was called with so the dual-auth tests can assert that
// OPENAI_API_KEY was (or wasn't) forwarded to the child process. See
// docs/119-codex-subscription-auth/plan.md.
let fakeProc: FakeChildProcess;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;

vi.mock("node:child_process", () => ({
  spawn: (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    fakeProc = new FakeChildProcess();
    lastSpawnEnv = options.env;
    return fakeProc;
  },
  execFileSync: () => {
    // Simulate `which codex` succeeding (binary found)
    return Buffer.from("/usr/local/bin/codex\n");
  },
}));

describe("CodexAdapter", () => {
  let adapter: CodexAdapter;
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
    // Set OPENAI_API_KEY to prevent auth_required emission
    process.env.OPENAI_API_KEY = "test-key-123";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  /** Helper: create adapter, run it, and complete the init handshake. */
  async function createAndInit(prompt = "Hello", sessionId?: string): Promise<void> {
    adapter = new CodexAdapter();
    adapter.on("event", (e) => events.push(e));

    adapter.run({
      prompt,
      sessionId,
      cwd: "/workspace",
    });

    // Allow the microtask for initializeAndRun to start
    await vi.waitFor(() => {
      expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1);
    });

    // Respond to initialize request (id: 1)
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });

    // Wait for thread/start or thread/resume request
    await vi.waitFor(() => {
      const reqs = fakeProc.getRequests();
      // id 1 = initialize, notification = initialized, id 2 = thread/start or thread/resume
      expect(reqs.length).toBeGreaterThanOrEqual(3);
    });

    // Respond to thread/start (id: 2) or thread/resume (id: 2)
    fakeProc.sendResponse(2, { threadId: "thread-abc-123" });

    // Wait for turn/start request
    await vi.waitFor(() => {
      const reqs = fakeProc.getRequests();
      expect(reqs.length).toBeGreaterThanOrEqual(4);
    });

    // Respond to turn/start (id: 3)
    fakeProc.sendResponse(3, { turnId: "turn-001" });

    // Wait for the agent_init event to be emitted
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_init")).toBe(true);
    });
  }

  it("has agentId 'codex'", () => {
    adapter = new CodexAdapter();
    expect(adapter.agentId).toBe("codex");
  });

  it("reports Codex capabilities", () => {
    adapter = new CodexAdapter();
    expect(adapter.capabilities.supportsResume).toBe(true);
    expect(adapter.capabilities.supportsImages).toBe(false);
    expect(adapter.capabilities.supportsSystemPrompt).toBe(true);
    expect(adapter.capabilities.supportsPermissionModes).toBe(false);
    expect(adapter.capabilities.toolNames).toContain("shell");
    expect(adapter.capabilities.toolNames).toContain("file_write");
    expect(adapter.capabilities.models).toContain("gpt-5.4");
    // 125 — chat-native AI review requires a subagent primitive plus custom
    // MCP tool registration; Codex has neither, so the affordance is hidden
    // on Codex sessions until the platform grows the missing pieces.
    expect(adapter.capabilities.supportsReview).toBe(false);
  });

  it("emits auth_required when OPENAI_API_KEY is not set", () => {
    delete process.env.OPENAI_API_KEY;

    adapter = new CodexAdapter();
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    expect(authRequired).toBe(true);
  });

  it("sends initialize handshake with clientInfo", async () => {
    await createAndInit("Hello");

    const reqs = fakeProc.getRequests();
    const initReq = reqs.find((r) => r.method === "initialize");
    expect(initReq).toBeDefined();
    expect(initReq!.id).toBe(1);
    expect((initReq!.params as any).clientInfo.name).toBe("shipit");
  });

  it("sends initialized notification after init response", async () => {
    await createAndInit("Hello");

    const reqs = fakeProc.getRequests();
    const initializedNotif = reqs.find((r) => r.method === "initialized");
    expect(initializedNotif).toBeDefined();
    expect(initializedNotif!.id).toBeUndefined();
  });

  it("starts a new thread when no sessionId provided", async () => {
    await createAndInit("Hello");

    const reqs = fakeProc.getRequests();
    const threadStart = reqs.find((r) => r.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect(threadStart!.id).toBe(2);
  });

  it("resumes a thread when sessionId is provided", async () => {
    await createAndInit("Hello", "existing-thread-id");

    const reqs = fakeProc.getRequests();
    const threadResume = reqs.find((r) => r.method === "thread/resume");
    expect(threadResume).toBeDefined();
    expect((threadResume!.params as any).threadId).toBe("existing-thread-id");
  });

  it("passes systemPrompt as developerInstructions on thread/start", async () => {
    // ShipIt's environment instructions reach Claude via `--system-prompt`;
    // Codex's equivalent is `developerInstructions` on thread/start. Without
    // this, Codex sessions had no idea they were running inside ShipIt.
    adapter = new CodexAdapter();
    adapter.on("event", (e) => events.push(e));
    adapter.run({
      prompt: "Hello",
      cwd: "/workspace",
      systemPrompt: "You are running inside ShipIt.",
    });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));

    const threadStart = fakeProc.getRequests().find((r) => r.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect((threadStart!.params as any).developerInstructions).toBe(
      "You are running inside ShipIt.",
    );
  });

  it("passes systemPrompt as developerInstructions on thread/resume", async () => {
    adapter = new CodexAdapter();
    adapter.on("event", (e) => events.push(e));
    adapter.run({
      prompt: "Hello",
      cwd: "/workspace",
      sessionId: "existing-thread-id",
      systemPrompt: "You are running inside ShipIt.",
    });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));

    const threadResume = fakeProc.getRequests().find((r) => r.method === "thread/resume");
    expect(threadResume).toBeDefined();
    expect((threadResume!.params as any).developerInstructions).toBe(
      "You are running inside ShipIt.",
    );
    expect((threadResume!.params as any).threadId).toBe("existing-thread-id");
  });

  it("omits developerInstructions when no systemPrompt is provided", async () => {
    await createAndInit("Hello");

    const threadStart = fakeProc.getRequests().find((r) => r.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect((threadStart!.params as any).developerInstructions).toBeUndefined();
  });

  it("extracts threadId from the 0.132 `thread.id` response shape", async () => {
    // Regression guard for the reported "issue with the selected model" bug:
    // CLI 0.132.x moved the id from a top-level `threadId` to a nested
    // `thread.id`. Reading only `threadId` left it null, so `turn/start` went
    // out with `threadId: null` and the server rejected the whole turn.
    adapter = new CodexAdapter();
    adapter.on("event", (e) => events.push(e));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));
    // New nested shape:
    fakeProc.sendResponse(2, { thread: { id: "thread-nested-456" } });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(4));

    const turnStart = fakeProc.getRequests().find((r) => r.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect((turnStart!.params as any).threadId).toBe("thread-nested-456");

    const initEvent = events.find((e) => e.type === "agent_init");
    expect((initEvent as any).sessionId).toBe("thread-nested-456");
  });

  it("sends turn/start with user prompt", async () => {
    await createAndInit("Write a hello world script");

    const reqs = fakeProc.getRequests();
    const turnStart = reqs.find((r) => r.method === "turn/start");
    expect(turnStart).toBeDefined();
    // `input` is a sequence of typed content blocks — the Codex
    // app-server rejects a bare string with JSON-RPC -32600 since CLI
    // 0.131.x. See codex-adapter.ts comment in `initializeAndRun`.
    expect((turnStart!.params as any).input).toEqual([
      { type: "text", text: "Write a hello world script" },
    ]);
    expect((turnStart!.params as any).threadId).toBe("thread-abc-123");
  });

  it("never sends turn/start `input` as a bare string (regression guard)", async () => {
    // The Codex app-server tightened the schema in 0.131.x and now
    // rejects a string `input` with -32600. The UI surfaced this as a
    // misleading "selected model may not exist" error. Guard against
    // regressing to the old shape.
    await createAndInit("anything");
    const turnStart = fakeProc.getRequests().find((r) => r.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect(typeof (turnStart!.params as any).input).not.toBe("string");
    expect(Array.isArray((turnStart!.params as any).input)).toBe(true);
  });

  it("emits agent_init event after handshake", async () => {
    await createAndInit("Hello");

    const initEvent = events.find((e) => e.type === "agent_init");
    expect(initEvent).toEqual({
      type: "agent_init",
      agentId: "codex",
      sessionId: "thread-abc-123",
      model: "gpt-5.5",
      tools: ["shell", "file_write", "file_read", "file_edit"],
    });
  });

  it("maps an agentMessage item to agent_assistant text", async () => {
    await createAndInit("Hello");
    events.length = 0; // Clear init events

    // CLI 0.132.x: agentMessage carries a plain `text` string (not a
    // `role:"assistant"` + `content[]` shape) and is keyed by `id`.
    fakeProc.sendNotification("item/completed", {
      item: { type: "agentMessage", id: "msg-1", text: "Hello! How can I help?" },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Hello! How can I help?" }],
    });
  });

  it("does not re-emit agentMessage text already streamed via delta", async () => {
    await createAndInit("Hello");
    events.length = 0;

    // Stream the text incrementally...
    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "Hi " });
    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "there" });
    // ...then the completed item arrives with the full text. The orchestrator
    // appends each text block, so re-emitting here would double the message.
    fakeProc.sendNotification("item/completed", {
      item: { type: "agentMessage", id: "msg-1", text: "Hi there" },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(2);
    });

    expect(events.map((e) => (e as any).content[0].text)).toEqual(["Hi ", "there"]);
  });

  it("maps a commandExecution item to tool_use (started) and tool_result (completed)", async () => {
    await createAndInit("Run ls");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "commandExecution",
        id: "call-001",
        command: "/bin/bash -lc 'ls -la'",
        cwd: "/workspace",
        status: "inProgress",
      },
    });
    fakeProc.sendNotification("item/completed", {
      item: {
        type: "commandExecution",
        id: "call-001",
        command: "/bin/bash -lc 'ls -la'",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "file1.txt\nfile2.txt\n",
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(2);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [
        {
          type: "tool_use",
          id: "call-001",
          name: "shell",
          input: { command: "/bin/bash -lc 'ls -la'", cwd: "/workspace" },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "call-001", content: "file1.txt\nfile2.txt\n" }],
    });
  });

  it("annotates a failed commandExecution with its exit code", async () => {
    await createAndInit("Run a failing command");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "commandExecution",
        id: "call-002",
        status: "failed",
        exitCode: 1,
        aggregatedOutput: "boom",
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });

    expect(events[0]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "call-002", content: "boom\n[exit code: 1]" }],
    });
  });

  it("maps a fileChange item to an apply_patch tool call", async () => {
    await createAndInit("Edit a file");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "fileChange",
        id: "fc-1",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update", diff: "@@" },
          { path: "src/b.ts", kind: "add", diff: "@@" },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(2);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [
        { type: "tool_use", id: "fc-1", name: "apply_patch", input: { files: ["src/a.ts", "src/b.ts"] } },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "fc-1", content: "update src/a.ts\nadd src/b.ts" }],
    });
  });

  it("maps incremental message delta (a plain string) to agent_assistant", async () => {
    await createAndInit("Hello");
    events.length = 0;

    // CLI 0.132.x: `delta` is a plain string, not a `{content:[…]}` object.
    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "Partial " });

    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Partial " }],
    });
  });

  it("maps turn/completed to agent_result with token usage from thread/tokenUsage/updated", async () => {
    await createAndInit("Hello");
    events.length = 0;

    // Token usage arrives on its own notification (not in turn/completed).
    fakeProc.sendNotification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 150, outputTokens: 75, cachedInputTokens: 100 },
        last: { totalTokens: 130 },
        modelContextWindow: 272000,
      },
    });
    // v2 nests status under `turn`.
    fakeProc.sendNotification("turn/completed", {
      turn: { id: "turn-001", status: "completed" },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });

    const resultEvent = events.find((e) => e.type === "agent_result");
    expect(resultEvent).toMatchObject({
      type: "agent_result",
      status: "success",
      sessionId: "thread-abc-123",
      tokens: { input: 150, output: 75, cacheRead: 100 },
      contextTokens: 130,
      contextWindow: 272000,
    });
    expect((resultEvent as any).error).toBeUndefined();
  });

  it("maps turn/completed with non-completed status to error", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("turn/completed", {
      turn: { id: "turn-001", status: "interrupted" },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });

    const resultEvent = events.find((e) => e.type === "agent_result");
    expect(resultEvent).toMatchObject({
      type: "agent_result",
      status: "error",
      error: "Turn ended with status: interrupted",
    });
  });

  it("kills the process on kill()", async () => {
    await createAndInit("Hello");

    adapter.kill();
    expect(fakeProc.killed).toBe(true);
  });

  it("sends turn/steer on writeStdin()", async () => {
    await createAndInit("Hello");

    adapter.writeStdin("user reply text\n");

    const reqs = fakeProc.getRequests();
    const steer = reqs.find((r) => r.method === "turn/steer");
    expect(steer).toBeDefined();
    // Matches the same content-block schema as turn/start — see the
    // explanatory comment in codex-adapter.ts `writeStdin`.
    expect((steer!.params as any).input).toEqual([
      { type: "text", text: "user reply text" },
    ]);
  });

  it("handles malformed JSON tool arguments gracefully", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "mcpToolCall",
        id: "call-002",
        tool: "search",
        arguments: "not valid json",
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });

    expect(events[0]).toMatchObject({
      type: "agent_assistant",
      content: [
        {
          type: "tool_use",
          id: "call-002",
          name: "search",
          input: { raw: "not valid json" },
        },
      ],
    });
  });

  it("emits done event when process closes", async () => {
    await createAndInit("Hello");

    const doneCodes: number[] = [];
    adapter.on("done", (code) => doneCodes.push(code));

    fakeProc.emit("close", 0);

    expect(doneCodes).toEqual([0]);
  });

  it("emits error event when process emits error", async () => {
    await createAndInit("Hello");

    const errors: Error[] = [];
    adapter.on("error", (e) => errors.push(e));

    fakeProc.emit("error", new Error("spawn failed"));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("spawn failed");
  });

  it("detects auth errors from stderr", async () => {
    adapter = new CodexAdapter();
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });

    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(fakeProc).toBeDefined());

    fakeProc.stderr.emit("data", Buffer.from("Error: Invalid API key provided"));

    expect(authRequired).toBe(true);
  });

  it("ignores an empty-string message delta", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "" });

    // No event should be emitted for empty text
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it("ignores items with no ShipIt mapping (userMessage, reasoning, plan)", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: { type: "userMessage", id: "u-1", content: [{ type: "text", text: "echo of prompt" }] },
    });
    fakeProc.sendNotification("item/completed", { item: { type: "reasoning", id: "r-1" } });
    fakeProc.sendNotification("item/completed", { item: { type: "plan", id: "p-1", text: "a plan" } });

    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it("sends turn/start with approvalPolicy:never and dangerFullAccess sandbox", async () => {
    // ShipIt's container IS the sandbox and the agent operates autonomously,
    // so Codex's own approval gate / bubblewrap sandbox must be disabled —
    // otherwise shell commands stall on an unanswered approval request and
    // bubblewrap fails to create a namespace in-container.
    await createAndInit("Run a command");

    const turnStart = fakeProc.getRequests().find((r) => r.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect((turnStart!.params as any).approvalPolicy).toBe("never");
    expect((turnStart!.params as any).sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });
});

// ---------------------------------------------------------------------------
// Feature 119 — Codex subscription auth dual-mode resolution
//
// Covers the env-key path; the file-auth (ChatGPT subscription) path can't
// be exercised here because its detection probes /root/.codex/auth.json
// directly via `node:fs`, and ESM doesn't permit spy-ing on namespace
// exports. The dual-mode branch table is covered by
// `src/server/shared/agent-registry.test.ts` (registry layer) and
// `src/server/orchestrator/codex-auth.test.ts` (manager layer); the
// `auth_required` branch tested here is the only one the adapter alone
// owns.
// ---------------------------------------------------------------------------

describe("CodexAdapter / dual-mode auth (feature 119)", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    lastSpawnEnv = undefined;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("emits auth_required when neither file auth nor OPENAI_API_KEY is present", () => {
    const adapter = new CodexAdapter();
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });
    expect(authRequired).toBe(true);
  });

  it("forwards OPENAI_API_KEY when only the env-key auth path is set", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";

    const adapter = new CodexAdapter();
    adapter.on("event", () => { /* drain */ });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => {
      expect(lastSpawnEnv).toBeDefined();
    });

    expect(lastSpawnEnv?.OPENAI_API_KEY).toBe("sk-platform-billing");
  });

  it("logs the auth path it chose (Platform API)", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";

    const adapter = new CodexAdapter();
    const logs: { source: string; text: string }[] = [];
    adapter.on("log", (source, text) => logs.push({ source, text }));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());

    const platformLog = logs.find((l) => l.text.includes("OPENAI_API_KEY"));
    expect(platformLog).toBeDefined();
  });
});
