import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeProcess, StreamingClaudeProcess } from "./process.js";

// Mock node-pty
vi.mock("node-pty", () => {
  return {
    spawn: vi.fn(),
  };
});

// Mock node:child_process.spawn so StreamingClaudeProcess never touches a real
// process. The mock returns an EventEmitter with `stdin.write` captured so
// tests can assert exactly what NDJSON the class wrote.
vi.mock("node:child_process", async () => {
  // `vi.importActual` is the vitest-blessed way to get the real module inside
  // a mock factory — the inline import() type is required by its signature.
  // eslint-disable-next-line no-restricted-syntax
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...real,
    spawn: vi.fn(),
  };
});

// Mock stripAnsi — pass through for tests
vi.mock("../../../shared/strip-ansi.js", () => {
  return {
    stripAnsi: (text: string) => text,
  };
});


import * as pty from "node-pty";
import * as childProcess from "node:child_process";
const mockPtySpawn = vi.mocked(pty.spawn);
const mockChildSpawn = vi.mocked(childProcess.spawn);

/** Minimal ChildProcess fake — captures stdin writes and lets tests fire stdout/stderr/close. */
function createMockChildProcess() {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinWrites: string[] = [];
  const stdin = {
    write: vi.fn((data: string) => {
      stdinWrites.push(data);
      return true;
    }),
    writable: true,
    destroyed: false,
    writableEnded: false,
  };
  const proc: any = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.stdin = stdin;
  proc.kill = vi.fn();
  proc.stdinWrites = stdinWrites;
  return proc;
}

/** Callback-based mock matching the IPty interface. */
function createMockPty() {
  let onDataCallback: ((data: string) => void) | null = null;
  let onExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  const mock = {
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      onExitCallback = cb;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    cols: 200,
    rows: 24,
    process: "claude",
    handleFlowControl: false,
    // Helpers for tests to simulate data and exit
    simulateData(data: string) {
      onDataCallback?.(data);
    },
    simulateExit(exitCode: number) {
      onExitCallback?.({ exitCode });
    },
  };
  return mock;
}

