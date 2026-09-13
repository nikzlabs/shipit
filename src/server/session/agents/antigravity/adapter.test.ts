import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAdapter } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

interface FakeProc extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
}

function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  return proc;
}

const PROBES = path.join(
  new URL("../../../../../docs/301-antigravity-harness/probes/", import.meta.url).pathname,
);

describe("AntigravityAdapter", () => {
  let tmp: string;
  let cwd: string;
  let home: string;
  let spawned: { cmd: string; args: string[]; opts: SpawnOptions }[];
  let proc: FakeProc;
  let adapter: AntigravityAdapter;
  let events: AgentEvent[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-adapter-"));
    cwd = path.join(tmp, "workspace");
    home = path.join(tmp, "home");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    spawned = [];
    proc = makeProc();
    events = [];
    adapter = new AntigravityAdapter({
      resolveHome: () => home,
      spawnFn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        return proc as unknown as ChildProcess;
      },
    });
    adapter.on("event", (e) => events.push(e));
    adapter.on("error", () => { /* asserted per test */ });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(overrides: Partial<AgentRunParams> = {}): void {
    adapter.run({ prompt: "do the thing", cwd, ...overrides });
  }

  function feed(lines: string[]): void {
    for (const line of lines) proc.stdout.write(`${line}\n`);
  }

  /** Node's real order: `exit` carries the code, `close` follows once pipes drain. */
  function close(code: number | null): void {
    proc.emit("exit", code, code === null ? "SIGTERM" : null);
    proc.emit("close", code);
  }

  const RESULT_OK = JSON.stringify({
    event: "result",
    result: { conversation_id: "conv-1", status: "SUCCESS", response: "done", duration_seconds: 1.5 },
  });

  function step(update: Record<string, unknown>): string {
    return JSON.stringify({ event: "step_update", step_update: update });
  }

  const INIT = JSON.stringify({
    event: "init",
    conversation_id: "conv-1",
    init: { model: "gemini-3.8-flash", tools: ["view_file"], permission_mode: "always-proceed" },
  });

  describe("the spawn", () => {
    it("delivers the prompt on stdin and closes it, never on argv", () => {
      const written: string[] = [];
      proc.stdin.on("data", (c: Buffer) => written.push(c.toString("utf8")));
      run({ prompt: "a".repeat(200_000) });
      expect(spawned[0].args.join(" ")).not.toContain("aaaa");
      expect(JSON.parse(written.join("").trim())).toEqual({
        event: "user",
        message: { content: "a".repeat(200_000) },
      });
    });

    it("translates the catalogue model id to the CLI's, and always sends an effort", () => {
      run({ model: "gemini-3.1-pro-preview", reasoningEffort: "low" });
      const args = spawned[0].args;
      expect(args).toContain("gemini-3.1-pro");
      expect(args).not.toContain("gemini-3.1-pro-preview");
      expect(args[args.indexOf("--effort") + 1]).toBe("low");
    });

    // The CLI refuses a base model id with no level, so an unset effort cannot
    // simply be omitted.
    it("falls back to an effort every offered model accepts", () => {
      run({ model: "gemini-3.8-flash" });
      expect(spawned[0].args[spawned[0].args.indexOf("--effort") + 1]).toBe("high");
    });

    it("omits the model flags entirely when no model was selected", () => {
      run();
      expect(spawned[0].args).not.toContain("--model");
      expect(spawned[0].args).not.toContain("--effort");
    });

    it("resumes by conversation id when the session has one", () => {
      run({ sessionId: "conv-9" });
      expect(spawned[0].args[spawned[0].args.indexOf("--conversation") + 1]).toBe("conv-9");
    });

    it("runs full-auto, since that is the only mode this harness offers", () => {
      run();
      expect(spawned[0].args).toContain("--dangerously-skip-permissions");
    });

    /**
     * Measured on a WRITABLE install so mode bits could not be doing the work:
     * `=true` keeps the pinned binary, `=1` lets the updater replace it with no
     * error anywhere. The read-only install cannot cover root, so this does.
     */
    it("disables the CLI's auto-updater with the value that actually works", () => {
      run();
      expect((spawned[0].opts.env as Record<string, string>).AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    });
  });

  describe("the per-spawn home", () => {
    it("links the durable directory back so conversations and the token survive", () => {
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      expect(spawnHome).not.toBe(home);
      expect(fs.realpathSync(path.join(spawnHome, ".gemini", "antigravity-cli")))
        .toBe(fs.realpathSync(path.join(home, ".gemini", "antigravity-cli")));
    });

    it("carries the system prompt and the repository's own instructions as the plugin rule", () => {
      fs.writeFileSync(path.join(cwd, "AGENTS.md"), "REPO-RULE-TEXT");
      run({ systemPrompt: "SHIPIT-PROMPT-TEXT" });
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      const rules = fs.readFileSync(
        path.join(spawnHome, ".gemini/config/plugins/shipit/rules/AGENTS.md"),
        "utf8",
      );
      expect(rules).toContain("SHIPIT-PROMPT-TEXT");
      expect(rules).toContain("REPO-RULE-TEXT");
      expect(rules).toContain("AGENTS.md");
    });

    it("takes only the first repository instruction file that exists", () => {
      fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "CLAUDE-TEXT");
      fs.writeFileSync(path.join(cwd, "GEMINI.md"), "GEMINI-TEXT");
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      const rules = fs.readFileSync(
        path.join(spawnHome, ".gemini/config/plugins/shipit/rules/AGENTS.md"),
        "utf8",
      );
      expect(rules).toContain("CLAUDE-TEXT");
      expect(rules).not.toContain("GEMINI-TEXT");
    });

    // docs/209 — the CLI reads no workspace skills, so the plugin is the only path.
    it("discloses the repository's skills as symlinks the CLI can follow", () => {
      fs.mkdirSync(path.join(cwd, ".claude/skills/my-skill"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".claude/skills/my-skill/SKILL.md"), "---\nname: my-skill\n---\n");
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      const linked = path.join(spawnHome, ".gemini/config/plugins/shipit/skills/my-skill");
      expect(fs.realpathSync(linked)).toBe(fs.realpathSync(path.join(cwd, ".claude/skills/my-skill")));
    });

    it("writes no import manifest, because a malformed one suppresses the plugin", () => {
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      expect(fs.existsSync(path.join(spawnHome, ".gemini/config/import_manifest.json"))).toBe(false);
      expect(fs.existsSync(path.join(spawnHome, ".gemini/config/plugins/shipit/plugin.json"))).toBe(true);
    });

    it("removes the throwaway home when the turn ends", () => {
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      expect(fs.existsSync(spawnHome)).toBe(true);
      close(0);
      expect(fs.existsSync(spawnHome)).toBe(false);
    });

    it("selects the gemini provider only while a key is the credential", () => {
      process.env.GEMINI_API_KEY = "k";
      try {
        run();
      } finally {
        delete process.env.GEMINI_API_KEY;
      }
      const settings = path.join(home, ".gemini/antigravity-cli/settings.json");
      expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({ modelProvider: "gemini" });

      fs.writeFileSync(path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token"), "{}");
      close(0);
      run();
      expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({});
    });
  });

  describe("event mapping", () => {
    it("reports the conversation id from init so the next turn can resume it", () => {
      run();
      feed([INIT]);
      expect(events[0]).toMatchObject({ type: "agent_init", agentId: "antigravity", sessionId: "conv-1" });
    });

    // The CLI echoes its OWN id, which the catalogue does not carry — reporting
    // it loses Pro's 1,048,576-token window to a 200k default.
    it("reports the catalogue model id, not the CLI's translated one", () => {
      run({ model: "gemini-3.1-pro-preview", reasoningEffort: "high" });
      feed([JSON.stringify({
        event: "init", conversation_id: "c", init: { model: "gemini-3.1-pro" },
      })]);
      expect(events[0]).toMatchObject({ type: "agent_init", model: "gemini-3.1-pro-preview" });
    });

    it("streams assistant text deltas", () => {
      run();
      feed([step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hel" })]);
      feed([step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "lo" })]);
      expect(events).toEqual([
        { type: "agent_assistant", content: [{ type: "text", text: "hel" }] },
        { type: "agent_assistant", content: [{ type: "text", text: "lo" }] },
      ]);
    });

    it("pairs a tool step's ACTIVE call with its DONE result", () => {
      run();
      feed([step({
        step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "view_file",
        tool_info: { name: "view_file", parameters: { AbsolutePath: "/workspace/a.ts" } },
      })]);
      feed([step({
        step_index: 2, state: "DONE", step_type: "tool", tool_name: "view_file",
        tool_info: { name: "view_file", output: "12 lines" },
      })]);
      const call = events[0] as { content: { id: string; name: string; input: Record<string, unknown> }[] };
      expect(call.content[0].name).toBe("Read");
      expect(call.content[0].input).toEqual({ file_path: "/workspace/a.ts" });
      const result = events[1] as unknown as { content: { tool_use_id: string; content: string }[] };
      expect(result.content[0].tool_use_id).toBe(call.content[0].id);
      expect(result.content[0].content).toBe("12 lines");
    });

    // Google's "subagents stopped due to server restart" notice opens every
    // resumed print turn and describes the spawn, not the turn.
    it("drops the resume notice and the textless error step", () => {
      run();
      feed([
        step({ step_index: 0, state: "DONE", step_type: "system_message" }),
        step({ step_index: 1, state: "DONE", step_type: "error_message" }),
        step({ step_index: 2, state: "DONE", step_type: "user_input" }),
      ]);
      expect(events).toEqual([]);
    });
  });

  describe("the turn's outcome", () => {
    it("succeeds only when the process exited zero AND a result arrived", () => {
      run({ sessionId: "conv-1" });
      feed([INIT, step({
        step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "done",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, total_tokens: 120 },
      }), RESULT_OK]);
      close(0);
      const result = events.at(-1) as { type: string; status: string; tokens?: unknown; contextTokens?: number };
      expect(result.type).toBe("agent_result");
      expect(result.status).toBe("success");
      expect(result.tokens).toEqual({ input: 100, output: 20, cacheRead: 900 });
      expect(result.contextTokens).toBe(1000);
    });

    // Partial text must never imply success: a truncated stream is an error turn
    // by construction.
    it("fails a turn whose stream ended without a result, whatever text preceded it", () => {
      run();
      feed([INIT, step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "half an ans" })]);
      close(0);
      const result = events.at(-1) as { type: string; status: string; error?: string };
      expect(result.type).toBe("agent_result");
      expect(result.status).toBe("error");
      expect(result.error).toContain("without a result");
    });

    // req 4 — the sentence Google printed, not ShipIt's generic copy.
    it("takes the error text from this process's stderr, verbatim", () => {
      run();
      proc.stderr.write(
        "error: Eligibility check failed: Your current account is not eligible for Antigravity.\n",
      );
      feed([JSON.stringify({
        event: "result",
        result: { status: "ERROR", response: "", error: "something else entirely" },
      })]);
      close(1);
      const result = events.at(-1) as { status: string; error: string };
      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "Eligibility check failed: Your current account is not eligible for Antigravity.",
      );
    });

    // plugin-mcp.ndjson: a 503 the CLI retried leaves status ERROR beside a
    // complete answer and exit 0. compact-c.ndjson: a resumed turn repeats the
    // PREVIOUS turn's error. Neither is this turn's outcome.
    it("ignores a result envelope that describes the conversation, not the turn", () => {
      for (const name of ["plugin-mcp.ndjson", "compact-c.ndjson"]) {
        const fresh = new AntigravityAdapter({
          resolveHome: () => home,
          spawnFn: () => { proc = makeProc(); return proc as unknown as ChildProcess; },
        });
        const seen: AgentEvent[] = [];
        fresh.on("event", (e) => seen.push(e));
        fresh.on("error", () => { /* ignored */ });
        fresh.run({ prompt: "x", cwd });
        proc.stdout.write(fs.readFileSync(path.join(PROBES, name), "utf8"));
        proc.emit("exit", 0, null);
        proc.emit("close", 0);
        const result = seen.at(-1) as { type: string; status: string; error?: string };
        expect(result.type, name).toBe("agent_result");
        expect(result.status, name).toBe("success");
        expect(result.error, name).toBeUndefined();
      }
    });

    /**
     * An MCP server (or a browser under one) inherits stdout, so `close` can stay
     * pending forever after the CLI itself has exited — and killProcessTree
     * cannot reach a descendant of an already-exited handle. Settling on `close`
     * alone stranded the turn with no result and no `done`.
     */
    it("settles on exit when a descendant keeps the output open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const done: number[] = [];
      adapter.on("done", (c) => done.push(c));
      run();
      feed([INIT, RESULT_OK]);
      proc.emit("exit", 0, null); // no "close": a descendant still holds the pipes
      await vi.advanceTimersByTimeAsync(3_000);
      const result = events.at(-1) as { type: string; status: string };
      expect(result.type).toBe("agent_result");
      expect(result.status).toBe("success");
      expect(done).toEqual([0]);
    });

    it("settles exactly once when close arrives after exit", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const done: number[] = [];
      adapter.on("done", (c) => done.push(c));
      run();
      feed([INIT, RESULT_OK]);
      close(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events.filter((e) => e.type === "agent_result")).toHaveLength(1);
      expect(done).toEqual([0]);
    });

    /**
     * Reaping establishes who sent the signal, not whether the turn worked: a
     * refusal delivers an error envelope and can still sit there until the grace
     * expires. Calling that a success dropped Google's sentence (req 4).
     */
    it("does not call a reaped turn successful when its envelope reported an error", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      run();
      feed([INIT, JSON.stringify({
        event: "result",
        result: { status: "ERROR", response: "", error: "Eligibility check failed: not eligible." },
      })]);
      // The process never exits; the reap fires and signals it.
      await vi.advanceTimersByTimeAsync(6_000);
      proc.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(3_000);
      const result = events.at(-1) as { status: string; error?: string };
      expect(result.status).toBe("error");
      expect(result.error).toBe("Eligibility check failed: not eligible.");
    });

    it("keeps a reaped turn successful when its envelope reported success", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      run();
      feed([INIT, RESULT_OK]);
      await vi.advanceTimersByTimeAsync(6_000);
      proc.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(3_000);
      expect((events.at(-1) as { status: string }).status).toBe("success");
    });

    it("stays silent only for an interrupt ShipIt asked for", () => {
      run();
      feed([INIT]);
      adapter.interrupt();
      close(null);
      expect(events.filter((e) => e.type === "agent_result")).toEqual([]);
    });

    // The adapter SIGTERMs the process 5s after a result to reap MCP children.
    // Treating that signal as an interrupt threw away the finished turn.
    it("keeps the turn when it reaped the process itself after the result", async () => {
      // The grace timer must be registered on the fake clock, so install it first.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      run();
      feed([INIT, step({
        step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "done",
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      }), RESULT_OK]);
      // Drain the stream, then fire the grace timer that reaps the process.
      await vi.advanceTimersByTimeAsync(6_000);
      close(null);
      const result = events.at(-1) as { type: string; status: string; tokens?: unknown };
      expect(result.type).toBe("agent_result");
      expect(result.status).toBe("success");
      expect(result.tokens).toEqual({ input: 7, output: 3, cacheRead: 0 });
    });

    // An OOM kill is a signal nobody asked for, and the user must be told.
    it("reports an error when the process was killed mid-turn by something else", () => {
      run();
      feed([INIT, step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "half" })]);
      close(null);
      const result = events.at(-1) as { type: string; status: string; error?: string };
      expect(result.type).toBe("agent_result");
      expect(result.status).toBe("error");
    });

    // The pinned 1.1.27 writes NOTHING to stderr under stream-json: the refusal
    // text is only in the result envelope, which is why the fallback exists.
    it("falls back to the result envelope's error when stderr carried none", () => {
      run();
      feed([JSON.stringify({
        event: "result",
        result: { status: "ERROR", response: "", error: "Eligibility check failed: not eligible." },
      })]);
      close(1);
      const result = events.at(-1) as { status: string; error: string };
      expect(result.status).toBe("error");
      expect(result.error).toBe("Eligibility check failed: not eligible.");
    });
  });

  describe("capabilities it does not have", () => {
    it("refuses a compaction request instead of sending /compact as a prompt", () => {
      const errors: Error[] = [];
      adapter.removeAllListeners("error");
      adapter.on("error", (e) => errors.push(e));
      adapter.run({ prompt: "/compact", cwd, compact: true });
      expect(spawned).toEqual([]);
      expect(errors[0].message).toContain("no compaction");
    });

    // A large prompt is written in chunks; if the CLI dies during startup the
    // EPIPE arrives asynchronously and an unhandled stream error kills the worker.
    it("survives the CLI closing stdin while the prompt is still being written", () => {
      run({ prompt: "x".repeat(100_000) });
      expect(() => proc.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
    });

    it("reports a dropped steer rather than silently losing it", () => {
      const errors: Error[] = [];
      adapter.removeAllListeners("error");
      adapter.on("error", (e) => errors.push(e));
      adapter.sendUserMessage("mid-turn");
      expect(errors[0].message).toContain("does not support live steering");
    });
  });

  describe("MCP", () => {
    it("bundles Playwright, the ShipIt bridge and the user's servers into the plugin", () => {
      adapter.writeMcpConfig({
        servers: [{ name: "mine", command: "node", args: ["s.js"] } as never],
        shipitBridge: { tsxBin: "/bin/tsx", bridgePath: "/b.ts" },
        onServerFailed: () => { /* none expected */ },
      });
      run();
      const spawnHome = (spawned[0].opts.env as Record<string, string>).HOME;
      const config = JSON.parse(fs.readFileSync(
        path.join(spawnHome, ".gemini/config/plugins/shipit/mcp_config.json"), "utf8",
      )) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(config.mcpServers).sort()).toEqual(["mine", "playwright", "shipit"]);
    });
  });
});
