import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeProcess } from "./claude.js";

// Mock node-pty
vi.mock("node-pty", () => {
  return {
    spawn: vi.fn(),
  };
});

// Mock stripAnsi — pass through for tests
vi.mock("../shared/strip-ansi.js", () => {
  return {
    stripAnsi: (text: string) => text,
  };
});


import * as pty from "node-pty";
const mockPtySpawn = vi.mocked(pty.spawn);

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