describe("ClaudeProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("NDJSON parsing", () => {
    it("parses complete JSON lines from PTY data", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test prompt" });

      // Simulate PTY data with a complete JSON line
      const event = { type: "system", subtype: "init", session_id: "abc123" };
      mockProc.simulateData(`${JSON.stringify(event)  }\n`);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("handles multiple events in a single chunk", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      const event1 = { type: "system", subtype: "init", session_id: "abc" };
      const event2 = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      const chunk = `${JSON.stringify(event1)  }\n${  JSON.stringify(event2)  }\n`;
      mockProc.simulateData(chunk);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });

    it("buffers partial lines across chunks", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      const event = { type: "result", subtype: "success", session_id: "xyz" };
      const json = JSON.stringify(event);
      const half = Math.floor(json.length / 2);

      // Send first half
      mockProc.simulateData(json.slice(0, half));
      expect(events).toHaveLength(0);

      // Send second half + newline
      mockProc.simulateData(`${json.slice(half)  }\n`);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("skips non-JSON lines", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      mockProc.simulateData("some random text\n");
      mockProc.simulateData("not json either\n");

      expect(events).toHaveLength(0);
    });

    it("skips empty lines", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      const event = { type: "system", subtype: "init", session_id: "abc" };
      mockProc.simulateData(`\n\n${  JSON.stringify(event)  }\n\n`);

      expect(events).toHaveLength(1);
    });

    it("drains remaining buffer on process exit", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      let doneCode: number | null = null;
      claude.on("event", (e) => events.push(e));
      claude.on("done", (code: number | null) => { doneCode = code; });

      claude.run({ prompt: "test" });

      // Send data without trailing newline
      const event = { type: "result", subtype: "success", session_id: "abc" };
      mockProc.simulateData(JSON.stringify(event));
      expect(events).toHaveLength(0);

      // Exit the process — should drain buffer
      mockProc.simulateExit(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
      expect(doneCode).toBe(0);
    });
  });

  describe("auth detection", () => {
    it("emits auth_required when output contains auth keywords", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      claude.on("auth_required", () => { authRequired = true; });

      claude.run({ prompt: "test" });

      // With PTY, auth errors come through the combined data stream
      mockProc.simulateData("Error: not authenticated\n");
      expect(authRequired).toBe(true);
    });

    it("detects various auth-related messages", () => {
      const keywords = [
        "not authenticated",
        "Not logged in",
        "Authentication required",
        "Please login first",
        "Unauthorized access",
        "OAuth flow needed",
        "Please sign in",
      ];

      for (const keyword of keywords) {
        const mockProc = createMockPty();
        mockPtySpawn.mockReturnValue(mockProc as any);

        const claude = new ClaudeProcess();
        let authRequired = false;
        claude.on("auth_required", () => { authRequired = true; });

        claude.run({ prompt: "test" });
        mockProc.simulateData(`${keyword  }\n`);
        expect(authRequired).toBe(true);
      }
    });
  });

  describe("spawn arguments", () => {
    it("spawns claude with correct args via node-pty", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello world", cwd: "/workspace" });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["-p", "hello world", "--output-format", "stream-json"]),
        expect.objectContaining({ cwd: "/workspace", name: "xterm-256color" }),
      );
    });

    it("includes --resume flag when sessionId is provided", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello", sessionId: "session-123" });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--resume", "session-123"]),
        expect.any(Object),
      );
    });

    it("does not include --resume when no sessionId", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
    });

    it("uses provided cwd", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", cwd: "/my/project" });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({ cwd: "/my/project" }),
      );
    });

    it("includes --mcp-config flag when mcpConfigPath is provided", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", mcpConfigPath: "/tmp/mcp-config.json" });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--mcp-config", "/tmp/mcp-config.json"]),
        expect.any(Object),
      );
    });

    it("does not include --mcp-config when mcpConfigPath is not provided", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--mcp-config");
    });

    it("includes --settings flag when settingsPath is provided", () => {
      // Settings path is how the orchestrator enables the PR-enforcement
      // Stop hook (docs/129-stop-hook-pr-enforcement). Regression-protect
      // the wiring so the flag actually reaches the CLI.
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", settingsPath: "/etc/shipit/managed-settings.json" });

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--settings", "/etc/shipit/managed-settings.json"]),
        expect.any(Object),
      );
    });

    it("does not include --settings when settingsPath is omitted", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--settings");
    });

    it("sets SHIPIT_AUTO_CREATE_PR=1 in the env when autoCreatePr is true", () => {
      // The managed-settings.json Stop hook self-gates on this env var so PR
      // enforcement stays opt-in. See docs/130-block-branch-ops/plan.md.
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", autoCreatePr: true });

      const spawnOpts = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_AUTO_CREATE_PR).toBe("1");
    });

    it("does not set SHIPIT_AUTO_CREATE_PR when autoCreatePr is falsy", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const spawnOpts = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_AUTO_CREATE_PR).toBeUndefined();
    });

    it("maps guarded mode to --permission-mode auto (docs/138)", () => {
      // Deliberate inversion: ShipIt `guarded` → CLI `auto` (classifier-gated).
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "guarded" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("auto");
    });

    it("maps plan mode to --permission-mode plan", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "plan" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const idx = args.indexOf("--permission-mode");
      expect(args[idx + 1]).toBe("plan");
    });

    it("passes no --permission-mode flag for auto mode", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "auto" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--permission-mode");
    });

    it("keeps the full AUTO_TOOLS allowlist for guarded mode", () => {
      // Guarded reuses AUTO_TOOLS — the CLI classifier (not the allowlist)
      // gates Bash/network. Bash must still be present in the allowlist.
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "guarded" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools).toContain("Bash");
      expect(tools).toContain("Write");
    });

    it("includes browser tools in allowed tools list", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const toolsIdx = args.indexOf("--allowedTools");
      const tools = args[toolsIdx + 1];
      expect(tools).toContain("mcp__playwright__");
    });

    // docs/149 — the worker-registered `shipit-review` MCP bridge isn't a
    // user-configured server, so it never flows through `mcpServerNames`. The
    // tool must still be allowlisted explicitly or headless `-p` mode rejects
    // it as "permission not yet granted" — including from review subagents.
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit-review__* in %s mode", (_label, permissionMode) => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit-review__*");
    });

    // Same rationale as shipit-review: the worker-registered `shipit-present`
    // bridge isn't user-configured, so it must be allowlisted explicitly or
    // headless `-p` mode rejects `present` as "permission not yet granted".
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit-present__* in %s mode", (_label, permissionMode) => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit-present__*");
    });

    // docs/163: the worker-registered `shipit-voice` bridge (the built-in
    // `voice_note` tool) must be allowlisted in every mode — including plan, so
    // the agent can author a spoken headline before ExitPlanMode.
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit-voice__* in %s mode", (_label, permissionMode) => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit-voice__*");
    });

    // docs/138: `Skill` must be allowlisted in every permission mode so an
    // explicit `/my-skill` invocation is honored even in headless `-p` mode
    // (no human to approve the prompt) and even in plan mode.
    it.each([
      ["auto", undefined],
      ["plan", "plan"],
    ] as const)("allowlists the Skill tool in %s mode", (_label, permissionMode) => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "/my-skill", permissionMode: permissionMode as any });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("Skill");
    });
  });

  describe("kill", () => {
    it("kills the running process", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      claude.kill();

      expect(mockProc.kill).toHaveBeenCalled();
    });

    it("is a no-op if no process is running", () => {
      const claude = new ClaudeProcess();
      // Should not throw
      claude.kill();
    });
  });

  describe("error handling", () => {
    it("emits error event when pty.spawn throws", () => {
      mockPtySpawn.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      claude.on("error", (err) => errors.push(err));

      claude.run({ prompt: "test" });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("spawn ENOENT");
    });
  });

  describe("log emission", () => {
    it("emits log event for non-JSON lines in PTY output", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      mockProc.simulateData("Some debug output\n");

      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({ source: "stdout", text: "Some debug output" });
    });

    it("does not emit log for valid JSON lines", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      const event = { type: "system", subtype: "init", session_id: "abc" };
      mockProc.simulateData(`${JSON.stringify(event)  }\n`);

      expect(logs).toHaveLength(0);
    });
  });

  describe("writeStdin", () => {
    it("writes data to the PTY", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      claude.writeStdin("answer text\n");

      expect(mockProc.write).toHaveBeenCalledWith("answer text\n");
    });

    it("is a no-op if no process is running", () => {
      const claude = new ClaudeProcess();
      // Should not throw
      claude.writeStdin("test");
    });
  });

  describe("image support", () => {
    it("passes prompt through unchanged (images handled by orchestrator)", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const images = [{ data: "base64data", mediaType: "image/png" }];
      claude.run({ prompt: "describe this", images });

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      const promptIdx = args.indexOf("-p") + 1;
      expect(args[promptIdx]).toBe("describe this");
      expect(mockProc.write).not.toHaveBeenCalled();
    });
  });

  describe("inactivity watchdog", () => {
    it("emits warning log after 30 seconds of no output", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      // Advance timer by 30 seconds
      vi.advanceTimersByTime(30_000);

      const watchdogLog = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(watchdogLog).toBeDefined();
      expect(watchdogLog!.source).toBe("server");
    });

    it("clears watchdog when data is received", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      // Receive data before timeout
      mockProc.simulateData("some output\n");

      // Advance past the watchdog timeout
      vi.advanceTimersByTime(30_000);

      const watchdogLog = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(watchdogLog).toBeUndefined();
    });

    it("clears watchdog on process exit", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      // Exit before timeout
      mockProc.simulateExit(0);

      // Advance past the watchdog timeout
      vi.advanceTimersByTime(30_000);

      const watchdogLog = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(watchdogLog).toBeUndefined();
    });

    it("clears watchdog on kill", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      // Kill before timeout
      claude.kill();

      // Advance past the watchdog timeout
      vi.advanceTimersByTime(30_000);

      const watchdogLog = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(watchdogLog).toBeUndefined();
    });
  });
});

