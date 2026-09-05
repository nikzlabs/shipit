import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { ClaudeProcess, StreamingClaudeProcess, applyServiceRouting } from "./process.js";
import type { ServiceRouting } from "../../../shared/types.js";
import { agentHome } from "../../../shared/agent-home.js";

// Mock node:child_process.spawn so neither process ever touches a real
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

// Real implementation, made observable — see the tree-teardown tests below.
vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) };
});
import { killProcessTree } from "../../../shared/kill-child.js";


import * as childProcess from "node:child_process";
const mockChildSpawn = vi.mocked(childProcess.spawn);

/**
 * Minimal ChildProcess fake — captures stdin writes and lets tests fire
 * stdout/stderr/close. Both processes spawn over piped stdio — the one-shot
 * path moved off node-pty so an oversized prompt can't overflow argv — so this
 * one fake serves both.
 *
 * `pid` is set because `killChild()` refuses to signal a process whose pid is
 * undefined — a fake without one silently no-ops every kill assertion.
 */
function createMockChildProcess() {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinWrites: string[] = [];
  // An EventEmitter, not a plain object: stdin is where EPIPE surfaces, and an
  // unhandled stream `error` takes the worker process down with it. A fake that
  // cannot emit one cannot guard that.
  const stdin: any = new EventEmitter();
  stdin.write = vi.fn((data: string) => {
    stdinWrites.push(data);
    return true;
  });
  stdin.end = vi.fn();
  stdin.writable = true;
  stdin.destroyed = false;
  stdin.writableEnded = false;
  const proc: any = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.stdin = stdin;
  proc.kill = vi.fn();
  proc.pid = 12345;
  proc.stdinWrites = stdinWrites;
  // Helpers mirroring the old PTY fake's, so the one-shot tests read the same.
  proc.simulateData = (data: string) => stdoutEmitter.emit("data", Buffer.from(data));
  proc.simulateStderr = (data: string) => stderrEmitter.emit("data", Buffer.from(data));
  proc.simulateExit = (exitCode: number) => proc.emit("close", exitCode);
  return proc;
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
    it("parses complete JSON lines from stdout data", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test prompt" });

      // Simulate stdout data with a complete JSON line
      const event = { type: "system", subtype: "init", session_id: "abc123" };
      mockProc.simulateData(`${JSON.stringify(event)  }\n`);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it("handles multiple events in a single chunk", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      mockProc.simulateData("some random text\n");
      mockProc.simulateData("not json either\n");

      expect(events).toHaveLength(0);
    });

    it("skips empty lines", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });

      const event = { type: "system", subtype: "init", session_id: "abc" };
      mockProc.simulateData(`\n\n${  JSON.stringify(event)  }\n\n`);

      expect(events).toHaveLength(1);
    });

    it("drains remaining buffer on process exit", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      claude.on("auth_required", () => { authRequired = true; });

      claude.run({ prompt: "test" });

      // Auth errors can arrive on stdout as non-JSON lines
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
        const mockProc = createMockChildProcess();
        mockChildSpawn.mockReturnValue(mockProc as any);

        const claude = new ClaudeProcess();
        let authRequired = false;
        claude.on("auth_required", () => { authRequired = true; });

        claude.run({ prompt: "test" });
        mockProc.simulateData(`${keyword  }\n`);
        expect(authRequired).toBe(true);
      }
    });

    it("raises auth_required from the structured events a real unauthenticated run emits", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      let authRequiredCount = 0;
      claude.on("event", (e) => events.push(e));
      claude.on("auth_required", () => { authRequiredCount += 1; });

      claude.run({ prompt: "test" });

      // Verbatim shape from CLI 2.1.219: a synthetic assistant message, then a
      // result whose `subtype` is "success" and whose `is_error` is true. Both
      // used to slip through as ordinary turn content, so the CLI's own
      // "run /login" line was rendered as the agent's reply.
      mockProc.simulateData(
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
          error: "authentication_failed",
          is_api_error_message: true,
        })}\n${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          session_id: "abc",
          result: "Not logged in · Please run /login",
        })}\n`,
      );

      // ONE signal for one failure, even though the CLI describes it twice.
      // `auth_required` consumers heal the token and re-dispatch the whole
      // turn, so a second raise re-runs the user's turn — see
      // `consumeAuthFailureEvent`.
      expect(authRequiredCount).toBe(1);
      // But BOTH events are still swallowed: ShipIt owns the recovery and the
      // sign-in copy, and either one reaching the transcript renders the CLI's
      // "run /login" line as the agent's reply.
      expect(events).toEqual([]);
    });

    it("raises auth_required again on a later turn of a resident streaming process", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new StreamingClaudeProcess();
      let authRequiredCount = 0;
      claude.on("auth_required", () => { authRequiredCount += 1; });

      const authFailure = `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        error: "authentication_failed",
        is_api_error_message: true,
      })}\n${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        session_id: "abc",
        result: "Not logged in · Please run /login",
      })}\n`;

      claude.run({ prompt: "first" });
      mockProc.stdout.emit("data", Buffer.from(authFailure));
      expect(authRequiredCount).toBe(1);

      // The latch is per-turn, not per-process. This process is resident across
      // turns, so a failure on a LATER turn must raise the signal again —
      // otherwise one auth failure would permanently disable recovery for the
      // life of the session.
      claude.sendUserMessage("second");
      mockProc.stdout.emit("data", Buffer.from(authFailure));
      expect(authRequiredCount).toBe(2);
    });

    it("still forwards a normal assistant message and a clean result", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const events: unknown[] = [];
      let authRequired = false;
      claude.on("event", (e) => events.push(e));
      claude.on("auth_required", () => { authRequired = true; });

      claude.run({ prompt: "test" });
      mockProc.simulateData(
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Added the sign in button." }] },
        })}\n${JSON.stringify({
          type: "result", subtype: "success", session_id: "abc", result: "Added the sign in button.",
        })}\n`,
      );

      expect(authRequired).toBe(false);
      expect(events).toHaveLength(2);
    });
  });

  describe("spawn arguments", () => {
    it("spawns claude over piped stdio in stream-json input mode", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello world", cwd: "/workspace" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--print",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
        ]),
        expect.objectContaining({ cwd: "/workspace", stdio: ["pipe", "pipe", "pipe"] }),
      );
    });

    it("passes the system prompt as a file, keeping it out of argv too", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      // The system prompt is the argument most likely to overflow: ShipIt's own
      // instructions are tens of KB before the unbounded conversation replay a
      // fork or rewind appends to them.
      const systemPrompt = `You are ShipIt.\n${"replay ".repeat(30_000)}`;
      const claude = new ClaudeProcess();
      claude.run({ prompt: "hi", systemPrompt });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--append-system-prompt");
      expect(args).not.toContain(systemPrompt);
      const path = args[args.indexOf("--append-system-prompt-file") + 1] as string;
      expect(readFileSync(path, "utf-8")).toBe(systemPrompt);
      expect(args).toContain("--exclude-dynamic-system-prompt-sections");

      // …and the temp file does not outlive the process.
      mockProc.simulateExit(0);
      expect(existsSync(path)).toBe(false);
    });

    // CLI 2.1.251 holds a session on an id it does not recognize to the 200K
    // window it assumes, so a 1M model needs `[1m]` on the flag or it silently
    // runs at a fifth of its window. Both spawn paths carry that, and they are
    // asserted separately because only the streaming one is resident.
    it("tells the CLI a 1M model's real window on the one-shot spawn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      new ClaudeProcess().run({ prompt: "hi", model: "claude-fable-5-1" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5-1[1m]");
    });

    it("tells the CLI a 1M model's real window on the streaming spawn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      new StreamingClaudeProcess().run({ prompt: "hi", model: "claude-fable-5-1" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5-1[1m]");
    });

    it("leaves a 200K model's flag alone", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      new ClaudeProcess().run({ prompt: "hi", model: "haiku" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    });

    it("writes no system-prompt file when there is no system prompt", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hi" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--append-system-prompt-file");
      expect(args).not.toContain("--exclude-dynamic-system-prompt-sections");
    });

    it("gives concurrent spawns their own system-prompt file", () => {
      // Sub-agent spawns run concurrently; two started in the same millisecond
      // must not share a path, or the first to exit deletes the other's file.
      const paths = ["a", "b"].map((tag) => {
        const mockProc = createMockChildProcess();
        mockChildSpawn.mockReturnValue(mockProc as any);
        new ClaudeProcess().run({ prompt: "hi", systemPrompt: `system ${tag}` });
        const args = mockChildSpawn.mock.calls.at(-1)![1] as string[];
        return args[args.indexOf("--append-system-prompt-file") + 1] as string;
      });

      expect(paths[0]).not.toBe(paths[1]);
      expect(readFileSync(paths[0]!, "utf-8")).toBe("system a");
      expect(readFileSync(paths[1]!, "utf-8")).toBe("system b");
      paths.forEach((p) => { try { unlinkSync(p!); } catch { /* ignore */ } });
    });

    it("never puts the prompt in argv (MAX_ARG_STRLEN caps one argument at 128 KiB)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello world", cwd: "/workspace" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("hello world");
      expect(args).not.toContain("-p");
    });

    it("includes --resume flag when sessionId is provided", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello", sessionId: "session-123" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--resume", "session-123"]),
        expect.any(Object),
      );
    });

    it("does not include --resume when no sessionId", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--resume");
    });

    it("uses provided cwd", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", cwd: "/my/project" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({ cwd: "/my/project" }),
      );
    });

    it("includes --mcp-config flag when mcpConfigPath is provided", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", mcpConfigPath: "/tmp/mcp-config.json" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--mcp-config", "/tmp/mcp-config.json"]),
        expect.any(Object),
      );
    });

    it("does not include --mcp-config when mcpConfigPath is not provided", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--mcp-config");
    });

    // docs/217 — reasoning effort via --effort.
    it("includes --effort when reasoningEffort is provided", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", reasoningEffort: "xhigh" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--effort", "xhigh"]),
        expect.any(Object),
      );
    });

    it("does not include --effort when reasoningEffort is absent (CLI default)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--effort");
    });

    it("includes --permission-prompt-tool when permissionPromptTool is provided (docs/193)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionPromptTool: "mcp__shipit__permission_prompt" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--permission-prompt-tool", "mcp__shipit__permission_prompt"]),
        expect.any(Object),
      );
    });

    it("omits --permission-prompt-tool when not provided", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--permission-prompt-tool");
    });

    it("includes --settings flag when settingsPath is provided", () => {
      // Settings path is how the orchestrator enables the PR-enforcement
      // Stop hook (docs/129-stop-hook-pr-enforcement). Regression-protect
      // the wiring so the flag actually reaches the CLI.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", settingsPath: "/etc/shipit/managed-settings.json" });

      expect(mockChildSpawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining(["--settings", "/etc/shipit/managed-settings.json"]),
        expect.any(Object),
      );
    });

    it("does not include --settings when settingsPath is omitted", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--settings");
    });

    it("sets SHIPIT_AUTO_CREATE_PR=1 in the env when autoCreatePr is true", () => {
      // The managed-settings.json Stop hook self-gates on this env var so PR
      // enforcement stays opt-in. See docs/130-block-branch-ops/plan.md.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", autoCreatePr: true });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_AUTO_CREATE_PR).toBe("1");
    });

    it("does not set SHIPIT_AUTO_CREATE_PR when autoCreatePr is falsy", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_AUTO_CREATE_PR).toBeUndefined();
    });

    it("planning#267 — sets SHIPIT_GUARD_DESTRUCTIVE_GIT=1 when guardDestructiveGit is true", () => {
      // Arms the managed-settings.json PreToolUse hook's destructive-git rule
      // for a session sitting on a merged branch. See docs/130.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", guardDestructiveGit: true });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_GUARD_DESTRUCTIVE_GIT).toBe("1");
    });

    it("planning#267 — does not set SHIPIT_GUARD_DESTRUCTIVE_GIT when guardDestructiveGit is falsy", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.SHIPIT_GUARD_DESTRUCTIVE_GIT).toBeUndefined();
    });

    // docs/150 — account selection reaches a local-mode CLI through HOME.
    // The default (no resolver) is the containerized/worker path and MUST keep
    // resolving `agentHome()`; that is the regression that would matter most.
    it("spawns with the process-global agentHome() when no resolver is given", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.HOME).toBe(agentHome());
    });

    it("spawns with the resolver's home when one is given, resolved per spawn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      let home = "/credentials/provider-accounts/claude/acct-a";
      const claude = new ClaudeProcess(() => home);
      claude.run({ prompt: "test" });
      expect((mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> }).env.HOME)
        .toBe("/credentials/provider-accounts/claude/acct-a");

      // A mid-session failover repoints the session at another account under
      // the same process object, so the answer is re-read on the next spawn
      // rather than captured at construction.
      home = "/credentials/provider-accounts/claude/acct-b";
      claude.run({ prompt: "again" });
      expect((mockChildSpawn.mock.calls[1][2] as { env: Record<string, string> }).env.HOME)
        .toBe("/credentials/provider-accounts/claude/acct-b");
    });

    // docs/150 — the CLI prefers an env key/token over the OAuth credentials at
    // HOME, so pointing HOME at an account root without this would keep billing
    // metered API usage while the router believed the turn ran on the account.
    it("drops the env-based Anthropic credentials when scoped to an account", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);
      process.env.ANTHROPIC_API_KEY = "sk-metered";
      process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
      try {
        new ClaudeProcess(() => "/credentials/provider-accounts/claude/acct-a")
          .run({ prompt: "test" });
        const env = (mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

        // A reserved route resolves no account root and must KEEP them — they
        // are its auth.
        new ClaudeProcess().run({ prompt: "test" });
        const unscoped = (mockChildSpawn.mock.calls[1][2] as { env: Record<string, string> }).env;
        expect(unscoped.ANTHROPIC_API_KEY).toBe("sk-metered");
        expect(unscoped.ANTHROPIC_AUTH_TOKEN).toBe("oauth-token");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
      }
    });

    it("falls back to agentHome() when the resolver has no account to name", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      // A reserved route (API key / env OAuth) has no account root.
      const claude = new ClaudeProcess(() => undefined);
      claude.run({ prompt: "test" });

      const spawnOpts = mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> };
      expect(spawnOpts.env.HOME).toBe(agentHome());
    });

    it("maps guarded mode to --permission-mode auto (docs/138)", () => {
      // Deliberate inversion: ShipIt `guarded` → CLI `auto` (classifier-gated).
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "guarded" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("auto");
    });

    it("maps plan mode to --permission-mode plan", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "plan" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const idx = args.indexOf("--permission-mode");
      expect(args[idx + 1]).toBe("plan");
    });

    it("passes no --permission-mode flag for auto mode", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "auto" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--permission-mode");
    });

    it("keeps the full AUTO_TOOLS allowlist for guarded mode", () => {
      // Guarded reuses AUTO_TOOLS — the CLI classifier (not the allowlist)
      // gates Bash/network. Bash must still be present in the allowlist.
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: "guarded" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools).toContain("Bash");
      expect(tools).toContain("Write");
    });

    it("includes browser tools in allowed tools list", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const toolsIdx = args.indexOf("--allowedTools");
      const tools = args[toolsIdx + 1];
      expect(tools).toContain("mcp__playwright__");
    });

    // docs/149 / planning#130 — the worker-registered `shipit` MCP server isn't a
    // user-configured server, so its tools never flow through `mcpServerNames`.
    // They must be allowlisted explicitly by name or headless `-p` mode rejects
    // them as "permission not yet granted" — including from review subagents.
    // After planning#130 the named tools live under the single `shipit` server.
    // docs/220 — the `submit_review` tool was removed; it must NOT appear in the
    // allowlist any longer (cross-agent reviews surface in the consult card,
    // same-model reviews are prose).
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("does NOT allowlist the removed mcp__shipit__submit_review in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).not.toContain("mcp__shipit__submit_review");
    });

    // Same rationale: `present` must be allowlisted explicitly or headless `-p`
    // mode rejects it as "permission not yet granted".
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit__present in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit__present");
    });

    // docs/163: the built-in `voice_note` tool must be allowlisted in every mode
    // — including plan, so the agent can author a spoken headline before
    // ExitPlanMode.
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit__voice_note in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit__voice_note");
    });

    // docs/207 / planning#155: the built-in `propose_actions` tool (action-checklist
    // cards) must be allowlisted in every mode — it only posts a card and writes
    // ShipIt's own state, so it's safe under plan mode like the other internal
    // tools. Without the entry headless `-p` mode hangs on "permission not yet
    // granted" (the original planning#155 regression).
    it.each([
      ["auto" as const, undefined],
      ["plan" as const, "plan" as const],
      ["guarded" as const, "guarded" as const],
    ])("allowlists mcp__shipit__propose_actions in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("mcp__shipit__propose_actions");
    });

    // planning#130: the consolidated server's `permission_prompt` tool is the CLI's
    // --permission-prompt-tool and is deliberately NOT model-callable, so it must
    // NOT appear in the allowlist (we list the five model-facing tools by name
    // rather than a `mcp__shipit__*` glob to keep it out).
    it("does NOT allowlist mcp__shipit__permission_prompt", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).not.toContain("mcp__shipit__permission_prompt");
      expect(tools).not.toContain("mcp__shipit__*");
    });

    // docs/138: `Skill` must be allowlisted in every permission mode so an
    // explicit `/my-skill` invocation is honored even in headless `-p` mode
    // (no human to approve the prompt) and even in plan mode.
    it.each([
      ["auto", undefined],
      ["plan", "plan"],
    ] as const)("allowlists the Skill tool in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "/my-skill", permissionMode: permissionMode as any });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("Skill");
    });

    // The agent stalls in plan mode under live steering when `ExitPlanMode` is
    // gated behind a headless permission prompt the worker can't answer
    // (docs/149): the model never surfaces a clean ExitPlanMode tool_use, so
    // the PlanApproval card never becomes interactive and file edits stay
    // blocked. It must be allowlisted in every mode — especially plan, where it
    // matters most. ExitPlanMode is read-only/safe (it only signals plan
    // completion), so it's safe under plan mode too.
    it.each([
      ["auto", undefined],
      ["plan", "plan"],
      ["guarded", "guarded"],
    ] as const)("allowlists ExitPlanMode in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test", permissionMode: permissionMode as any });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("ExitPlanMode");
    });
  });

  describe("kill", () => {
    it("kills the running process", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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

    /**
     * planning#509 — an MCP server's descendants (a Playwright browser above
     * all) outlive a kill aimed at the CLI's pid alone, so teardown goes through
     * the tree helper. Which helper is the contract, not a detail.
     */
    it("tears down the whole process tree", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      claude.kill();

      expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(
        mockProc,
        "SIGTERM",
        expect.objectContaining({ label: "claude" }),
      );
    });
  });

  describe("error handling", () => {
    it("emits error event when spawn throws", () => {
      mockChildSpawn.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      claude.on("error", (err) => errors.push(err));

      claude.run({ prompt: "test" });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("spawn ENOENT");
    });

    it("surfaces an async exec failure as `error`, not a silent empty run", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      const events: unknown[] = [];
      claude.on("error", (err: Error) => errors.push(err));
      claude.on("event", (e) => events.push(e));

      claude.run({ prompt: "test" });
      // `child_process.spawn` reports a failed exec (E2BIG / ENOENT) here,
      // asynchronously — the PTY this replaced forked first, so the same
      // failure arrived as a line of child output and was mistaken for a log.
      const e2big = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
      mockProc.emit("error", e2big);
      mockProc.simulateExit(1);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("spawn E2BIG");
      expect(events).toHaveLength(0);
    });

    it("emits done with the process exit code", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const codes: number[] = [];
      claude.on("done", (code: number) => codes.push(code));

      claude.run({ prompt: "test" });
      mockProc.simulateExit(7);

      expect(codes).toEqual([7]);
    });

    it("surfaces an EPIPE on stdin as `error` instead of crashing the worker", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      const order: string[] = [];
      claude.on("error", (err: Error) => { errors.push(err); order.push("error"); });
      claude.on("done", () => order.push("done"));

      claude.run({ prompt: "test" });
      // The CLI died before draining the prompt. Node reports this on the
      // STREAM — an unhandled `error` here is an uncaught exception, i.e. the
      // whole session worker goes down.
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      expect(() => mockProc.stdin.emit("error", epipe)).not.toThrow();
      // Held until close, so the drains get to run first.
      expect(errors).toHaveLength(0);

      mockProc.simulateExit(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("write EPIPE");
      expect(order).toEqual(["error", "done"]);
    });

    it("lets auth recovery win the race when EPIPE and an auth failure arrive together", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      let authRequired = false;
      claude.on("error", (err: Error) => errors.push(err));
      claude.on("auth_required", () => { authRequired = true; });

      claude.run({ prompt: "x".repeat(200_000) });
      // The commonest cause of an early close is a failed auth. With a large
      // prompt still flushing, EPIPE beats the stderr line that explains it.
      mockProc.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      mockProc.simulateStderr("Error: Not logged in. Please run /login");
      mockProc.simulateExit(1);

      // `auth_required` owns what the user sees next — the quiet heal-and-retry
      // or the sign-in card. A generic process error on top would pre-empt it.
      expect(authRequired).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it("raises auth_required from a stderr line, now that stderr is its own stream", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      const logs: { source: string; text: string }[] = [];
      claude.on("auth_required", () => { authRequired = true; });
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });
      mockProc.simulateStderr("Error: Not logged in. Please run /login\n");

      expect(authRequired).toBe(true);
      expect(logs).toEqual([{ source: "stderr", text: "Error: Not logged in. Please run /login" }]);
    });

    it("reassembles a stderr line split across chunks before matching auth phrases", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      claude.on("auth_required", () => { authRequired = true; });

      claude.run({ prompt: "test" });
      // A pipe splits wherever it likes. Neither half matches a pattern on its
      // own — checking chunks instead of lines misses the auth failure entirely
      // and the turn dies as a generic error instead of healing credentials.
      mockProc.simulateStderr("Error: Not log");
      expect(authRequired).toBe(false);
      mockProc.simulateStderr("ged in. Please run /login\n");

      expect(authRequired).toBe(true);
    });

    it("flushes an unterminated final stderr line on close", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      let authRequired = false;
      const logs: { source: string; text: string }[] = [];
      claude.on("auth_required", () => { authRequired = true; });
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });
      // No trailing newline — the CLI's last line usually has none.
      mockProc.simulateStderr("Invalid API key");
      mockProc.simulateExit(1);

      expect(authRequired).toBe(true);
      expect(logs).toContainEqual({ source: "stderr", text: "Invalid API key" });
    });

    it("counts stderr as output for the inactivity watchdog", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });
      mockProc.simulateStderr("compiling…\n");
      vi.advanceTimersByTime(31_000);

      // The PTY merged the streams, so any output cleared the watchdog. A
      // "no output in 30 seconds" warning while the CLI is writing to stderr
      // sends whoever reads the logs after the wrong problem.
      expect(logs.some((l) => l.source === "server")).toBe(false);
    });
  });

  describe("interrupt", () => {
    it("signals SIGINT and force-kills if the process does not exit", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      claude.interrupt();

      expect(mockProc.kill).toHaveBeenCalledWith("SIGINT");

      vi.advanceTimersByTime(5000);
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("does not force-kill when the process exits within the grace period", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      claude.interrupt();
      mockProc.simulateExit(130);

      vi.advanceTimersByTime(5000);
      expect(mockProc.kill).toHaveBeenCalledTimes(1);
      expect(mockProc.kill).toHaveBeenCalledWith("SIGINT");
    });
  });

  describe("log emission", () => {
    it("emits log event for non-JSON lines in stdout", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      mockProc.simulateData("Some debug output\n");

      expect(logs).toHaveLength(1);
      expect(logs[0]).toEqual({ source: "stdout", text: "Some debug output" });
    });

    it("does not emit log for valid JSON lines", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const logs: { source: string; text: string }[] = [];
      claude.on("log", (source: string, text: string) => logs.push({ source, text }));

      claude.run({ prompt: "test" });

      const event = { type: "system", subtype: "init", session_id: "abc" };
      mockProc.simulateData(`${JSON.stringify(event)  }\n`);

      expect(logs).toHaveLength(0);
    });
  });

  describe("prompt delivery over stdin", () => {
    it("frames the prompt as a type:user NDJSON line and closes stdin", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "hello world" });

      expect(mockProc.stdinWrites).toHaveLength(1);
      const line = mockProc.stdinWrites[0] as string;
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line.trim())).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hello world" }] },
      });
      // The EOF is what makes the CLI finish the turn and exit — without it
      // this "one-shot" process would sit resident and never emit `done`.
      expect(mockProc.stdin.end).toHaveBeenCalled();
    });

    it("delivers a prompt far past the 128 KiB argv limit that used to fail exec", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      // 200 KB — comfortably past MAX_ARG_STRLEN (131,072), and past the
      // ~135 KB reviewer prompt that produced four silent empty successes.
      const huge = "x".repeat(200_000);
      const claude = new ClaudeProcess();
      const errors: Error[] = [];
      claude.on("error", (e: Error) => errors.push(e));
      claude.run({ prompt: huge });

      expect(errors).toHaveLength(0);
      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args.every((a) => a.length < 1000)).toBe(true);
      expect(JSON.parse((mockProc.stdinWrites[0] as string).trim()).message.content[0].text)
        .toHaveLength(200_000);
    });

    it("preserves special characters (quotes, newlines, unicode) via JSON escaping", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const prompt = 'say "hi"\nthen — 🎉 done\ttab';
      const claude = new ClaudeProcess();
      claude.run({ prompt });

      expect(JSON.parse((mockProc.stdinWrites[0] as string).trim()).message.content[0].text)
        .toBe(prompt);
    });

    it("drops a later writeStdin rather than throwing (stdin is closed by design)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      claude.run({ prompt: "test" });
      mockProc.stdin.writable = false;
      claude.writeStdin("answer text\n");

      expect(mockProc.stdinWrites).toHaveLength(1); // the prompt, nothing after
    });

    it("is a no-op if no process is running", () => {
      const claude = new ClaudeProcess();
      // Should not throw
      claude.writeStdin("test");
    });
  });

  describe("image support", () => {
    it("passes prompt through unchanged (images handled by orchestrator)", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const claude = new ClaudeProcess();
      const images = [{ data: "base64data", mediaType: "image/png" }];
      claude.run({ prompt: "describe this", images });

      expect(JSON.parse((mockProc.stdinWrites[0] as string).trim()).message.content[0].text)
        .toBe("describe this");
    });
  });

  describe("inactivity watchdog", () => {
    it("emits warning log after 30 seconds of no output", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

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

  // The streaming process is the live-steering path where the ExitPlanMode bug
  // actually bit: a gated ExitPlanMode left the session stranded in plan mode.
  // It must be in the allowlist in every mode, especially plan. See the
  // ClaudeProcess counterpart and docs/149 / docs/140 §6.8.
  describe("allowlist", () => {
    it.each([
      ["auto", undefined],
      ["plan", "plan"],
      ["guarded", "guarded"],
    ] as const)("allowlists ExitPlanMode in %s mode", (_label, permissionMode) => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "first", permissionMode: permissionMode as any });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      const tools = args[args.indexOf("--allowedTools") + 1];
      expect(tools.split(",")).toContain("ExitPlanMode");
    });
  });

  /** planning#509 — see the ClaudeProcess tree-teardown test. */
  it("tears down the whole process tree on kill", () => {
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);

    const streaming = new StreamingClaudeProcess();
    streaming.run({ prompt: "first" });
    streaming.kill();

    expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(
      mockProc,
      "SIGTERM",
      expect.objectContaining({ label: "streaming-claude" }),
    );
  });

  // docs/150 — same contract as ClaudeProcess: the resident streaming process
  // is what a live-steering local-mode session actually spawns.
  describe("account-scoped HOME", () => {
    it("uses agentHome() by default and the resolver's home when scoped", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);

      new StreamingClaudeProcess().run({ prompt: "first" });
      expect((mockChildSpawn.mock.calls[0][2] as { env: Record<string, string> }).env.HOME)
        .toBe(agentHome());

      const scoped = new StreamingClaudeProcess(() => "/credentials/provider-accounts/claude/acct-a");
      scoped.run({ prompt: "first" });
      expect((mockChildSpawn.mock.calls[1][2] as { env: Record<string, string> }).env.HOME)
        .toBe("/credentials/provider-accounts/claude/acct-a");
    });
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

  describe("stdin failure policy", () => {
    it("reports an EPIPE as a log without tearing down the resident session", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const streaming = new StreamingClaudeProcess();
      const errors: Error[] = [];
      const logs: { source: string; text: string }[] = [];
      streaming.on("error", (err: Error) => errors.push(err));
      streaming.on("log", (source: string, text: string) => logs.push({ source, text }));

      streaming.run({ prompt: "hello" });
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      // Unhandled, this is an uncaught exception that stops the whole worker.
      expect(() => mockProc.stdin.emit("error", epipe)).not.toThrow();

      // Log-only on purpose: this process is resident across turns, so one
      // dropped write must not end a session the user is still working in.
      expect(errors).toHaveLength(0);
      expect(logs.some((l) => l.source === "server" && l.text.includes("EPIPE"))).toBe(true);
    });

    it("passes the system prompt as a file here too", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as any);

      const streaming = new StreamingClaudeProcess();
      streaming.run({ prompt: "hi", systemPrompt: "a resident system prompt" });

      const args = mockChildSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--append-system-prompt");
      const path = args[args.indexOf("--append-system-prompt-file") + 1] as string;
      expect(readFileSync(path, "utf-8")).toBe("a resident system prompt");

      mockProc.emit("close", 0);
      expect(existsSync(path)).toBe(false);
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

describe("service routing (docs/252 phase 3)", () => {
  const routing: ServiceRouting = {
    serviceId: "deepseek",
    serviceName: "DeepSeek",
    billingMode: "key",
    style: "anthropic-messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    credentialSourceEnv: "DEEPSEEK_API_KEY",
    credentialTarget: { kind: "env", name: "ANTHROPIC_API_KEY" },
  };

  it("materializes the service's secret into the harness's own variable", () => {
    const env: Record<string, string> = { DEEPSEEK_API_KEY: "sk-ds" };
    expect(applyServiceRouting(env, routing)).toEqual({ credentialDelivered: true });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ds");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
  });

  it("clears EVERY Anthropic credential variable before setting one", () => {
    // `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not interchangeable at
    // the wire (an `x-api-key` header versus a bearer token) and the CLI prefers
    // the key, so a stale one left behind is how a GLM turn would authenticate
    // with an Anthropic key against GLM's endpoint.
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "tok-ant",
      ZAI_CODING_PLAN_KEY: "sk-zai",
    };
    applyServiceRouting(env, {
      ...routing,
      serviceId: "zai",
      credentialSourceEnv: "ZAI_CODING_PLAN_KEY",
      credentialTarget: { kind: "env", name: "ANTHROPIC_AUTH_TOKEN" },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-zai");
  });

  it("reports a missing secret rather than falling back to whatever was there", () => {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-ant" };
    expect(applyServiceRouting(env, routing)).toEqual({ credentialDelivered: false });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses to spawn a redirected turn with no credential, as Codex does", () => {
    // Spawning anyway turns ShipIt's structured `auth_required` into a raw
    // provider 401 the user has to interpret. Reachable when a credential
    // write's secrets push failed or timed out (both fail open) between the
    // pick and the turn.
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);
    mockChildSpawn.mockClear();
    delete process.env.DEEPSEEK_API_KEY;
    const proc = new ClaudeProcess();
    const authRequired = vi.fn();
    proc.on("auth_required", authRequired);
    proc.run({ prompt: "hi", cwd: "/workspace", serviceRouting: routing });
    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(mockChildSpawn).not.toHaveBeenCalled();
  });

  it("is a no-op when there is nothing to shape", () => {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-ant" };
    applyServiceRouting(env, undefined);
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
  });

  // docs/105 — a redirected provider may report per-call token usage ONLY in
  // the raw `message_delta` frame (Z.ai/GLM does, and also sends an empty
  // `result.usage.iterations`), and without a per-call reading the context dial
  // sums the turn's billing totals: 2.1M against a 1M window. The frames are
  // one event per token chunk, so the first-party spawn — which gets real
  // iterations — must not pay for them.
  describe("--include-partial-messages", () => {
    const spawnArgs = (): string[] => mockChildSpawn.mock.calls[0][1] as string[];

    it("is passed on a routed one-shot spawn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);
      mockChildSpawn.mockClear();
      process.env.DEEPSEEK_API_KEY = "sk-ds";
      try {
        new ClaudeProcess().run({ prompt: "hi", cwd: "/workspace", serviceRouting: routing });
        expect(spawnArgs()).toContain("--include-partial-messages");
      } finally {
        delete process.env.DEEPSEEK_API_KEY;
      }
    });

    it("is passed on a routed resident streaming spawn", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);
      mockChildSpawn.mockClear();
      process.env.DEEPSEEK_API_KEY = "sk-ds";
      try {
        new StreamingClaudeProcess().run({ prompt: "hi", cwd: "/workspace", serviceRouting: routing });
        expect(spawnArgs()).toContain("--include-partial-messages");
      } finally {
        delete process.env.DEEPSEEK_API_KEY;
      }
    });

    it("is omitted on an unrouted spawn, which keeps its argv unchanged", () => {
      const mockProc = createMockChildProcess();
      mockChildSpawn.mockReturnValue(mockProc as never);
      mockChildSpawn.mockClear();
      new ClaudeProcess().run({ prompt: "hi", cwd: "/workspace" });
      expect(spawnArgs()).not.toContain("--include-partial-messages");
    });
  });

  it("runs AFTER the scoped-home scrub at the real spawn site, not before", () => {
    // The ordering is load-bearing, not incidental: the scrub deletes the very
    // variables the shaping writes, so shaping first would produce a spawn with
    // an endpoint and no credential — a redirected turn that 401s. Driven
    // through the real spawn rather than the helper so it pins the CALL ORDER.
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    mockChildSpawn.mockClear();
    try {
      const proc = new ClaudeProcess(() => "/credentials/provider-accounts/claude/acct_1");
      proc.run({ prompt: "hi", cwd: "/workspace", serviceRouting: routing });
      const env = mockChildSpawn.mock.calls[0][2]?.env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ds");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

/**
 * 2026-08-21 incident — a SAME-harness sub-agent spawn is pointed at an
 * isolated per-spawn HOME (`AgentRunParams.homeDir`) so its credentials never
 * displace the session subtree the live primary CLI re-reads mid-turn.
 */
describe("per-spawn homeDir (same-harness sub-agent isolation)", () => {
  const spawnEnv = (): Record<string, string> =>
    mockChildSpawn.mock.calls[0][2]?.env as Record<string, string>;

  it("points the one-shot CLI's HOME at the isolated root", () => {
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);
    mockChildSpawn.mockClear();
    new ClaudeProcess().run({
      prompt: "hi",
      cwd: "/workspace",
      homeDir: "/credentials/sub-agent-homes/spawn-1",
    });
    expect(spawnEnv().HOME).toBe("/credentials/sub-agent-homes/spawn-1");
  });

  it("outranks the constructor resolver and scrubs ambient env credentials", () => {
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);
    mockChildSpawn.mockClear();
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    try {
      const proc = new ClaudeProcess(() => "/credentials/provider-accounts/claude/acct_1");
      proc.run({
        prompt: "hi",
        cwd: "/workspace",
        homeDir: "/credentials/sub-agent-homes/spawn-2",
      });
      const env = spawnEnv();
      expect(env.HOME).toBe("/credentials/sub-agent-homes/spawn-2");
      // The isolated home is a scoped home: an ambient key must not out-prefer
      // the on-disk login provisioned into it (docs/150's scrub rule).
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("keeps the resident streaming path on the resolver when no homeDir is given", () => {
    const mockProc = createMockChildProcess();
    mockChildSpawn.mockReturnValue(mockProc as never);
    mockChildSpawn.mockClear();
    const proc = new StreamingClaudeProcess(() => "/scoped/home");
    proc.run({ prompt: "hi", cwd: "/workspace" });
    expect(spawnEnv().HOME).toBe("/scoped/home");
  });
});
