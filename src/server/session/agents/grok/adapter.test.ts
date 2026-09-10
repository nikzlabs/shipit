// Tool-tour fixtures were captured from Grok CLI 1.0.1 on 2026-08-18.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { GrokAdapter, resolveGrokBinary } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) };
});
import { killProcessTree } from "../../../shared/kill-child.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

// An inherited GROK_HOME could make these tests overwrite the parent CLI's auth.json.
const ORIGINAL_GROK_HOME = process.env.GROK_HOME;
beforeEach(() => {
  delete process.env.GROK_HOME;
});
afterEach(() => {
  if (ORIGINAL_GROK_HOME === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = ORIGINAL_GROK_HOME;
});

function capture(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());
}

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

  it("declares supportsReview, and names the two tools that earn it", () => {
    const h = makeHarness();
    homes.push(h.home);
    expect(h.adapter.capabilities.supportsReview).toBe(true);
    expect(h.adapter.capabilities.toolNames).toContain("run_terminal_command");
    expect(h.adapter.capabilities.toolNames).toContain("spawn_subagent");
    h.child.close(0);
  });

  it("trusts the workspace folder, so the repo's own project config is not skipped", () => {
    for (const params of [
      {},
      { sessionId: "01a01473-26aa-7a21-ac7c-2ca7c9cb4944" },
      { permissionMode: "plan" as const },
      { permissionMode: "guarded" as const },
    ]) {
      const h = makeHarness(params);
      homes.push(h.home);
      expect(h.args, JSON.stringify(params)).toContain("--trust");
      h.child.close(0);
    }
  });

  it("passes the prompt as a FILE, never on argv", () => {
    const h = makeHarness({ prompt: "x".repeat(300_000) });
    homes.push(h.home);
    expect(h.args).toContain("--prompt-file");
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

  it("passes the reasoning level it is handed, and none when handed none", () => {
    const withEffort = makeHarness({ reasoningEffort: "xhigh" });
    homes.push(withEffort.home);
    expect(withEffort.args).toContain("--reasoning-effort");
    expect(withEffort.args[withEffort.args.indexOf("--reasoning-effort") + 1]).toBe("xhigh");
    withEffort.child.close(0);

    const without = makeHarness({});
    homes.push(without.home);
    expect(without.args).not.toContain("--reasoning-effort");
    expect(without.args).not.toContain("--effort");
    without.child.close(0);
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
    expect(h.env.GROK_CLAUDE_SKILLS_ENABLED).toBe("1");
    expect(h.env.GROK_CLAUDE_RULES_ENABLED).toBe("1");
    for (const off of [
      "GROK_CLAUDE_MCPS_ENABLED", "GROK_CLAUDE_HOOKS_ENABLED",
      "GROK_CLAUDE_AGENTS_ENABLED", "GROK_CLAUDE_SESSIONS_ENABLED",
      "GROK_CURSOR_SKILLS_ENABLED", "GROK_CURSOR_MCPS_ENABLED",
      "GROK_CURSOR_HOOKS_ENABLED", "GROK_CODEX_SESSIONS_ENABLED",
    ]) {
      expect(h.env[off], off).toBe("0");
    }
    expect(h.env.GROK_DISABLE_AUTOUPDATER).toBe("1");
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
        expect(kinds.filter((k) => k === "agent_init")).toHaveLength(1);
        expect(kinds.filter((k) => k === "agent_result")).toHaveLength(1);
        expect(kinds.filter((k) => k === "agent_assistant").length).toBeGreaterThan(0);
        expect(kinds.filter((k) => k === "agent_tool_result").length).toBeGreaterThan(0);
        for (const k of kinds) {
          expect(["agent_init", "agent_assistant", "agent_tool_result", "agent_result"]).toContain(k);
        }
      });

      it("tears down the whole process tree when the post-result kill fires", async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(killProcessTree).mockClear();
          const h = makeHarness();
          homes.push(h.home);
          h.child.emitStdout(capture(file));
          expect(vi.mocked(killProcessTree)).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(6_000);
          expect(vi.mocked(killProcessTree)).toHaveBeenCalledWith(
            h.child,
            "SIGTERM",
            expect.objectContaining({ label: "grok" }),
          );
          h.child.close(143);
        } finally {
          vi.useRealTimers();
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

      it("surfaces every tool call the tour drove, under the TRANSCRIPT vocabulary", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const toolNames = h.events
          .filter((e) => e.type === "agent_assistant")
          .flatMap((e) => (e as { content?: { type: string; name?: string }[] }).content ?? [])
          .filter((b) => b.type === "tool_use")
          .map((b) => b.name);
        for (const expected of ["TodoWrite", "Read", "Bash", "Grep", "Edit", "Write"]) {
          expect(toolNames, `${label} tour drove ${expected}`).toContain(expected);
        }
        for (const raw of ["todo_write", "read_file", "run_terminal_command", "grep", "search_replace", "write"]) {
          expect(toolNames, `raw wire name ${raw} leaked into the transcript`).not.toContain(raw);
        }
      });

      it("renames the divergent input keys so the summary and diff registries read them", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const calls = h.events
          .filter((e) => e.type === "agent_assistant")
          .flatMap((e) => (e as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] }).content ?? [])
          .filter((b) => b.type === "tool_use");
        const read = calls.find((c) => c.name === "Read");
        expect(read?.input?.file_path).toBeTruthy();
        expect(read?.input?.target_file).toBeUndefined();
        const glob = calls.find((c) => c.name === "Glob");
        expect(glob?.input?.path).toBeTruthy();
        expect(glob?.input?.target_directory).toBeUndefined();
        const edit = calls.find((c) => c.name === "Edit");
        expect(edit?.input?.file_path).toBeTruthy();
        expect(edit?.input?.old_string).toBeTruthy();
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
        for (const id of callIds) expect(resultIds, `no result for ${String(id)}`).toContain(id);
      });

      it("unwraps the spawn_subagent result so the persisted body is the report, not the envelope", () => {
        const h = makeHarness();
        homes.push(h.home);
        h.child.emitStdout(capture(file));
        h.child.close(0);

        const spawnId = h.events
          .filter((e) => e.type === "agent_assistant")
          .flatMap((e) => (e as { content?: { type: string; name?: string; id?: string }[] }).content ?? [])
          .find((b) => b.type === "tool_use" && b.name === "Agent")?.id;
        expect(spawnId, `${label} tour drove a subagent`).toBeTruthy();
        const result = h.events
          .filter((e) => e.type === "agent_tool_result")
          .flatMap((e) => (e as { content?: { type: string; tool_use_id?: string; content?: string }[] }).content ?? [])
          .find((b) => b.type === "tool_result" && b.tool_use_id === spawnId);
        expect(result?.content?.startsWith("{")).toBe(false);
        const todoResult = h.events
          .filter((e) => e.type === "agent_tool_result")
          .flatMap((e) => (e as { content?: { type: string; tool_use_id?: string; content?: string }[] }).content ?? [])
          .find((b) => b.type === "tool_result" && b.tool_use_id !== spawnId && b.content?.includes("TodosUpdated"));
        expect(todoResult?.content?.startsWith("{")).toBe(true);
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
        expect(result.tokens).toEqual({
          input: raw.usage.input_tokens,
          output: raw.usage.output_tokens,
          cacheRead: raw.usage.cache_read_input_tokens,
          cacheWrite: raw.usage.cache_creation_input_tokens,
        });
        expect(result.cost?.totalUsd).toBe(raw.total_cost_usd);
        expect(result.contextWindow).toBeGreaterThan(0);
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

// The 429 fixture is CLI 1.0.1 output from a local HTTP recorder, 2026-08-23.
describe("GrokAdapter — an errored terminal event (planning#453)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  function capturedRefusal(): string {
    const line = capture("rate-limited-429-grok-4.5.ndjson")
      .map((l) => JSON.parse(l) as { type: string; errors?: string[] })
      .find((e) => e.type === "result");
    return line?.errors?.[0] ?? "";
  }

  it("reports the provider's own refusal, not a placeholder naming the subtype", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout(capture("rate-limited-429-grok-4.5.ndjson"));
    h.child.close(1);

    const result = h.events.find((e) => e.type === "agent_result") as { status: string; error?: string };
    expect(result.status).toBe("error");
    expect(result.error).toBe(capturedRefusal());
    expect(result.error).not.toContain("error_during_execution");
  });

  it("puts that text where the exhaustion classifier can reach it", () => {
    expect(capturedRefusal()).toMatch(/out of credits/i);
    expect(capturedRefusal()).toMatch(/^Out of credits: /);
  });

  it("keeps a SUCCESS reading its text off `result`, which is where success puts it", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout(capture("tool-tour-grok-4.6.ndjson"));
    h.child.close(0);
    const result = h.events.find((e) => e.type === "agent_result") as { status: string; error?: string };
    expect(result.status).toBe("success");
    expect(result.error).toBeUndefined();
  });

  it("forwards a fatal `error` event's message instead of naming the exit code", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout([JSON.stringify({ type: "error", message: "usage limit reached" })]);
    h.child.close(1);
    const result = h.events.find((e) => e.type === "agent_result") as { status: string; error?: string };
    expect(result.status).toBe("error");
    expect(result.error).toBe("usage limit reached");
  });

  it("still names the exit code when the CLI died without saying anything", () => {
    const h = makeHarness();
    homes.push(h.home);
    h.child.emitStdout(capture("tool-tour-grok-4.6.ndjson").slice(0, 5));
    h.child.close(1);
    const result = h.events.find((e) => e.type === "agent_result") as { error?: string };
    expect(result.error).toContain("exited with code 1");
  });

  it("does not carry one turn's fatal message into the next", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-adapter-test-"));
    homes.push(home);
    const children: FakeChild[] = [];
    const events: AgentEvent[] = [];
    const adapter = new GrokAdapter({
      resolveHome: () => home,
      spawnFn: () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
    });
    adapter.on("event", (e) => events.push(e));

    adapter.run({ prompt: "first", cwd: "/workspace" });
    children[0].emitStdout([JSON.stringify({ type: "error", message: "usage limit reached" })]);
    children[0].close(1);

    adapter.run({ prompt: "second", cwd: "/workspace" });
    children[1].emitStdout(capture("tool-tour-grok-4.6.ndjson").slice(0, 5));
    children[1].close(1);

    const results = events.filter((e) => e.type === "agent_result") as { error?: string }[];
    expect(results).toHaveLength(2);
    expect(results[0].error).toBe("usage limit reached");
    expect(results[1].error).toContain("exited with code 1");
  });
});

