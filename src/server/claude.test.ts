import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeProcess } from "./claude.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.stdin = null;
  return proc;
}

describe("ClaudeProcess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("NDJSON parsing", () => {
    it("parses complete JSON lines from stdout", async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run("test prompt");

      // Simulate stdout data with a complete JSON line
      const event = { type: "system", subtype: "init", session_id: "abc123" };
      mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("handles multiple events in a single chunk", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run("test");

      const event1 = { type: "system", subtype: "init", session_id: "abc" };
      const event2 = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
      const chunk = JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n";
      mockProc.stdout.emit("data", Buffer.from(chunk));

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(event1);
      expect(events[1]).toEqual(event2);
    });

    it("buffers partial lines across chunks", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run("test");

      const event = { type: "result", subtype: "success", session_id: "xyz" };
      const json = JSON.stringify(event);
      const half = Math.floor(json.length / 2);

      // Send first half
      mockProc.stdout.emit("data", Buffer.from(json.slice(0, half)));
      expect(events).toHaveLength(0);

      // Send second half + newline
      mockProc.stdout.emit("data", Buffer.from(json.slice(half) + "\n"));
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("skips non-JSON lines", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run("test");

      mockProc.stdout.emit("data", Buffer.from("some random text\n"));
      mockProc.stdout.emit("data", Buffer.from("not json either\n"));

      expect(events).toHaveLength(0);
    });

    it("skips empty lines", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run("test");

      const event = { type: "system", subtype: "init", session_id: "abc" };
      mockProc.stdout.emit("data", Buffer.from("\n\n" + JSON.stringify(event) + "\n\n"));

      expect(events).toHaveLength(1);
    });

    it("drains remaining buffer on process close", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      let doneCode: number | null = null;
      claude.on("event", (e) => events.push(e));
      claude.on("done", (code: number | null) => { doneCode = code; });

      claude.run("test");

      // Send data without trailing newline
      const event = { type: "result", subtype: "success", session_id: "abc" };
      mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event)));
      expect(events).toHaveLength(0);

      // Close the process — should drain buffer
      mockProc.emit("close", 0);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
      expect(doneCode).toBe(0);
    });
  });

  describe("auth detection", () => {
    it("emits auth_required when stderr contains auth keywords", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      claude.on("auth_required", () => { authRequired = true; });

      claude.run("test");

      mockProc.stderr.emit("data", Buffer.from("Error: not authenticated\n"));
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
        const mockProc = createMockProcess();
        mockSpawn.mockReturnValue(mockProc as any);

        const claude = new ClaudeProcess();
        let authRequired = false;
        claude.on("auth_required", () => { authRequired = true; });

        claude.run("test");
        mockProc.stderr.emit("data", Buffer.from(keyword));
        expect(authRequired).toBe(true);
      }
    });
  });

  describe("spawn arguments", () => {
    it("spawns claude with correct args", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("hello world");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["-p", "hello world", "--output-format", "stream-json"]),
        expect.objectContaining({ cwd: "/workspace" }),
      );
    });

    it("includes --resume flag when sessionId is provided", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("hello", "session-123");

      expect(mockSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--resume", "session-123"]),
        expect.any(Object),
      );
    });

    it("does not include --resume when no sessionId", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("hello");

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
    });
  });

  describe("kill", () => {
    it("sends SIGTERM to the running process", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run("test");
      claude.kill();

      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is a no-op if no process is running", () => {
      const claude = new ClaudeProcess();
      // Should not throw
      claude.kill();
    });
  });

  describe("error handling", () => {
    it("emits error event on spawn error", () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      claude.on("error", (err) => errors.push(err));

      claude.run("test");
      const err = new Error("spawn ENOENT");
      mockProc.emit("error", err);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("spawn ENOENT");
    });
  });
});
