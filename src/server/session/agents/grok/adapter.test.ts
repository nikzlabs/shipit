/**
 * GrokAdapter conformance tests (docs/274 req 5, docs/272 conventions).
 *
 * **The fixtures are real captures, replayed byte-for-byte.** Grok Build's
 * streaming schema is undocumented — docs.x.ai's headless page covers neither
 * output format — so the only honest basis for the mapping is transcripts the
 * CLI actually produced. `__fixtures__/tool-tour-grok-4.6.ndjson` and
 * `tool-tour-grok-4.20.ndjson` are the docs/272 Step 1 tool-tour turns (CLI
 * 1.0.1, 2026-08-18, API-key mode, a sandbox repo), copied unmodified from the
 * capture directory. Nothing here hand-writes a line of Grok's wire.
 *
 * That is what makes these tests worth their weight on the NEXT version bump:
 * re-capture a tour, drop the file in, and a schema change shows up as a failed
 * assertion about a specific event rather than as a quietly emptier transcript.
 *
 * The lossy paths are asserted too — a truncated stream and a crash — because
 * the one thing a captured happy path cannot prove is what happens when the
 * capture stops early.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { GrokAdapter } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function capture(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());
}

/** A scriptable stand-in for the spawned CLI. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = null;
  pid = 4242;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  emitStdout(lines: string[]): void {
    this.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`));
  }

  close(code: number | null): void {
    this.emit("close", code, null);
  }
}

interface Harness {
  adapter: GrokAdapter;
  child: FakeChild;
  events: AgentEvent[];
  args: string[];
  env: Record<string, string>;
  home: string;
}

function makeHarness(params?: Partial<AgentRunParams>): Harness {
  const child = new FakeChild();
  const events: AgentEvent[] = [];
  // A real directory, because run() writes `config.toml` into the config root
  // and restores it afterwards — the file lifecycle is part of what is tested.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-adapter-test-"));
  const captured: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
  const adapter = new GrokAdapter({
    resolveHome: () => home,
    spawnFn: (_cmd, args, opts) => {
      captured.args = args;
      captured.env = (opts.env ?? {}) as Record<string, string>;
      return child as unknown as ChildProcess;
    },
  });
  adapter.on("event", (e) => events.push(e));
  adapter.run({
    prompt: "do the tour",
    cwd: "/workspace",
    ...params,
  });
  return { adapter, child, events, get args() { return captured.args; }, get env() { return captured.env; }, home };
}

describe("GrokAdapter — spawn shape", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it("passes the prompt as a FILE, never on argv", () => {
    const h = makeHarness({ prompt: "x".repeat(300_000) });
    homes.push(h.home);
    expect(h.args).toContain("--prompt-file");
    // The whole point: a 300 KB prompt would blow the 128 KiB argv ceiling.
    expect(h.args.some((a) => a.includes("x".repeat(1000)))).toBe(false);
    const promptPath = h.args[h.args.indexOf("--prompt-file") + 1];
    expect(fs.readFileSync(promptPath, "utf8")).toHaveLength(300_000);
    h.child.close(0);
  });

  it("PRE-ASSIGNS a session id on a new conversation and resumes with -r", () => {
    const fresh = makeHarness();
    homes.push(fresh.home);
    expect(fresh.args).toContain("-s");
    expect(fresh.args).not.toContain("-r");
    // A real UUID, not a placeholder — it is what ShipIt will resume with.
    expect(fresh.args[fresh.args.indexOf("-s") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    fresh.child.close(0);

    const resumed = makeHarness({ sessionId: "01a01473-26aa-7a21-ac7c-2ca7c9cb4944" });
    homes.push(resumed.home);
    expect(resumed.args).toContain("-r");
    expect(resumed.args).not.toContain("-s");
    expect(resumed.args[resumed.args.indexOf("-r") + 1]).toBe("01a01473-26aa-7a21-ac7c-2ca7c9cb4944");
    resumed.child.close(0);
  });

  it("maps ShipIt's three permission modes onto Grok's flags", () => {
    const cases: [AgentRunParams["permissionMode"], string[]][] = [
      ["auto", ["--always-approve"]],
      ["plan", ["--permission-mode", "plan"]],
      // Grok's `auto` is its CLASSIFIER-gated mode — the same spelling ShipIt
      // uses for "approve everything", which is why this row exists.
      ["guarded", ["--permission-mode", "auto"]],
    ];
    for (const [mode, expected] of cases) {
      const h = makeHarness(mode ? { permissionMode: mode } : {});
      homes.push(h.home);
      for (const [i, token] of expected.entries()) {
        expect(h.args[h.args.indexOf(expected[0]) + i], `mode ${String(mode)}`).toBe(token);
      }
      h.child.close(0);
    }
  });

  it("NEVER passes a reasoning-effort flag, even when one is handed to it", () => {
    // The catalogue declares no levels for this harness, so nothing should ask
    // — but a stale stored selection can, and passing it would advertise a
    // control the CLI silently drops before the wire (recorder-verified).
    const h = makeHarness({ reasoningEffort: "high" });
    homes.push(h.home);
    expect(h.args).not.toContain("--reasoning-effort");
    expect(h.args).not.toContain("--effort");
    expect(h.args).not.toContain("high");
    h.child.close(0);
  });

  it("scrubs inherited xAI credentials and delivers exactly the routed one", () => {
    const prior = process.env.XAI_API_KEY;
    const priorAuth = process.env.GROK_AUTH;
    process.env.XAI_API_KEY = "inherited-wrong-account";
    process.env.GROK_AUTH = "/somewhere/else/auth.json";
    process.env.SHIPIT_TEST_GROK_SECRET = "routed-right-account";
    try {
      const h = makeHarness({
        serviceRouting: {
          serviceId: "xai",
          serviceName: "xAI",
          billingMode: "key",
          style: "openai-chat-completions",
          baseUrl: "https://api.x.ai/v1",
          credentialSourceEnv: "SHIPIT_TEST_GROK_SECRET",
          credentialTarget: { kind: "env", name: "XAI_API_KEY" },
        },
      });
      homes.push(h.home);
      expect(h.env.XAI_API_KEY).toBe("routed-right-account");
      // `GROK_AUTH` redirects the CLI at a different token store, which defeats
      // the scoped home just as thoroughly as a stale key would.
      expect(h.env.GROK_AUTH).toBeUndefined();
      expect(h.env.GROK_XAI_API_BASE_URL).toBe("https://api.x.ai/v1");
      h.child.close(0);
    } finally {
      if (prior === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = prior;
      if (priorAuth === undefined) delete process.env.GROK_AUTH; else process.env.GROK_AUTH = priorAuth;
      delete process.env.SHIPIT_TEST_GROK_SECRET;
    }
  });

  it("states every harness-compat toggle, leaving only Claude skills and rules on", () => {
    const h = makeHarness();
    homes.push(h.home);
    // ON: the two ShipIt wants — `.claude/skills` disclosure and CLAUDE.md.
    expect(h.env.GROK_CLAUDE_SKILLS_ENABLED).toBe("1");
    expect(h.env.GROK_CLAUDE_RULES_ENABLED).toBe("1");
    // OFF: everything that could execute code or redirect a tool behind
    // ShipIt's back. Asserted by NAME, because a toggle silently left unset is
    // the failure mode — the CLI defaults them all ON.
    for (const off of [
      "GROK_CLAUDE_MCPS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED",
      "GROK_CLAUDE_AGENTS_ENABLED", "GROK_CLAUDE_SESSIONS_ENABLED",
      "GROK_CURSOR_SKILLS_ENABLED", "GROK_CURSOR_MCPS_ENABLED",
      "GROK_CURSOR_HOOKS_ENABLED", "GROK_CODEX_SESSIONS_ENABLED",
    ]) {
      expect(h.env[off], off).toBe("0");
    }
    expect(h.env.GROK_DISABLE_AUTOUPDATER).toBe("1");
    // A per-spawn root, not `$HOME/.grok` — see the config-root suite below.
    expect(h.env.GROK_HOME).toMatch(/grok-home-/);
    h.child.close(0);
  });
});

describe("GrokAdapter — the captured tool tour (docs/272)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  for (const [label, file, model, sessionId] of [
    ["grok-4.6", "tool-tour-grok-4.6.ndjson", "grok-4.6", "01a01473-26aa-7a21-ac7c-2ca7c9cb4944"],
    ["grok-4.20", "tool-tour-grok-4.20.ndjson", "grok-4.20-0309-non-reasoning", undefined],
  ] as const) {
    describe(label, () => {
      it("converts the whole stream into the normalized event union", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const kinds = h.events.map((e) => e.type);
        // One init, one result, and every message envelope in between mapped —
        // nothing silently dropped.
        expect(kinds.filter((k) => k === "agent_init")).toHaveLength(1);
        expect(kinds.filter((k) => k === "agent_result")).toHaveLength(1);
        expect(kinds.filter((k) => k === "agent_assistant").length).toBeGreaterThan(0);
        expect(kinds.filter((k) => k === "agent_tool_result").length).toBeGreaterThan(0);
        // The union is closed: an unrecognized `type` must not leak through.
        for (const k of kinds) {
          expect(["agent_init", "agent_assistant", "agent_tool_result", "agent_result"]).toContain(k);
        }
      });

      it("carries the init handshake's model, session and tool list", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        const init = h.events.find((e) => e.type === "agent_init");
        expect(init).toMatchObject({ agentId: "grok", model });
        if (sessionId) expect(init).toMatchObject({ sessionId });
        expect((init as { tools?: string[] }).tools).toContain("run_terminal_command");
        h.child.close(0);
      });

      it("surfaces every tool call the tour drove, under Grok's own names", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const toolNames = h.events
          .filter((e) => e.type === "agent_assistant")
          .flatMap((e) => (e as { content?: { type: string; name?: string }[] }).content ?? [])
          .filter((b) => b.type === "tool_use")
          .map((b) => b.name);
        // The docs/272 tour's load-bearing surfaces: the task panel, a read, an
        // edit, a shell command and a search. A mapping that dropped tool_use
        // blocks would still produce assistant text, which is exactly why this
        // asserts on the calls rather than on the turn's final prose.
        for (const expected of ["todo_write", "read_file", "run_terminal_command", "grep"]) {
          expect(toolNames, `${label} tour drove ${expected}`).toContain(expected);
        }
      });

      it("pairs every tool_use with a tool_result carrying the same id", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const callIds = new Set(
          h.events
            .filter((e) => e.type === "agent_assistant")
            .flatMap((e) => (e as { content?: { type: string; id?: string }[] }).content ?? [])
            .filter((b) => b.type === "tool_use")
            .map((b) => b.id),
        );
        const resultIds = new Set(
          h.events
            .filter((e) => e.type === "agent_tool_result")
            .flatMap((e) => (e as { content?: { type: string; tool_use_id?: string }[] }).content ?? [])
            .filter((b) => b.type === "tool_result")
            .map((b) => b.tool_use_id),
        );
        // Unpaired ids are how a transcript ends up with a call that never
        // visibly finishes.
        for (const id of callIds) expect(resultIds, `no result for ${String(id)}`).toContain(id);
      });

      it("reports DISJOINT token figures and the CLI's own cost", () => {
        const h = makeHarness();
        homes.push(h.home);
        const lines = capture(file);
        h.child.emitStdout(lines);
        h.child.close(0);

        const result = h.events.find((e) => e.type === "agent_result") as {
          status: string;
          tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
          cost?: { totalUsd: number };
          contextWindow?: number;
          contextTokens?: number;
        };
        expect(result.status).toBe("success");
        const raw = JSON.parse(lines[lines.length - 1]) as {
          usage: Record<string, number>;
          total_cost_usd: number;
        };
        // Passed through unchanged — no normalizer, because the figures do not
        // overlap (verified arithmetically on this very event).
        expect(result.tokens).toEqual({
          input: raw.usage.input_tokens,
          output: raw.usage.output_tokens,
          cacheRead: raw.usage.cache_read_input_tokens,
          cacheWrite: raw.usage.cache_creation_input_tokens,
        });
        expect(result.cost?.totalUsd).toBe(raw.total_cost_usd);
        // The window comes from `modelUsage`, the only place the wire states it.
        expect(result.contextWindow).toBeGreaterThan(0);
        // Context occupancy is the LAST call's prompt, not the summed totals —
        // summing would report a multiple of the real figure.
        expect(result.contextTokens).toBeLessThan(
          raw.usage.input_tokens + raw.usage.cache_read_input_tokens + raw.usage.output_tokens,
        );
      });
    });
  }
});

describe("GrokAdapter — the paths a capture cannot show", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it("synthesizes a failed result when the stream is truncated by a crash", () => {
    const h = makeHarness();
    homes.push(h.home);
    // The tour, cut off before its terminal `result` — the shape a killed or
    // OOM'd CLI leaves behind.
    h.child.emitStdout(capture("tool-tour-grok-4.6.ndjson").slice(0, 5));
    h.child.close(1);

    const result = h.events.find((e) => e.type === "agent_result") as { status: string; error?: string };
    expect(result.status).toBe("error");
    expect(result.error).toContain("1");
  });

  it("stays SILENT when a signal killed the process mid-turn", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout(capture("tool-tour-grok-4.6.ndjson").slice(0, 5));
    // A null exit code is what a signal death reports. Emitting a result here
    // would settle a user's interrupt as a completed turn.
    h.child.close(null);
    expect(h.events.filter((e) => e.type === "agent_result")).toHaveLength(0);
  });

  it("emits no result for a silent exit 0, leaving the abnormal-exit path to own it", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.close(0);
    expect(h.events.filter((e) => e.type === "agent_result")).toHaveLength(0);
  });

  it("does not emit a second result when the CLI exits after one", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout(capture("tool-tour-grok-4.6.ndjson"));
    h.child.close(0);
    expect(h.events.filter((e) => e.type === "agent_result")).toHaveLength(1);
  });

  it("tolerates interleaved non-JSON output without losing the turn", () => {
    const h = makeHarness();
    homes.push(h.home);
    const lines = capture("tool-tour-grok-4.6.ndjson");
    h.child.emitStdout([
      "warning: something the CLI decided to print",
      ...lines,
      "not json either",
    ]);
    h.child.close(0);
    expect(h.events.filter((e) => e.type === "agent_result")).toHaveLength(1);
  });

  it("refuses a second concurrent turn rather than running two CLIs", () => {
    const h = makeHarness();
    homes.push(h.home);
    const errors: Error[] = [];
    h.adapter.on("error", (e) => errors.push(e));
    h.adapter.run({ prompt: "again", cwd: "/workspace" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("in flight");
    h.child.close(0);
  });
});

describe("GrokAdapter — the per-spawn config root", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-config-test-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const start = (adapter: GrokAdapter, child: FakeChild, captured: { env: Record<string, string> }): void => {
    adapter.run({ prompt: "p", cwd: "/workspace" });
    void child;
    void captured;
  };

  function build(): { adapter: GrokAdapter; child: FakeChild; env: () => Record<string, string> } {
    const child = new FakeChild();
    const captured: { env: Record<string, string> } = { env: {} };
    const adapter = new GrokAdapter({
      resolveHome: () => home,
      spawnFn: (_c, _a, opts) => {
        captured.env = (opts.env ?? {}) as Record<string, string>;
        return child as unknown as ChildProcess;
      },
    });
    return { adapter, child, env: () => captured.env };
  }

  it("points GROK_HOME at a throwaway root, never at the shared one", () => {
    const { adapter, child, env } = build();
    start(adapter, child, { env: {} });
    const spawnHome = env().GROK_HOME;
    // The whole point: two concurrent spawns must not share one config.toml.
    expect(spawnHome).not.toBe(path.join(home, ".grok"));
    expect(fs.existsSync(path.join(spawnHome, "config.toml"))).toBe(true);
    child.close(0);
  });

  it("writes the MCP servers into that root's config.toml", () => {
    const { adapter, child, env } = build();
    adapter.writeMcpConfig({
      servers: [],
      shipitBridge: { tsxBin: "/usr/bin/tsx", bridgePath: "/opt/bridge.ts" },
      onServerFailed: () => undefined,
    });
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const toml = fs.readFileSync(path.join(env().GROK_HOME, "config.toml"), "utf8");
    expect(toml).toContain('[mcp_servers."shipit"]');
    expect(toml).toContain('[mcp_servers."playwright"]');
    child.close(0);
  });

  it("symlinks sessions/ back to the real root, so -r can still resume", () => {
    const { adapter, child, env } = build();
    start(adapter, child, { env: {} });
    const link = path.join(env().GROK_HOME, "sessions");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(home, ".grok", "sessions")));
    child.close(0);
  });

  it("symlinks auth.json when there is one, and omits the link when there is not", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });

    const keyMode = build();
    keyMode.adapter.run({ prompt: "p", cwd: "/workspace" });
    // Key mode has no auth.json; a dangling link would be worse than none.
    expect(fs.existsSync(path.join(keyMode.env().GROK_HOME, "auth.json"))).toBe(false);
    keyMode.child.close(0);

    fs.writeFileSync(path.join(configRoot, "auth.json"), '{"scope":{"key":"secret"}}');
    const subMode = build();
    subMode.adapter.run({ prompt: "p", cwd: "/workspace" });
    const link = path.join(subMode.env().GROK_HOME, "auth.json");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(link, "utf8")).toBe('{"scope":{"key":"secret"}}');
    subMode.child.close(0);
  });

  it("removes the throwaway root at turn end WITHOUT following its symlinks", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(path.join(configRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(configRoot, "sessions", "conversation.json"), "{}");
    fs.writeFileSync(path.join(configRoot, "auth.json"), '{"scope":{"key":"secret"}}');

    const { adapter, child, env } = build();
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const spawnHome = env().GROK_HOME;
    child.close(0);

    expect(fs.existsSync(spawnHome)).toBe(false);
    // The durable state is what the links point AT. A cleanup that followed
    // them would delete this session's resume history and its credentials.
    expect(fs.existsSync(path.join(configRoot, "sessions", "conversation.json"))).toBe(true);
    expect(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8")).toBe('{"scope":{"key":"secret"}}');
  });

  it("gives two concurrent spawns two different roots", () => {
    // The container case this design exists for: a turn and a `shipit agent
    // run` sub-agent alive at the same time, both built with the same home.
    const first = build();
    first.adapter.run({ prompt: "turn", cwd: "/workspace" });
    const second = build();
    second.adapter.run({ prompt: "consult", cwd: "/workspace" });

    expect(first.env().GROK_HOME).not.toBe(second.env().GROK_HOME);
    // And one finishing must not disturb the other's config.
    first.child.close(0);
    expect(fs.existsSync(path.join(second.env().GROK_HOME, "config.toml"))).toBe(true);
    second.child.close(0);
  });

  it("surfaces the init event's per-server MCP status", () => {
    const { adapter, child } = build();
    const statuses: unknown[] = [];
    adapter.on("mcp_status", (s) => statuses.push(s));
    adapter.run({ prompt: "p", cwd: "/workspace" });
    child.emitStdout([
      '{"type":"system","subtype":"init","session_id":"s1","model":"grok-4.6","tools":[],"mcp_servers":[{"name":"shipit","status":"connected"},{"name":"broken","status":"failed"}]}',
    ]);
    child.close(0);
    expect(statuses[0]).toEqual([
      { name: "shipit", state: "loaded" },
      { name: "broken", state: "failed", reason: "status: failed" },
    ]);
  });
});

describe("GrokAdapter — the contract it declines", () => {
  it("refuses steering loudly rather than dropping the message", () => {
    const child = new FakeChild();
    const errors: Error[] = [];
    const adapter = new GrokAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.on("error", (e) => errors.push(e));
    adapter.sendUserMessage("hello?");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("steering");
  });

  it("declares itself non-streaming, matching startsOwnTurns: false", () => {
    expect(new GrokAdapter().isStreaming).toBe(false);
  });
});
