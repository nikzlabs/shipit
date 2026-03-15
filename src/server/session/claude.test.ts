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

      claude.run("test prompt");

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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

        claude.run("test");
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
      claude.run("hello world", undefined, undefined, undefined, "/workspace");

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
      claude.run("hello", "session-123");

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
      claude.run("hello");

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
    });

    it("uses provided cwd", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("test", undefined, undefined, undefined, "/my/project");

      expect(mockPtySpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({ cwd: "/my/project" }),
      );
    });
  });

  describe("kill", () => {
    it("kills the running process", () => {
      const mockProc = createMockPty();
      mockPtySpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("test");
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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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
      claude.run("test");
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
      // Images param is accepted but ignored — orchestrator saves them to disk
      // and prepends references to the prompt before calling run().
      claude.run("describe this", undefined, undefined, [{ data: "base64", mediaType: "image/png" }]);

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

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

      claude.run("test");

      // Kill before timeout
      claude.kill();

      // Advance past the watchdog timeout
      vi.advanceTimersByTime(30_000);

      const watchdogLog = logs.find((l) => l.text.includes("No output from Claude CLI"));
      expect(watchdogLog).toBeUndefined();
    });
  });
});