describe("StreamingClaudeProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("interrupt", () => {
    it("writes an interrupt control_request NDJSON line to stdin", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      // Discard the initial user message write.
      mockProc.stdinWrites.length = 0;

      streaming.interrupt();

      expect(mockProc.stdinWrites).toHaveLength(1);
      const line = mockProc.stdinWrites[0];
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line) as {
        type: string;
        request_id: string;
        request: { subtype: string };
      };
      expect(parsed.type).toBe("control_request");
      expect(parsed.request).toEqual({ subtype: "interrupt" });
      expect(parsed.request_id).toMatch(/^ctrl-/);
    });

    it("does NOT force-kill the persistent process after an interrupt (docs/140 — exit 143 regression)", () => {
      // A streaming interrupt is a graceful control_request: the CLI ends the
      // turn with a `result` but keeps the process alive. The old force-kill
      // timer SIGTERMed the still-alive process ~5s later (exit 143), tearing
      // down any turn the user steered in after interrupting.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });

      streaming.interrupt();

      // Advance well past the old 5s force-kill window — the process must
      // remain alive so the next steered message can reach it.
      vi.advanceTimersByTime(10_000);

      expect(mockProc.kill).not.toHaveBeenCalled();
    });

    it("lets a steered message reach the process after an interrupt", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });

      streaming.interrupt();
      vi.advanceTimersByTime(10_000);
      mockProc.stdinWrites.length = 0;

      // The user sends a new message after interrupting.
      streaming.sendUserMessage("go this way instead");

      expect(mockProc.kill).not.toHaveBeenCalled();
      expect(mockProc.stdinWrites).toHaveLength(1);
      const parsed = JSON.parse(mockProc.stdinWrites[0]) as {
        type: string;
        message: { content: { type: string; text: string }[] };
      };
      expect(parsed.type).toBe("user");
      expect(parsed.message.content[0].text).toBe("go this way instead");
    });
  });

  describe("NDJSON framing (sendUserMessage)", () => {
    it("serializes the initial prompt as a type:user NDJSON line on run()", () => {
      // run() feeds the first prompt via sendUserMessage rather than a CLI arg
      // (streaming mode: the prompt is the first stdin message, not -p).
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "build me a thing" });

      expect(mockProc.stdinWrites).toHaveLength(1);
      const line = mockProc.stdinWrites[0];
      expect(line.endsWith("\n")).toBe(true);
      // Exactly one NDJSON record — no embedded newlines before the trailing one.
      expect(line.slice(0, -1).includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as {
        type: string;
        message: { role: string; content: { type: string; text: string }[] };
      };
      expect(parsed).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "build me a thing" }] },
      });
    });

    it("serializes a steered message as a type:user NDJSON line", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      streaming.sendUserMessage("actually, use TypeScript");

      expect(mockProc.stdinWrites).toHaveLength(1);
      const parsed = JSON.parse(mockProc.stdinWrites[0]) as {
        type: string;
        message: { role: string; content: { type: string; text: string }[] };
      };
      expect(parsed).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "actually, use TypeScript" }] },
      });
    });

    it("preserves special characters (quotes, newlines, unicode) via JSON escaping", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      const tricky = 'line1\n"quoted" \\ backslash 你好 🚀';
      streaming.sendUserMessage(tricky);

      // The serialized record is still a single line (the inner newline is
      // escaped as \n, not a literal framing newline).
      const line = mockProc.stdinWrites[0];
      expect(line.slice(0, -1).includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as { message: { content: { text: string }[] } };
      expect(parsed.message.content[0].text).toBe(tricky);
    });

    it("accepts an images option without throwing and still frames a text-only user message", () => {
      // Image embedding is not yet wired into the streaming serializer — the
      // option is accepted (interface parity with the orchestrator) but the
      // NDJSON line carries only the text block. This pins current behavior so a
      // future image implementation is a deliberate, test-visible change.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      streaming.sendUserMessage("look at this", {
        images: [{ data: "base64data", mediaType: "image/png" }],
      });

      expect(mockProc.stdinWrites).toHaveLength(1);
      const parsed = JSON.parse(mockProc.stdinWrites[0]) as {
        message: { content: { type: string; text: string }[] };
      };
      expect(parsed.message.content).toEqual([{ type: "text", text: "look at this" }]);
    });
  });

  describe("result as turn-end (process stays alive)", () => {
    it("surfaces a result event but does NOT emit done or kill the process", () => {
      // The defining streaming behavior: a `result` ends the *turn*, not the
      // process. `done` is reserved for an actual process exit (kill/dispose).
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const events: { type: string }[] = [];
      let doneCalls = 0;
      streaming.on("event", (e) => events.push(e));
      streaming.on("done", () => { doneCalls += 1; });

      streaming.run({ prompt: "first" });

      const result = { type: "result", subtype: "success", session_id: "abc" };
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify(result)}\n`));

      expect(events).toContainEqual(result);
      expect(doneCalls).toBe(0);
      expect(mockProc.kill).not.toHaveBeenCalled();
    });

    it("can run multiple turns on the same process (result → send → result)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const results: unknown[] = [];
      let doneCalls = 0;
      streaming.on("event", (e: { type: string }) => { if (e.type === "result") results.push(e); });
      streaming.on("done", () => { doneCalls += 1; });

      streaming.run({ prompt: "turn one" });
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", session_id: "abc" })}\n`));

      // Second turn on the SAME persistent process.
      streaming.sendUserMessage("turn two");
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", session_id: "abc" })}\n`));

      expect(results).toHaveLength(2);
      expect(doneCalls).toBe(0);
    });

    it("emits done only when the process actually closes", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const doneCodes: (number | null)[] = [];
      streaming.on("done", (code: number | null) => doneCodes.push(code));

      streaming.run({ prompt: "first" });

      // A result alone must not produce a done.
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", session_id: "abc" })}\n`));
      expect(doneCodes).toHaveLength(0);

      // Real process exit → done with the exit code.
      mockProc.emit("close", 0);
      expect(doneCodes).toEqual([0]);
    });
  });

  describe("replay-echo handling (--replay-user-messages)", () => {
    it("surfaces a replayed user message (isReplay:true) as an event", () => {
      // --replay-user-messages re-emits injected user messages on stdout with
      // isReplay:true so the orchestrator can reconcile its optimistic insert.
      // The process must parse and surface it like any other event.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const events: { type: string; isReplay?: boolean }[] = [];
      streaming.on("event", (e) => events.push(e));

      streaming.run({ prompt: "first" });

      const echo = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "steered text" }] },
        isReplay: true,
      };
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify(echo)}\n`));

      const replay = events.find((e) => e.type === "user" && e.isReplay === true);
      expect(replay).toBeDefined();
      expect(replay).toEqual(echo);
    });

    it("does not emit a replay echo as a log line", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      streaming.run({ prompt: "first" });
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "user", message: { role: "user", content: [] }, isReplay: true })}\n`));

      expect(logs).toHaveLength(0);
    });
  });

  describe("control-message round-trip", () => {
    it("correlates a control_response to its control_request by request_id", () => {
      // setPermissionMode writes a control_request stamped with a unique
      // request_id; the CLI's matching control_response arrives on stdout and
      // surfaces as an event carrying the same request_id, so the orchestrator
      // can pair the two.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const events: { type: string; request_id?: string }[] = [];
      streaming.on("event", (e) => events.push(e));

      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      streaming.setPermissionMode("plan");
      const request = JSON.parse(mockProc.stdinWrites[0]) as { request_id: string };
      expect(request.request_id).toMatch(/^set-mode-/);

      // The CLI replies with a control_response carrying the same id.
      const response = {
        type: "control_response",
        response: { subtype: "success", request_id: request.request_id },
      };
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`));

      const surfaced = events.find((e) => e.type === "control_response");
      expect(surfaced).toEqual(response);
    });

    it("stamps each control_request with a distinct request_id", () => {
      // Distinct ids are what make response correlation unambiguous.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      streaming.setPermissionMode("plan");
      streaming.interrupt();
      streaming.setPermissionMode("auto");

      const ids = mockProc.stdinWrites.map((line: string) => {
        return (JSON.parse(line) as { request_id: string }).request_id;
      });
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("turn-scoped inactivity watchdog", () => {
    it("arms on send and warns after 30s of no output within a turn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      // run() sends the initial message, which arms the watchdog.
      streaming.run({ prompt: "first" });
      vi.advanceTimersByTime(30_000);

      const warn = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(warn).toBeDefined();
      expect(warn!.source).toBe("server");
    });

    it("clears the watchdog when the turn ends (result), and stays cleared while idle between turns", () => {
      // The streaming watchdog is turn-scoped: a persistent process sitting idle
      // *between* turns must not trip the 30s warning.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      streaming.run({ prompt: "first" });

      // Turn ends well before the 30s window.
      vi.advanceTimersByTime(10_000);
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", session_id: "abc" })}\n`));

      // Now sit idle (alive but no turn in flight) past the window.
      vi.advanceTimersByTime(60_000);

      const warn = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(warn).toBeUndefined();
    });

    it("re-arms on the next turn's send after a prior turn cleared it", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      streaming.run({ prompt: "first" });
      mockProc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", session_id: "abc" })}\n`));

      // Second turn arms a fresh watchdog.
      streaming.sendUserMessage("turn two");
      vi.advanceTimersByTime(30_000);

      const warn = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(warn).toBeDefined();
    });

    it("clears the watchdog on kill", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      streaming.run({ prompt: "first" });
      streaming.kill();
      vi.advanceTimersByTime(30_000);

      const warn = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(warn).toBeUndefined();
    });
  });

  describe("setPermissionMode", () => {
    it("writes a set_permission_mode control_request NDJSON line to stdin (docs/138)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });

      // Discard the initial user message write so we can assert on the
      // control_request in isolation.
      mockProc.stdinWrites.length = 0;

      streaming.setPermissionMode("plan");
      expect(mockProc.stdinWrites).toHaveLength(1);
      const line = mockProc.stdinWrites[0];
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line) as {
        type: string;
        request_id: string;
        request: { subtype: string; mode: string };
      };
      expect(parsed.type).toBe("control_request");
      expect(parsed.request).toEqual({ subtype: "set_permission_mode", mode: "plan" });
      expect(parsed.request_id).toMatch(/^set-mode-/);
    });

    it("passes the CLI mode string through verbatim (adapter does the ShipIt → CLI mapping)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first" });
      mockProc.stdinWrites.length = 0;

      streaming.setPermissionMode("auto");
      streaming.setPermissionMode("default");

      expect(mockProc.stdinWrites).toHaveLength(2);
      const modes = mockProc.stdinWrites.map((line: string) => {
        const parsed = JSON.parse(line) as { request: { mode: string } };
        return parsed.request.mode;
      });
      expect(modes).toEqual(["auto", "default"]);
    });
  });
});
