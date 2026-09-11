import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAdapter, CODEX_SANDBOX_ARGS } from "./adapter.js";
import type { AgentEvent } from "../agent-process.js";
import { CODEX_TOOL_NAMES } from "../../../shared/agent-registry.js";

// Prefix for assertions about what ELSE rides the pre-subcommand `-c` position.
// The contents are pinned literally in "sandbox overrides", not here.
const SANDBOX = CODEX_SANDBOX_ARGS;

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
  // Without a PID, killChild treats this as a failed spawn.
  pid: number | undefined = 4242;

  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }

  sendResponse(id: number, result: unknown): void {
    const line = `${JSON.stringify({ id, result })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  sendErrorResponse(id: number, code: number, message: string): void {
    const line = `${JSON.stringify({ id, error: { code, message } })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    const line = `${JSON.stringify({ method, params: params ?? {} })  }\n`;
    this.stdout.emit("data", Buffer.from(line));
  }

  getRequests(): { method: string; id?: number; params?: unknown }[] {
    return this.stdin.written.map((line) => JSON.parse(line.trim()));
  }

  getLastRequest(): { method: string; id?: number; params?: unknown } | undefined {
    const reqs = this.getRequests();
    return reqs[reqs.length - 1];
  }
}

let fakeProc: FakeChildProcess;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
let lastSpawnArgs: string[] | undefined;
// Capture at spawn: later writes would miss the app-server's config read.
let configAtSpawn: string | undefined;

function readConfigToml(codexHome: string | undefined): string | undefined {
  if (!codexHome) return undefined;
  try {
    return readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  } catch {
    return undefined;
  }
}

vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], cb: (error: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, "/usr/local/bin/codex\n", "");
  },
  spawn: (_cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    fakeProc = new FakeChildProcess();
    lastSpawnEnv = options.env;
    lastSpawnArgs = args;
    configAtSpawn = readConfigToml(options.env?.CODEX_HOME);
    return fakeProc;
  },
  execFileSync: () => {
    return Buffer.from("/usr/local/bin/codex\n");
  },
}));

vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) };
});
import { killProcessTree } from "../../../shared/kill-child.js";