describe("GrokAdapter — which binary a spawn resolves to (planning#444)", () => {
  let root: string;
  let npmBin: string;
  let realBin: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-path-test-"));
    npmBin = path.join(root, "opt/agent-cli/node_modules/.bin");
    realBin = path.join(root, "usr/local/bin");
    for (const dir of [npmBin, realBin]) fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const put = (dir: string): string => {
    const p = path.join(dir, "grok");
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return p;
  };

  it("skips a node_modules/.bin candidate even when PATH puts it first", () => {
    put(npmBin);
    const real = put(realBin);
    expect(resolveGrokBinary([npmBin, realBin].join(path.delimiter))).toBe(real);
  });

  it("resolves an absolute path, never the bare name, when one is available", () => {
    const real = put(realBin);
    const resolved = resolveGrokBinary([realBin, npmBin].join(path.delimiter));
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(real);
  });

  it("falls back to the bare name rather than refusing to spawn", () => {
    put(npmBin);
    expect(resolveGrokBinary([npmBin].join(path.delimiter))).toBe("grok");
    expect(resolveGrokBinary("")).toBe("grok");
  });

  it("ignores a non-executable candidate", () => {
    fs.writeFileSync(path.join(realBin, "grok"), "not executable", { mode: 0o644 });
    const other = path.join(root, "other-bin");
    fs.mkdirSync(other);
    const real = put(other);
    expect(resolveGrokBinary([realBin, other].join(path.delimiter))).toBe(real);
  });

  it("the adapter spawns what the resolver picked", () => {
    const real = put(realBin);
    const prevPath = process.env.PATH;
    process.env.PATH = [npmBin, realBin].join(path.delimiter);
    try {
      const child = new FakeChild();
      let cmd = "";
      const adapter = new GrokAdapter({
        spawnFn: (c) => {
          cmd = c;
          return child as unknown as ChildProcess;
        },
      });
      adapter.run({ prompt: "p", cwd: "/workspace" });
      expect(cmd).toBe(real);
      expect(cmd).not.toContain(`node_modules${path.sep}.bin`);
      child.close(0);
    } finally {
      process.env.PATH = prevPath;
    }
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

  function build(): {
    adapter: GrokAdapter;
    child: FakeChild;
    env: () => Record<string, string>;
    cmd: () => string;
    spawned: () => boolean;
  } {
    const child = new FakeChild();
    const captured: { env: Record<string, string>; cmd: string; spawned: boolean } = {
      env: {},
      cmd: "",
      spawned: false,
    };
    const adapter = new GrokAdapter({
      resolveHome: () => home,
      spawnFn: (cmd, _a, opts) => {
        captured.env = (opts.env ?? {}) as Record<string, string>;
        captured.cmd = cmd;
        captured.spawned = true;
        return child as unknown as ChildProcess;
      },
    });
    return {
      adapter,
      child,
      env: () => captured.env,
      cmd: () => captured.cmd,
      spawned: () => captured.spawned,
    };
  }

  it("points GROK_HOME at a throwaway root, never at the shared one", () => {
    const { adapter, child, env } = build();
    start(adapter, child, { env: {} });
    const spawnHome = env().GROK_HOME;
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

  it("prefers a per-spawn homeDir over the resolver for HOME and the auth source", () => {
    const spawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-spawn-home-"));
    try {
      fs.mkdirSync(path.join(spawnHome, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(spawnHome, ".grok", "auth.json"), '{"scope":{"key":"isolated"}}');
      fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(home, ".grok", "auth.json"), '{"scope":{"key":"session"}}');

      const { adapter, child, env } = build();
      adapter.run({ prompt: "p", cwd: "/workspace", homeDir: spawnHome });
      expect(env().HOME).toBe(spawnHome);
      const link = path.join(env().GROK_HOME, "auth.json");
      expect(fs.readFileSync(link, "utf8")).toBe('{"scope":{"key":"isolated"}}');
      child.close(0);
    } finally {
      fs.rmSync(spawnHome, { recursive: true, force: true });
    }
  });

  it("scrubs inherited env credentials when a subscription login is on disk", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, "auth.json"), '{"scope":{"access_token":"sub"}}');

    const prior = { key: process.env.XAI_API_KEY, auth: process.env.GROK_AUTH };
    process.env.XAI_API_KEY = "a-metered-key";
    process.env.GROK_AUTH = "/somewhere/else/auth.json";
    try {
      const sub = build();
      sub.adapter.run({ prompt: "p", cwd: "/workspace" });
      expect(sub.env().XAI_API_KEY).toBeUndefined();
      expect(sub.env().GROK_AUTH).toBeUndefined();
      expect(sub.env().GROK_XAI_API_BASE_URL).toBeUndefined();
      sub.child.close(0);

      fs.rmSync(path.join(configRoot, "auth.json"));
      const keyed = build();
      keyed.adapter.run({ prompt: "p", cwd: "/workspace" });
      expect(keyed.env().XAI_API_KEY).toBe("a-metered-key");
      keyed.child.close(0);
    } finally {
      if (prior.key === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prior.key;
      if (prior.auth === undefined) delete process.env.GROK_AUTH;
      else process.env.GROK_AUTH = prior.auth;
    }
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
    expect(fs.existsSync(path.join(configRoot, "sessions", "conversation.json"))).toBe(true);
    expect(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8")).toBe('{"scope":{"key":"secret"}}');
  });

  it("copies a CLI-replaced auth.json back onto the shared root before deleting the throwaway home", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    const stale = JSON.stringify({
      "https://auth.x.ai::test": { key: "stale", expires_at: "2026-08-20T12:46:05.000Z" },
    });
    const fresh = JSON.stringify({
      "https://auth.x.ai::test": { key: "fresh", expires_at: "2026-08-20T19:23:38.000Z" },
    });
    fs.writeFileSync(path.join(configRoot, "auth.json"), stale);

    const { adapter, child, env } = build();
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const spawnAuth = path.join(env().GROK_HOME, "auth.json");
    expect(fs.lstatSync(spawnAuth).isSymbolicLink()).toBe(true);

    fs.unlinkSync(spawnAuth);
    fs.writeFileSync(spawnAuth, fresh, { mode: 0o600 });
    child.close(0);

    expect(fs.existsSync(env().GROK_HOME)).toBe(false);
    expect(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8")).toBe(fresh);
  });

  it("does not copy a replaced auth.json that is older than the shared root", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    const newer = JSON.stringify({
      "https://auth.x.ai::test": { key: "newer", expires_at: "2026-08-20T19:23:38.000Z" },
    });
    const older = JSON.stringify({
      "https://auth.x.ai::test": { key: "older", expires_at: "2026-08-20T12:46:05.000Z" },
    });
    fs.writeFileSync(path.join(configRoot, "auth.json"), newer);

    const { adapter, child, env } = build();
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const spawnAuth = path.join(env().GROK_HOME, "auth.json");
    fs.unlinkSync(spawnAuth);
    fs.writeFileSync(spawnAuth, older, { mode: 0o600 });
    child.close(0);

    expect(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8")).toBe(newer);
  });

  it("copies a rotation written in the committed live grok.json shape", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "orchestrator",
      "__fixtures__",
      "token-freshness",
      "grok.json",
    );
    const fixture = fs.readFileSync(fixturePath, "utf8");
    fs.writeFileSync(path.join(configRoot, "auth.json"), fixture);
    const later = JSON.parse(fixture) as Record<string, Record<string, unknown>>;
    const scope = Object.keys(later)[0];
    later[scope] = { ...later[scope], expires_at: "2026-08-20T19:23:38.000Z", key: "rotated" };

    const { adapter, child, env } = build();
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const spawnAuth = path.join(env().GROK_HOME, "auth.json");
    fs.unlinkSync(spawnAuth);
    fs.writeFileSync(spawnAuth, JSON.stringify(later), { mode: 0o600 });
    child.close(0);

    expect(JSON.parse(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8"))).toEqual(later);
  });

  it("quarantines an unreadable replaced auth.json instead of deleting it", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    const dest = path.join(configRoot, "auth.json");
    const ordered = JSON.stringify({
      "https://auth.x.ai::test": { key: "live", expires_at: "2026-08-20T19:23:38.000Z" },
    });
    fs.writeFileSync(dest, ordered);

    const { adapter, child, env } = build();
    adapter.run({ prompt: "p", cwd: "/workspace" });
    const spawnAuth = path.join(env().GROK_HOME, "auth.json");
    fs.unlinkSync(spawnAuth);
    fs.writeFileSync(spawnAuth, '{"future_shape":{"token":"opaque"}}', { mode: 0o600 });
    child.close(0);

    expect(fs.readFileSync(dest, "utf8")).toBe(ordered);
    const stranded = fs.readdirSync(configRoot).filter((n) => n.startsWith("auth.json.stranded-"));
    expect(stranded).toHaveLength(1);
    expect(fs.readFileSync(path.join(configRoot, stranded[0]), "utf8")).toBe(
      '{"future_shape":{"token":"opaque"}}',
    );
  });

  it("cleans the throwaway root when a routed spawn has no credential", () => {
    const configRoot = path.join(home, ".grok");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(
      path.join(configRoot, "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::test": { key: "sub", expires_at: "2026-08-20T19:23:38.000Z" },
      }),
    );
    const before = new Set(fs.readdirSync("/tmp").filter((n) => n.startsWith("grok-home-")));
    const { adapter } = build();
    const required: string[] = [];
    adapter.on("auth_required", () => required.push("auth_required"));
    adapter.run({
      prompt: "p",
      cwd: "/workspace",
      serviceRouting: {
        serviceId: "xai",
        serviceName: "xAI",
        billingMode: "key",
        style: "openai-chat-completions",
        baseUrl: "https://api.x.ai/v1",
        credentialSourceEnv: "SHIPIT_TEST_GROK_MISSING_CRED",
        credentialTarget: { kind: "env", name: "XAI_API_KEY" },
      },
    });
    expect(required).toEqual(["auth_required"]);
    const leaked = fs.readdirSync("/tmp").filter((n) => n.startsWith("grok-home-") && !before.has(n));
    expect(leaked).toEqual([]);
  });

  it("gives two concurrent spawns two different roots", () => {
    const first = build();
    first.adapter.run({ prompt: "turn", cwd: "/workspace" });
    const second = build();
    second.adapter.run({ prompt: "consult", cwd: "/workspace" });

    expect(first.env().GROK_HOME).not.toBe(second.env().GROK_HOME);
    first.child.close(0);
    expect(fs.existsSync(path.join(second.env().GROK_HOME, "config.toml"))).toBe(true);
    second.child.close(0);
  });

  describe("when the shared config root is a DANGLING symlink (planning#444)", () => {
    function danglingGrokHome(): string {
      const missing = path.join(home, "credentials-that-do-not-exist", ".grok");
      fs.symlinkSync(missing, path.join(home, ".grok"));
      return missing;
    }

    it("never hands the CLI the path that just failed", () => {
      const missing = danglingGrokHome();
      const { adapter, child, env, spawned } = build();
      adapter.run({ prompt: "p", cwd: "/workspace" });

      expect(spawned()).toBe(true);
      const spawnHome = env().GROK_HOME;
      expect(spawnHome).not.toBe(path.join(home, ".grok"));
      expect(spawnHome).not.toBe(missing);
      expect(fs.statSync(spawnHome).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(spawnHome, "sessions")).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(spawnHome, "config.toml"))).toBe(true);
      child.close(0);
    });

    it("narrates the degradation instead of swallowing it", () => {
      danglingGrokHome();
      const { adapter, child } = build();
      const logs: string[] = [];
      adapter.on("log", (_channel, line) => logs.push(line));
      adapter.run({ prompt: "p", cwd: "/workspace" });

      expect(logs.join("\n")).toMatch(/config root/i);
      expect(logs.join("\n")).toMatch(/resume/i);
      child.close(0);
    });

    it("does not create anything inside the credentials tree it could not open", () => {
      const missing = danglingGrokHome();
      const { adapter, child } = build();
      adapter.run({ prompt: "p", cwd: "/workspace" });

      expect(fs.existsSync(missing)).toBe(false);
      expect(fs.existsSync(path.dirname(missing))).toBe(false);
      child.close(0);
    });

    it("still cleans the throwaway root up at turn end", () => {
      danglingGrokHome();
      const { adapter, child, env } = build();
      adapter.run({ prompt: "p", cwd: "/workspace" });
      const spawnHome = env().GROK_HOME;
      child.close(0);
      expect(fs.existsSync(spawnHome)).toBe(false);
    });
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

// CLI 1.0.1 captured this fixture from a manual /compact, but reported trigger="auto".
describe("GrokAdapter — compaction (docs/276)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it("needs no special argv — `/compact` rides the prompt file", () => {
    const h = makeHarness({ prompt: "/compact", sessionId: "01a01f5d-b222-72c1-ba3d-a00426df1c32", compact: true });
    homes.push(h.home);
    expect(h.args).toContain("--prompt-file");
    const promptPath = h.args[h.args.indexOf("--prompt-file") + 1];
    expect(fs.readFileSync(promptPath, "utf8")).toBe("/compact");
    expect(h.args).toContain("-r");
    h.child.close(0);
  });

  it("announces the compaction up front, because Grok emits no progress event", () => {
    const h = makeHarness({ prompt: "/compact", sessionId: "s-1", compact: true });
    homes.push(h.home);
    expect(h.events).toContainEqual({ type: "agent_compaction_started", trigger: "manual" });
    h.child.close(0);
  });

  it("maps compact_boundary to agent_compacted, labeling MANUAL by correlation", () => {
    const h = makeHarness({ prompt: "/compact", sessionId: "s-1", compact: true });
    homes.push(h.home);
    h.child.emitStdout(capture("compact-boundary-grok-4.20.ndjson"));
    h.child.close(0);

    const compacted = h.events.filter((e) => e.type === "agent_compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toEqual({
      type: "agent_compacted",
      trigger: "manual",
      preTokens: 12322,
    });
    expect(compacted[0]).not.toHaveProperty("postTokens");
    expect(compacted[0]).not.toHaveProperty("durationMs");
  });

  it("labels an UNSOLICITED mid-turn compaction as auto", () => {
    const h = makeHarness({ prompt: "do the tour", sessionId: "s-1" });
    homes.push(h.home);
    h.child.emitStdout(capture("compact-boundary-grok-4.20.ndjson"));
    h.child.close(0);

    const compacted = h.events.filter((e) => e.type === "agent_compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ trigger: "auto" });
    expect(h.events).not.toContainEqual({ type: "agent_compaction_started", trigger: "manual" });
  });

  it("still emits agent_init from the same stream — the boundary is not swallowing it", () => {
    const h = makeHarness({ prompt: "/compact", sessionId: "s-1", compact: true });
    homes.push(h.home);
    h.child.emitStdout(capture("compact-boundary-grok-4.20.ndjson"));
    h.child.close(0);
    expect(h.events.filter((e) => e.type === "agent_init")).toHaveLength(1);
  });

  it("no-ops a mid-turn compact() instead of throwing — there is no resident process", () => {
    const child = new FakeChild();
    const errors: Error[] = [];
    const adapter = new GrokAdapter({ spawnFn: () => child as unknown as ChildProcess });
    adapter.on("error", (e) => errors.push(e));
    expect(() => adapter.compact()).not.toThrow();
    expect(errors).toHaveLength(0);
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