describe("CodexAdapter", () => {
  let adapter: CodexAdapter;
  let events: AgentEvent[];

  beforeEach(() => {
    events = [];
    process.env.OPENAI_API_KEY = "test-key-123";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  async function createAndInit(
    prompt = "Hello",
    sessionId?: string,
    cwd = "/workspace",
    model?: string,
  ): Promise<void> {
    adapter = new CodexAdapter(() => false);
    adapter.on("event", (e) => events.push(e));

    adapter.run({
      prompt,
      sessionId,
      cwd,
      ...(model !== undefined ? { model } : {}),
    });

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1);
    });

    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });

    await vi.waitFor(() => {
      const reqs = fakeProc.getRequests();
      expect(reqs.length).toBeGreaterThanOrEqual(3);
    });

    fakeProc.sendResponse(2, { threadId: "thread-abc-123" });

    await vi.waitFor(() => {
      const reqs = fakeProc.getRequests();
      expect(reqs.length).toBeGreaterThanOrEqual(4);
    });

    fakeProc.sendResponse(3, { turnId: "turn-001" });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_init")).toBe(true);
    });
  }

  it("has agentId 'codex'", () => {
    adapter = new CodexAdapter(() => false);
    expect(adapter.agentId).toBe("codex");
  });

  describe("reasoning effort (docs/217)", () => {
    it("passes -c model_reasoning_effort= when reasoningEffort is set", () => {
      adapter = new CodexAdapter(() => false);
      adapter.run({ prompt: "hi", cwd: "/workspace", reasoningEffort: "high" });
      expect(lastSpawnArgs).toEqual([...SANDBOX, "-c", "model_reasoning_effort=high", "app-server"]);
    });

    it("omits the override (default) when reasoningEffort is unset", () => {
      adapter = new CodexAdapter(() => false);
      adapter.run({ prompt: "hi", cwd: "/workspace" });
      expect(lastSpawnArgs).toEqual([...SANDBOX, "app-server"]);
    });
  });

  /**
   * `sandboxPolicy: { type: "dangerFullAccess" }` on `turn/start` was the ONLY
   * thing disabling Codex's sandbox, and when codex-cli 0.153.2 fell back past
   * it every tool call died on `bwrap: No permissions to create new namespace`.
   * `features.use_legacy_landlock` is the one that survives a requirements
   * veto — it swaps the fallback sandbox for Landlock, which needs no
   * capabilities, rather than one that cannot start.
   *
   * Asserted at SPAWN time and by literal value: this is a wire contract with
   * the pinned CLI (each key was measured to parse at this argv position), so
   * comparing against the exported constant would pass whatever it said.
   */
  describe("sandbox overrides", () => {
    it("disables the sandbox and forces Landlock before `app-server`", () => {
      adapter = new CodexAdapter(() => false);
      adapter.run({ prompt: "hi", cwd: "/workspace" });
      expect(lastSpawnArgs?.slice(0, 6)).toEqual([
        "-c", `sandbox_mode="danger-full-access"`,
        "-c", `approval_policy="never"`,
        "-c", "features.use_legacy_landlock=true",
      ]);
      // Global overrides only work ahead of the subcommand.
      expect(lastSpawnArgs?.indexOf("app-server")).toBe(lastSpawnArgs!.length - 1);
    });
  });

  it("reports Codex capabilities", () => {
    adapter = new CodexAdapter();
    expect(adapter.capabilities.supportsResume).toBe(true);
    expect(adapter.capabilities.supportsImages).toBe(true);
    expect(adapter.capabilities.supportsSystemPrompt).toBe(true);
    expect(adapter.capabilities.supportsPermissionModes).toBe(false);
    expect(adapter.capabilities.toolNames).toContain("shell");
    expect(adapter.capabilities.toolNames).toContain("commandExecution");
    expect(adapter.capabilities.toolNames).toContain("fileChange");
    expect(adapter.capabilities.toolNames).toContain("apply_patch");
    expect(adapter.capabilities.toolNames).not.toContain("file_write");
    expect(adapter.capabilities.toolNames).not.toContain("file_read");
    expect(adapter.capabilities.toolNames).not.toContain("file_edit");
    expect(adapter.capabilities.models[0]).toBe("gpt-5.6-sol");
    expect(adapter.capabilities.models).not.toContain("gpt-5.6");
    expect(adapter.capabilities.models).toContain("gpt-5.4");
    expect(adapter.capabilities.supportsReview).toBe(true);
    expect(adapter.capabilities.toolNames).toContain("shell");
    expect(adapter.capabilities.toolNames).toContain("spawn_agent");
  });

  it("emits auth_required when OPENAI_API_KEY is not set", () => {
    delete process.env.OPENAI_API_KEY;

    adapter = new CodexAdapter(() => false);
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

  it("starts a durable thread so the next turn can resume its rollout", async () => {
    await createAndInit("hello");

    const threadStart = fakeProc.getRequests().find((request) => request.method === "thread/start");
    expect(threadStart).toBeDefined();
    expect((threadStart!.params as any).ephemeral).toBe(false);
  });

  it("fails closed instead of starting a contextless thread when resume is rejected", async () => {
    adapter = new CodexAdapter(() => false);
    const errors: Error[] = [];
    const logs: string[] = [];
    adapter.on("error", (error) => errors.push(error));
    adapter.on("log", (_source, text) => logs.push(text));
    adapter.run({
      prompt: "Is it the Codex only issue or Claude also has this?",
      cwd: "/workspace",
      sessionId: "existing-thread-id",
    });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });
    await vi.waitFor(() => {
      expect(fakeProc.getRequests().some((request) => request.method === "thread/resume")).toBe(true);
    });

    fakeProc.sendErrorResponse(2, -32600, "thread rollout not found");

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].message).toContain("Couldn't resume the previous Codex conversation");
    expect(errors[0].message).toContain("contextless thread");
    expect(logs.some((line) =>
      line.includes("thread/resume failed for existing-thread-id")
      && line.includes("thread rollout not found")
    )).toBe(true);
    expect(fakeProc.getRequests().some((request) => request.method === "thread/start")).toBe(false);
    expect(fakeProc.getRequests().some((request) => request.method === "turn/start")).toBe(false);
  });

  it("passes systemPrompt as developerInstructions on thread/start", async () => {
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
    adapter = new CodexAdapter();
    adapter.on("event", (e) => events.push(e));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));
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
    expect((turnStart!.params as any).input).toEqual([
      { type: "text", text: "Write a hello world script" },
    ]);
    expect((turnStart!.params as any).threadId).toBe("thread-abc-123");
  });

  it("never sends turn/start `input` as a bare string (regression guard)", async () => {
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
      model: "gpt-5.6-sol",
      tools: [...CODEX_TOOL_NAMES],
    });
  });

  it("forwards the model it is given, without re-mapping a retired id", async () => {
    await createAndInit("Hello", undefined, "/workspace", "gpt-5.6");

    const initEvent = events.find((e) => e.type === "agent_init");
    expect(initEvent).toMatchObject({ model: "gpt-5.6" });

    const turnStart = fakeProc.getRequests().find((r) => r.method === "turn/start");
    expect((turnStart!.params as any).model).toBe("gpt-5.6");
  });

  it("maps an agentMessage item to agent_assistant text", async () => {
    await createAndInit("Hello");
    events.length = 0;

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

  it("re-emits streamed agentMessage text as a stream-completion event", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "Hi " });
    fakeProc.sendNotification("item/agentMessage/delta", { itemId: "msg-1", delta: "there" });
    fakeProc.sendNotification("item/completed", {
      item: { type: "agentMessage", id: "msg-1", text: "Hi there" },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(3);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Hi " }],
    });
    expect(events[1]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "there" }],
    });
    expect(events[2]).toEqual({
      type: "agent_assistant",
      content: [{ type: "text", text: "Hi there" }],
      isStreamCompletion: true,
    });
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
          input: { command: "ls -la", cwd: "/workspace" },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "call-001", content: "file1.txt\nfile2.txt\n" }],
    });
  });

  it("synthesizes a shell tool_use for a completed-only commandExecution", async () => {
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
      expect(events.length).toBe(2);
    });

    expect(events[0]).toEqual({
      type: "agent_assistant",
      content: [
        {
          type: "tool_use",
          id: "call-002",
          name: "shell",
          input: { command: "", cwd: undefined },
        },
      ],
    });
    expect(events[1]).toEqual({
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
        {
          type: "tool_use",
          id: "fc-1",
          name: "apply_patch",
          input: {
            files: ["src/a.ts", "src/b.ts"],
            changes: [
              { path: "src/a.ts", kind: "update", diff: "@@" },
              { path: "src/b.ts", kind: "add", diff: "@@" },
            ],
          },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "fc-1", content: "update src/a.ts\nadd src/b.ts" }],
    });
  });

  it("labels internally-tagged kinds and surfaces the top-level diff (not [object Object])", async () => {
    await createAndInit("Edit a file");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "fileChange",
        id: "fc-2",
        status: "completed",
        changes: [
          { path: "/workspace/src/game/Game.js", diff: "@@ -1 +1 @@\n-a\n+b", kind: { type: "update", move_path: null } },
          { path: "/workspace/src/new.js", diff: "+line1\n+line2", kind: { type: "add" } },
          { path: "/workspace/src/old.js", diff: "-gone", kind: { type: "delete" } },
        ],
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
          id: "fc-2",
          name: "apply_patch",
          input: {
            files: ["/workspace/src/game/Game.js", "/workspace/src/new.js", "/workspace/src/old.js"],
            changes: [
              { path: "/workspace/src/game/Game.js", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
              { path: "/workspace/src/new.js", kind: "add", diff: "+line1\n+line2" },
              { path: "/workspace/src/old.js", kind: "delete", diff: "-gone" },
            ],
          },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [
        {
          type: "tool_result",
          tool_use_id: "fc-2",
          content: "update /workspace/src/game/Game.js\nadd /workspace/src/new.js\ndelete /workspace/src/old.js",
        },
      ],
    });
  });

  it("normalizes Codex 0.136 add fileChange raw content into added diff lines", async () => {
    await createAndInit("Write a file");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "fileChange",
        id: "fc-add-raw",
        status: "completed",
        changes: [
          {
            path: "/workspace/scratch-icon-test.md",
            kind: { type: "add" },
            diff: "# Scratch icon test\ncreated by codex wire probe\n",
          },
        ],
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
          id: "fc-add-raw",
          name: "apply_patch",
          input: {
            files: ["/workspace/scratch-icon-test.md"],
            changes: [
              {
                path: "/workspace/scratch-icon-test.md",
                kind: "add",
                diff: "+# Scratch icon test\n+created by codex wire probe",
              },
            ],
          },
        },
      ],
    });
  });

  it("synthesizes a write diff for add fileChange items without a diff", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "shipit-codex-write-"));
    try {
      writeFileSync(path.join(cwd, "new-file.ts"), "one\ntwo\n");
      await createAndInit("Write a file", undefined, cwd);
      events.length = 0;

      fakeProc.sendNotification("item/completed", {
        item: {
          type: "fileChange",
          id: "fc-add",
          status: "completed",
          changes: [
            { path: "new-file.ts", kind: { type: "add" } },
          ],
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
            id: "fc-add",
            name: "apply_patch",
            input: {
              files: ["new-file.ts"],
              changes: [
                { path: "new-file.ts", kind: "add", diff: "+one\n+two" },
              ],
            },
          },
        ],
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("maps incremental message delta (a plain string) to agent_assistant", async () => {
    await createAndInit("Hello");
    events.length = 0;

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

    fakeProc.sendNotification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: { inputTokens: 150, outputTokens: 75, cachedInputTokens: 100 },
        last: { totalTokens: 130 },
        modelContextWindow: 272000,
      },
    });
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
      tokens: { input: 50, output: 75, cacheRead: 100 },
      contextTokens: 130,
      contextWindow: 272000,
    });
    expect((resultEvent as any).error).toBeUndefined();
  });

  it("takes cache-written tokens out of the input class as well as the cached ones", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("thread/tokenUsage/updated", {
      tokenUsage: {
        total: {
          inputTokens: 1000,
          outputTokens: 42,
          cachedInputTokens: 800,
          cacheWriteInputTokens: 50,
        },
      },
    });
    fakeProc.sendNotification("turn/completed", { turn: { id: "t", status: "completed" } });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });

    const resultEvent = events.find((e) => e.type === "agent_result");
    expect(resultEvent).toMatchObject({
      tokens: { input: 150, output: 42, cacheRead: 800, cacheWrite: 50 },
    });
  });

  // Each turn has a new process. Resume replays the thread's cumulative usage.
  describe("a resumed thread's cumulative token rollup", () => {
    const THREAD = "thread-abc-123";

    async function runTurn(opts: {
      turnId: string;
      resume?: boolean;
      snapshots: [string, { inputTokens: number; cachedInputTokens: number; outputTokens: number }][];
    }): Promise<AgentEvent | undefined> {
      await createAndInit("Hello", opts.resume ? THREAD : undefined);
      events.length = 0;
      for (const [turnId, total] of opts.snapshots) {
        fakeProc.sendNotification("thread/tokenUsage/updated", {
          threadId: THREAD,
          turnId,
          tokenUsage: { total, last: { totalTokens: 1000 }, modelContextWindow: 272000 },
        });
      }
      fakeProc.sendNotification("turn/completed", {
        threadId: THREAD,
        turn: { id: opts.turnId, status: "completed" },
      });
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "agent_result")).toBe(true);
      });
      return events.find((e) => e.type === "agent_result");
    }

    const ROLLUP_AFTER = [
      { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 10 },
      { inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 20 },
      { inputTokens: 3000, cachedInputTokens: 2400, outputTokens: 30 },
    ];
    const ONE_TURN = { input: 200, output: 10, cacheRead: 800 };

    it("records each turn's own tokens across three resumed turns", async () => {
      const first = await runTurn({ turnId: "turn-1", snapshots: [["turn-1", ROLLUP_AFTER[0]]] });
      expect(first).toMatchObject({ tokens: ONE_TURN, contextTokens: 1000, contextWindow: 272000 });

      const second = await runTurn({
        turnId: "turn-2",
        resume: true,
        snapshots: [["turn-1", ROLLUP_AFTER[0]], ["turn-2", ROLLUP_AFTER[1]]],
      });
      expect(second).toMatchObject({ tokens: ONE_TURN });

      const third = await runTurn({
        turnId: "turn-3",
        resume: true,
        snapshots: [["turn-2", ROLLUP_AFTER[1]], ["turn-3", ROLLUP_AFTER[2]]],
      });
      expect(third).toMatchObject({ tokens: ONE_TURN });
    });

    it("records nothing for a turn whose only snapshot is the replayed one", async () => {
      const result = await runTurn({
        turnId: "turn-2",
        resume: true,
        snapshots: [["turn-1", ROLLUP_AFTER[0]]],
      });
      expect((result as { tokens?: unknown }).tokens).toBeUndefined();
      expect((result as { contextTokens?: unknown }).contextTokens).toBeUndefined();
      expect(result).toMatchObject({ contextWindow: 272000 });
    });
  });

  it("emits no tokens for a usage rollup with no numbers in it", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("thread/tokenUsage/updated", { tokenUsage: { total: {} } });
    fakeProc.sendNotification("turn/completed", { turn: { id: "t", status: "completed" } });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });

    const resultEvent = events.find((e) => e.type === "agent_result");
    expect((resultEvent as { tokens?: unknown }).tokens).toBeUndefined();
  });

  it("maps account/rateLimits/updated to an agent_rate_limits event", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1779296611 },
        secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1779883011 },
      },
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_rate_limits")).toBe(true);
    });

    const ev = events.find((e) => e.type === "agent_rate_limits");
    expect(ev).toMatchObject({
      type: "agent_rate_limits",
      session: { usedPct: 5, resetAt: new Date(1779296611 * 1000).toISOString() },
      weekly: { usedPct: 1, resetAt: new Date(1779883011 * 1000).toISOString() },
    });
  });

  it("rewrites misleading monthly-limit errors when the 5h window is exhausted", async () => {
    adapter = new CodexAdapter();
    const errors: Error[] = [];
    adapter.on("error", (e) => errors.push(e));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
    fakeProc.sendResponse(1, { serverInfo: { name: "codex-app-server" } });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));
    fakeProc.sendResponse(2, { threadId: "thread-abc-123" });

    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(4));
    fakeProc.sendNotification("account/rateLimits/updated", {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1779296611 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1779883011 },
      },
    });
    fakeProc.sendErrorResponse(3, -32000, "You've hit your org's monthly usage limit");

    await vi.waitFor(() => {
      expect(errors[0]?.message).toContain("Codex's 5h usage limit");
    });
    expect(errors[0]?.message).toContain(new Date(1779296611 * 1000).toISOString());
    expect(errors[0]?.message).not.toContain("monthly usage limit");
  });

  it("ignores a rate-limits notification with no parseable window", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("account/rateLimits/updated", {
      rateLimits: { limitId: "codex", limitName: null },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "agent_rate_limits")).toBe(false);
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

  it("tears down the whole process tree, not just the app-server pid", async () => {
    await createAndInit("Hello");

    adapter.kill();
    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(
      fakeProc,
      "SIGTERM",
      expect.objectContaining({ label: "codex" }),
    );
  });

  it("interrupts gracefully via turn/interrupt instead of killing the process", async () => {
    await createAndInit("Hello");
    fakeProc.stdin.written.length = 0;

    adapter.interrupt();

    const req = fakeProc.getLastRequest();
    expect(req?.method).toBe("turn/interrupt");
    expect((req!.params as any).threadId).toBe("thread-abc-123");
    expect((req!.params as any).turnId).toBe("turn-001");
    expect(req!.id).toBeDefined();
    expect(fakeProc.killed).toBe(false);
  });

  it("falls back to kill() when turn/interrupt is rejected (older app-server)", async () => {
    await createAndInit("Hello");

    adapter.interrupt();
    const req = fakeProc.getRequests().find((r) => r.method === "turn/interrupt");
    expect(req).toBeDefined();
    expect(fakeProc.killed).toBe(false);

    fakeProc.sendErrorResponse(req!.id!, -32601, "Method not found: turn/interrupt");

    await vi.waitFor(() => expect(fakeProc.killed).toBe(true));
  });

  it("falls back to kill() on interrupt when no turn is active", async () => {
    adapter = new CodexAdapter(() => false);
    adapter.on("event", (e) => events.push(e));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });
    await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));

    adapter.interrupt();

    expect(fakeProc.getRequests().some((r) => r.method === "turn/interrupt")).toBe(false);
    expect(fakeProc.killed).toBe(true);
  });

  it("emits agent_steer_rejected when turn/steer is rejected (ActiveTurnNotSteerable)", async () => {
    await createAndInit("Hello");
    events.length = 0;

    adapter.writeStdin("change course\n");
    const steer = fakeProc.getRequests().find((r) => r.method === "turn/steer");
    expect(steer).toBeDefined();

    fakeProc.sendErrorResponse(steer!.id!, -32600, "ActiveTurnNotSteerable");

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_steer_rejected")).toBe(true);
    });
    expect(events.find((e) => e.type === "agent_steer_rejected")).toEqual({
      type: "agent_steer_rejected",
      text: "change course",
    });
  });

  it("emits agent_user_replay (delivery ack) when turn/steer succeeds, not agent_steer_rejected (docs/140)", async () => {
    await createAndInit("Hello");
    events.length = 0;

    adapter.writeStdin("keep going\n");
    const steer = fakeProc.getRequests().find((r) => r.method === "turn/steer");
    expect(steer).toBeDefined();

    fakeProc.sendResponse(steer!.id!, { turnId: "turn-001" });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_user_replay")).toBe(true);
    });
    expect(events.find((e) => e.type === "agent_user_replay")).toEqual({
      type: "agent_user_replay",
      text: "keep going",
    });
    expect(events.some((e) => e.type === "agent_steer_rejected")).toBe(false);
  });

  it("sends turn/steer on writeStdin()", async () => {
    await createAndInit("Hello");

    adapter.writeStdin("user reply text\n");

    const reqs = fakeProc.getRequests();
    const steer = reqs.find((r) => r.method === "turn/steer");
    expect(steer).toBeDefined();
    expect((steer!.params as any).input).toEqual([
      { type: "text", text: "user reply text" },
    ]);
    expect((steer!.params as any).expectedTurnId).toBe("turn-001");
    expect(steer!.id).toBeDefined();
  });

  it("captures expectedTurnId from the turn/started event", async () => {
    await createAndInit("Hello");

    fakeProc.sendNotification("turn/started", { turn: { id: "turn-042" } });
    await vi.waitFor(() => {
      expect(true).toBe(true);
    });

    adapter.writeStdin("steer me\n");
    const steer = fakeProc.getRequests().find((r) => r.method === "turn/steer");
    expect((steer!.params as any).expectedTurnId).toBe("turn-042");
  });

  it("drops steer when no turn is active (no expectedTurnId to send)", async () => {
    await createAndInit("Hello");

    fakeProc.sendNotification("turn/completed", { turn: { status: "completed" } });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });

    const before = fakeProc.getRequests().filter((r) => r.method === "turn/steer").length;
    adapter.writeStdin("too late\n");
    const after = fakeProc.getRequests().filter((r) => r.method === "turn/steer").length;
    expect(after).toBe(before);
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

  it("maps a live-shape Codex subAgentActivity spawn to the Agent tool shape", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      threadId: "thread-abc-123",
      item: {
        type: "subAgentActivity",
        id: "agent-001",
        kind: "started",
        agentThreadId: "thread-child-1",
        agentPath: "/root/session_reviewer",
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
          id: "agent-001",
          name: "Agent",
          input: {
            agent: "thread-child-1",
            subagent_type: "Codex",
            description: "Run session_reviewer subagent",
          },
        },
      ],
    });
  });

  it("nests Codex child-thread progress and final output under the spawn call", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      threadId: "thread-abc-123",
      item: {
        type: "subAgentActivity",
        id: "agent-001",
        kind: "started",
        agentThreadId: "thread-child-1",
        agentPath: "/root/reconnect_inspector",
      },
    });
    fakeProc.sendNotification("thread/started", {
      thread: { id: "thread-child-1", agentNickname: "Scout", agentRole: "explorer" },
    });
    fakeProc.sendNotification("turn/started", {
      threadId: "thread-child-1",
      turn: { id: "child-turn-1" },
    });
    fakeProc.sendNotification("item/started", {
      threadId: "thread-child-1",
      item: { type: "commandExecution", id: "child-shell-1", command: "rg reconnect src" },
    });
    fakeProc.sendNotification("item/completed", {
      threadId: "thread-child-1",
      item: {
        type: "commandExecution",
        id: "child-shell-1",
        command: "rg reconnect src",
        aggregatedOutput: "3 matches",
        exitCode: 0,
      },
    });
    fakeProc.sendNotification("item/agentMessage/delta", {
      threadId: "thread-child-1",
      itemId: "child-message-1",
      delta: "Reconnect is safe.",
    });
    fakeProc.sendNotification("item/completed", {
      threadId: "thread-child-1",
      item: { type: "agentMessage", id: "child-message-1", text: "Reconnect is safe." },
    });
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events[1]).toMatchObject({
      type: "agent_assistant",
      parentToolUseId: "agent-001",
      content: [{ type: "tool_use", id: "child-shell-1", name: "shell" }],
    });
    expect(events[2]).toMatchObject({
      type: "agent_tool_result",
      parentToolUseId: "agent-001",
      content: [{ type: "tool_result", tool_use_id: "child-shell-1", content: "3 matches" }],
    });
    expect(events[3]).toMatchObject({
      type: "agent_assistant",
      parentToolUseId: "agent-001",
      content: [{ type: "text", text: "Reconnect is safe." }],
    });
    fakeProc.sendNotification("turn/completed", {
      threadId: "thread-child-1",
      turn: { id: "child-turn-1", status: "completed" },
    });
    await vi.waitFor(() => expect(events).toHaveLength(5));
    expect(events[4]).toMatchObject({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "agent-001", content: "Reconnect is safe." }],
    });
    expect(events.some((event) => event.type === "agent_result")).toBe(false);

    fakeProc.sendNotification("turn/completed", {
      threadId: "thread-abc-123",
      turn: { id: "parent-turn-1", status: "completed" },
    });
    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events[5]).toMatchObject({
      type: "agent_result",
      status: "success",
      sessionId: "thread-abc-123",
    });
  });

  it("closes a resultless Codex spawn card before the parent turn ends", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      threadId: "thread-abc-123",
      item: {
        type: "subAgentActivity",
        id: "agent-orphan",
        kind: "started",
        agentThreadId: "thread-child-orphan",
        agentPath: "/root/background_investigator",
      },
    });
    fakeProc.sendNotification("turn/completed", {
      threadId: "thread-abc-123",
      turn: { id: "parent-turn-1", status: "completed" },
    });

    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events[1]).toMatchObject({
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "agent-orphan",
        content: "Subagent ended without a final response.",
      }],
    });
    expect(events[2]).toMatchObject({ type: "agent_result", sessionId: "thread-abc-123" });
  });

  it("marks an errored Codex child result as an error", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      threadId: "thread-abc-123",
      item: {
        type: "subAgentActivity",
        id: "agent-failed",
        kind: "started",
        agentThreadId: "thread-child-failed",
        agentPath: "/root/build_checker",
      },
    });
    fakeProc.sendNotification("turn/completed", {
      threadId: "thread-child-failed",
      turn: { id: "child-turn-failed", status: "failed" },
    });

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({
      type: "agent_tool_result",
      content: [{
        type: "tool_result",
        tool_use_id: "agent-failed",
        content: "Subagent ended with status: failed",
        is_error: true,
      }],
    });
  });

  it("ignores a shipit ask mcpToolCall on item/started (the bridge surfaces it)", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "mcpToolCall",
        id: "call-ask-1",
        tool: "shipit__AskUserQuestion",
        arguments: JSON.stringify({
          questions: [
            {
              question: "Which database should we use?",
              header: "Database",
              options: [
                { label: "Postgres", description: "Relational" },
                { label: "Redis", description: "In-memory" },
              ],
            },
          ],
        }),
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it("does not emit a tool_result for a completed AskUserQuestion call (card stays interactive)", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "call-ask-3",
        tool: "AskUserQuestion",
        result: "ignored",
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it("normalizes split Codex MCP identity to ShipIt's canonical tool name", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "mcpToolCall",
        id: "call-other-1",
        server: "shipit",
        tool: "present",
        arguments: JSON.stringify({ file: "/persist/diagram.html" }),
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });
    expect(events[0]).toMatchObject({
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "call-other-1", name: "mcp__shipit__present" }],
    });
  });

  it("synthesizes an MCP tool_use for a completed-only tool call", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "mcpToolCall",
        id: "web-1",
        tool: "WebSearch",
        arguments: JSON.stringify({ query: "Pixi.js v8 release notes" }),
        result: "search results",
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
          id: "web-1",
          name: "WebSearch",
          input: { query: "Pixi.js v8 release notes" },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "web-1", content: "search results" }],
    });
  });

  it("maps native Codex webSearch items to visible WebSearch tool calls", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "webSearch",
        id: "native-web-1",
        query: "latest Vite release",
        action: { type: "search", query: "latest Vite release" },
      },
    });
    fakeProc.sendNotification("item/completed", {
      item: {
        type: "webSearch",
        id: "native-web-1",
        query: "latest Vite release",
        action: { type: "search", query: "latest Vite release" },
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
          id: "native-web-1",
          name: "WebSearch",
          input: { query: "latest Vite release" },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [
        {
          type: "tool_result",
          tool_use_id: "native-web-1",
          content: "Searched web for: latest Vite release",
        },
      ],
    });
  });

  it("maps native Codex open-page webSearch actions to visible WebFetch tool calls", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/completed", {
      item: {
        type: "webSearch",
        id: "native-fetch-1",
        query: "OpenAI docs",
        action: { type: "openPage", url: "https://platform.openai.com/docs" },
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
          id: "native-fetch-1",
          name: "WebFetch",
          input: { url: "https://platform.openai.com/docs", query: "OpenAI docs" },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [
        {
          type: "tool_result",
          tool_use_id: "native-fetch-1",
          content: "Fetched https://platform.openai.com/docs",
        },
      ],
    });
  });

  it("does not duplicate MCP tool_use when started and completed both arrive", async () => {
    await createAndInit("Hello");
    events.length = 0;

    fakeProc.sendNotification("item/started", {
      item: {
        type: "dynamicToolCall",
        id: "fetch-1",
        tool: "WebFetch",
        arguments: JSON.stringify({ url: "https://example.com" }),
      },
    });
    fakeProc.sendNotification("item/completed", {
      item: {
        type: "dynamicToolCall",
        id: "fetch-1",
        tool: "WebFetch",
        arguments: JSON.stringify({ url: "https://example.com" }),
        result: "example summary",
      },
    });

    await vi.waitFor(() => {
      expect(events.length).toBe(2);
    });

    expect(events[0]).toMatchObject({
      type: "agent_assistant",
      content: [{ type: "tool_use", id: "fetch-1", name: "WebFetch" }],
    });
    expect(events[1]).toEqual({
      type: "agent_tool_result",
      content: [{ type: "tool_result", tool_use_id: "fetch-1", content: "example summary" }],
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

  it("auto-approves a v2 commandExecution approval request", async () => {
    await createAndInit("Run a privileged command");
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9001,
      method: "item/commandExecution/requestApproval",
      params: { command: "sudo apt-get install foo" },
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9001);
      expect(reply).toBeDefined();
    });

    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9001) as unknown as {
      id: number;
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "accept" });
  });

  it("auto-approves a v2 fileChange approval request", async () => {
    await createAndInit("Edit a protected file");
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9002,
      method: "item/fileChange/requestApproval",
      params: { changes: [{ path: "/etc/hosts" }] },
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9002)).toBeDefined();
    });

    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9002) as unknown as {
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "accept" });
  });

  it("auto-approves a legacy v1 execCommandApproval request with ReviewDecision", async () => {
    await createAndInit("Run a command (legacy server)");
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9003,
      method: "execCommandApproval",
      params: { command: ["ls"] },
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9003)).toBeDefined();
    });

    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9003) as unknown as {
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "approved" });
  });

  it("routes a sensitive v2 approval through the injected permission requester and denies (docs/193)", async () => {
    await createAndInit("Edit a protected file");
    const requester = vi.fn().mockResolvedValue({ behavior: "deny" });
    adapter.setPermissionRequester(requester);
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9101,
      method: "item/fileChange/requestApproval",
      params: { reason: "write to a sensitive file", changes: [{ path: ".npmrc" }] },
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9101)).toBeDefined();
    });
    expect(requester).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "apply_patch", agentId: "codex", input: { file_path: ".npmrc" } }),
    );
    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9101) as unknown as {
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "decline" });
  });

  it("auto-accepts a routine v2 command without invoking the permission requester", async () => {
    await createAndInit("Run a command");
    const requester = vi.fn().mockResolvedValue({ behavior: "deny" });
    adapter.setPermissionRequester(requester);
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9102,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm install" },
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9102)).toBeDefined();
    });
    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9102) as unknown as {
      result: { decision: string };
    };
    expect(requester).not.toHaveBeenCalled();
    expect(reply.result).toEqual({ decision: "accept" });
  });

  it("auto-accepts a routine v1 file change without invoking the permission requester", async () => {
    await createAndInit("Edit a workspace file");
    const requester = vi.fn().mockResolvedValue({ behavior: "deny" });
    adapter.setPermissionRequester(requester);
    fakeProc.stdin.written.length = 0;

    fakeProc.stdout.emit("data", Buffer.from(`${JSON.stringify({
      id: 9103,
      method: "applyPatchApproval",
      params: { fileChanges: { "/workspace/src/app.ts": { type: "update", unified_diff: "" } } },
    })}\n`));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9103)).toBeDefined();
    });
    expect(requester).not.toHaveBeenCalled();
    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9103) as unknown as {
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "approved" });
  });

  it("routes a sensitive v1 command through the requester and honors allow", async () => {
    await createAndInit("Run a command with extra access");
    const requester = vi.fn().mockResolvedValue({ behavior: "allow" });
    adapter.setPermissionRequester(requester);
    fakeProc.stdin.written.length = 0;

    fakeProc.stdout.emit("data", Buffer.from(`${JSON.stringify({
      id: 9104,
      method: "execCommandApproval",
      params: { command: ["curl", "https://example.com"], reason: "requires network access" },
    })}\n`));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9104)).toBeDefined();
    });
    expect(requester).toHaveBeenCalledWith(expect.objectContaining({ agentId: "codex", toolName: "shell" }));
    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9104) as unknown as {
      result: { decision: string };
    };
    expect(reply.result).toEqual({ decision: "approved" });
  });

  it("replies with a JSON-RPC error to an unhandled server request (no hang)", async () => {
    await createAndInit("Hello");
    fakeProc.stdin.written.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9004,
      method: "tool/requestUserInput",
      params: {},
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    await vi.waitFor(() => {
      expect(fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9004)).toBeDefined();
    });

    const reply = fakeProc.getRequests().find((r) => (r as { id?: number }).id === 9004) as unknown as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32601);
  });

  it("does not treat a server request as a response to a pending call", async () => {
    await createAndInit("Hello");
    events.length = 0;

    const reqLine = `${JSON.stringify({
      id: 9005,
      method: "item/commandExecution/requestApproval",
      params: {},
    })}\n`;
    fakeProc.stdout.emit("data", Buffer.from(reqLine));

    fakeProc.sendNotification("turn/completed", { turn: { id: "t", status: "completed" } });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "agent_result")).toBe(true);
    });
    expect(events.find((e) => e.type === "agent_result")).toMatchObject({ status: "success" });
  });

  it("sends turn/start with approvalPolicy:never and dangerFullAccess sandbox", async () => {
    await createAndInit("Run a command");

    const turnStart = fakeProc.getRequests().find((r) => r.method === "turn/start");
    expect(turnStart).toBeDefined();
    expect((turnStart!.params as any).approvalPolicy).toBe("never");
    expect((turnStart!.params as any).sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  describe("compaction (docs/178)", () => {
    it("advertises supportsCompaction", () => {
      adapter = new CodexAdapter();
      expect(adapter.capabilities.supportsCompaction).toBe(true);
    });

    it("maps contextCompaction items to compaction events (auto), with postTokens from tokenUsage", async () => {
      await createAndInit("Hello");

      fakeProc.sendNotification("thread/tokenUsage/updated", {
        tokenUsage: { last: { totalTokens: 50_000 } },
      });
      fakeProc.sendNotification("item/started", { item: { type: "contextCompaction", id: "c1" } });
      fakeProc.sendNotification("item/completed", { item: { type: "contextCompaction", id: "c1" } });

      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "agent_compacted")).toBe(true);
      });

      const started = events.find((e) => e.type === "agent_compaction_started");
      expect(started).toEqual({ type: "agent_compaction_started", trigger: "auto" });
      const done = events.find((e) => e.type === "agent_compacted") as any;
      expect(done.trigger).toBe("auto");
      expect(done.postTokens).toBe(50_000);
    });

    it("compact() sends thread/compact/start and the result is labeled manual", async () => {
      await createAndInit("Hello");

      adapter.compact();

      await vi.waitFor(() => {
        expect(fakeProc.getRequests().some((r) => r.method === "thread/compact/start")).toBe(true);
      });
      const req = fakeProc.getRequests().find((r) => r.method === "thread/compact/start");
      expect((req!.params as any).threadId).toBe("thread-abc-123");

      fakeProc.sendNotification("item/started", { item: { type: "contextCompaction", id: "c2" } });
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "agent_compaction_started")).toBe(true);
      });
      expect(
        (events.find((e) => e.type === "agent_compaction_started") as any).trigger,
      ).toBe("manual");
    });

    it("run({compact:true}) issues thread/compact/start instead of turn/start and ends on completion", async () => {
      adapter = new CodexAdapter(() => false);
      adapter.on("event", (e) => events.push(e));
      adapter.run({ prompt: "/compact", cwd: "/workspace", sessionId: "thread-xyz", compact: true });

      await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
      fakeProc.sendResponse(1, { serverInfo: {} });
      await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));
      fakeProc.sendResponse(2, { threadId: "thread-xyz" });

      await vi.waitFor(() => {
        expect(fakeProc.getRequests().some((r) => r.method === "thread/compact/start")).toBe(true);
      });
      expect(fakeProc.getRequests().some((r) => r.method === "turn/start")).toBe(false);

      fakeProc.sendNotification("item/completed", { item: { type: "contextCompaction", id: "c3" } });
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "agent_result")).toBe(true);
      });
      expect((events.find((e) => e.type === "agent_compacted") as any).trigger).toBe("manual");
      expect(fakeProc.killed).toBe(true);
    });

    it("records a compact-only run's own tokens in its synthetic result", async () => {
      adapter = new CodexAdapter(() => false);
      adapter.on("event", (e) => events.push(e));
      adapter.run({ prompt: "/compact", cwd: "/workspace", sessionId: "thread-xyz", compact: true });

      await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(1));
      fakeProc.sendResponse(1, { serverInfo: {} });
      await vi.waitFor(() => expect(fakeProc.getRequests().length).toBeGreaterThanOrEqual(3));
      fakeProc.sendResponse(2, { threadId: "thread-xyz" });
      await vi.waitFor(() => {
        expect(fakeProc.getRequests().some((r) => r.method === "thread/compact/start")).toBe(true);
      });

      fakeProc.sendNotification("thread/tokenUsage/updated", {
        threadId: "thread-xyz",
        turnId: "turn-before",
        tokenUsage: {
          total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 10 },
          last: { totalTokens: 1010 },
          modelContextWindow: 258400,
        },
      });
      fakeProc.sendNotification("turn/started", { threadId: "thread-xyz", turn: { id: "turn-compact" } });
      fakeProc.sendNotification("thread/tokenUsage/updated", {
        threadId: "thread-xyz",
        turnId: "turn-compact",
        tokenUsage: {
          total: { inputTokens: 2000, cachedInputTokens: 1600, outputTokens: 20 },
          last: { totalTokens: 5439 },
          modelContextWindow: 258400,
        },
      });
      fakeProc.sendNotification("item/completed", { item: { type: "contextCompaction", id: "c4" } });

      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "agent_result")).toBe(true);
      });
      expect(events.find((e) => e.type === "agent_result")).toMatchObject({
        tokens: { input: 200, output: 10, cacheRead: 800 },
        contextTokens: 5439,
      });
    });
  });
});

describe("CodexAdapter / dual-mode auth (feature 119)", () => {
  const HOME_VARS = ["HOME", "AGENT_HOME", "CODEX_HOME", "DEEPSEEK_API_KEY"] as const;
  let savedEnv: Partial<Record<(typeof HOME_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    savedEnv = {};
    for (const name of HOME_VARS) {
      savedEnv[name] = process.env[name];
      Reflect.deleteProperty(process.env, name);
    }
    lastSpawnEnv = undefined;
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    for (const name of HOME_VARS) {
      const value = savedEnv[name];
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  });

  it("emits auth_required when neither file auth nor OPENAI_API_KEY is present", () => {
    const adapter = new CodexAdapter(() => false);
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });
    expect(authRequired).toBe(true);
  });

  it("forwards OPENAI_API_KEY when only the env-key auth path is set", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";

    const adapter = new CodexAdapter(() => false);
    adapter.on("event", () => { /* drain */ });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => {
      expect(lastSpawnEnv).toBeDefined();
    });

    expect(lastSpawnEnv?.OPENAI_API_KEY).toBe("sk-platform-billing");
  });

  it("spawns with the AGENT_HOME-derived home when no resolver is given", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";
    process.env.AGENT_HOME = "/workspace/.inner-shipit/agent-home";
    process.env.HOME = "/root";

    const adapter = new CodexAdapter(() => false);
    adapter.on("event", () => { /* drain */ });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());
    expect(lastSpawnEnv?.HOME).toBe("/workspace/.inner-shipit/agent-home");
    expect(lastSpawnEnv?.CODEX_HOME).toBe("/workspace/.inner-shipit/agent-home/.codex");
  });

  it("carries a writable HOME/CODEX_HOME for a redirected service whose resolver returns undefined", async () => {
    process.env.AGENT_HOME = "/workspace/.inner-shipit/agent-home";
    process.env.HOME = "/root";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";

    const adapter = new CodexAdapter(
      () => false,
      { resolveHome: () => undefined },
    );
    adapter.on("event", () => { /* drain */ });
    adapter.run({
      prompt: "Hello",
      cwd: "/workspace",
      serviceRouting: {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        style: "openai-responses",
        baseUrl: "https://api.deepseek.com/v1",
        credentialSourceEnv: "DEEPSEEK_API_KEY",
        credentialTarget: { kind: "env", name: "OPENAI_API_KEY" },
      },
    });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());
    expect(lastSpawnEnv?.HOME).toBe("/workspace/.inner-shipit/agent-home");
    expect(lastSpawnEnv?.CODEX_HOME).toBe("/workspace/.inner-shipit/agent-home/.codex");
    expect(lastSpawnEnv?.OPENAI_API_KEY).toBe("sk-deepseek");
  });

  it("spawns against the resolved account root, and probes that root's auth.json", async () => {
    const root = "/credentials/provider-accounts/codex/acct-a";
    const probed: (string | undefined)[] = [];

    const adapter = new CodexAdapter(
      (configDir) => { probed.push(configDir); return true; },
      { resolveHome: () => root },
    );
    adapter.on("event", () => { /* drain */ });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());
    expect(lastSpawnEnv?.HOME).toBe(root);
    expect(lastSpawnEnv?.CODEX_HOME).toBe(`${root}/.codex`);
    expect(probed).toContain(`${root}/.codex`);
  });

  it("prefers a per-spawn homeDir over the resolver, for HOME, CODEX_HOME, and the auth probe", async () => {
    const spawnHome = "/credentials/sub-agent-homes/spawn-9";
    const probed: (string | undefined)[] = [];

    const adapter = new CodexAdapter(
      (configDir) => { probed.push(configDir); return true; },
      { resolveHome: () => "/credentials/provider-accounts/codex/acct-a" },
    );
    adapter.on("event", () => { /* drain */ });
    adapter.run({ prompt: "Hello", cwd: "/workspace", homeDir: spawnHome });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());
    expect(lastSpawnEnv?.HOME).toBe(spawnHome);
    expect(lastSpawnEnv?.CODEX_HOME).toBe(`${spawnHome}/.codex`);
    expect(probed).toContain(`${spawnHome}/.codex`);
  });

  it("does not fall back to the env key for a scoped account with no auth.json", () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";

    const adapter = new CodexAdapter(
      () => false,
      { resolveHome: () => "/credentials/provider-accounts/codex/acct-a" },
    );
    let authRequired = false;
    adapter.on("auth_required", () => { authRequired = true; });
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    expect(authRequired).toBe(true);
    expect(lastSpawnEnv).toBeUndefined();
  });

  it("logs the auth path it chose (Platform API)", async () => {
    process.env.OPENAI_API_KEY = "sk-platform-billing";

    const adapter = new CodexAdapter(() => false);
    const logs: { source: string; text: string }[] = [];
    adapter.on("log", (source, text) => logs.push({ source, text }));
    adapter.run({ prompt: "Hello", cwd: "/workspace" });

    await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());

    const platformLog = logs.find((l) => l.text.includes("OPENAI_API_KEY"));
    expect(platformLog).toBeDefined();
  });

  it("trusts the spawn cwd in the config root the child will read", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-spawn-home-"));
    try {
      process.env.OPENAI_API_KEY = "sk-platform-billing";
      process.env.CODEX_HOME = home;

      const adapter = new CodexAdapter(() => false);
      adapter.on("event", () => { /* drain */ });
      adapter.run({ prompt: "Hello", cwd: "/workspace" });

      await vi.waitFor(() => expect(lastSpawnEnv).toBeDefined());
      expect(lastSpawnEnv?.CODEX_HOME).toBe(home);
      expect(configAtSpawn).toContain('[projects."/workspace"]\ntrust_level = "trusted"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
