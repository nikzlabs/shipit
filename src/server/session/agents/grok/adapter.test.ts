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
import { GrokAdapter, resolveGrokBinary } from "./adapter.js";
import type { AgentEvent, AgentRunParams } from "../agent-process.js";

// Real implementation, made observable — see the tree-teardown test below.
vi.mock("../../../shared/kill-child.js", async (importOriginal) => {
  // eslint-disable-next-line no-restricted-syntax -- the mock factory's signature requires the inline import type
  const real = await importOriginal<typeof import("../../../shared/kill-child.js")>();
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) };
});
import { killProcessTree } from "../../../shared/kill-child.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

// `grokHome()` honours `process.env.GROK_HOME` first. A grok-pinned session
// (and this test file, when run from one) exports it as the throwaway spawn
// root of the *parent* CLI, which would make every adapter here treat that
// live directory as its shared config root — including copying a test fixture
// over a real `auth.json`. Pin it off for the file (planning#448).
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

  it("declares supportsReview, and names the two tools that earn it", () => {
    // planning#459 / docs/266 item 15 — chat-native review needs a shell tool
    // and a subagent primitive, and (since docs/220) no MCP surface at all.
    // Probed live at depth 0: a grok session ran
    // `shipit agent run --role reviewer --prompt-file -` itself and returned
    // material findings; on a non-zero exit it fell back to `spawn_subagent`.
    const h = makeHarness();
    homes.push(h.home);
    expect(h.adapter.capabilities.supportsReview).toBe(true);
    expect(h.adapter.capabilities.toolNames).toContain("run_terminal_command");
    expect(h.adapter.capabilities.toolNames).toContain("spawn_subagent");
    h.child.close(0);
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

  /**
   * Passes the level it is GIVEN, and passes nothing when given nothing.
   *
   * This replaces a "never passes it" assertion, and the inversion is
   * planning#435's finding rather than a relaxation: under a subscription the
   * CLI puts `--reasoning-effort` on the wire (recorder-verified with a negative
   * control), so an adapter that dropped it would silently ignore a level the
   * user picked and paid for.
   *
   * The gate that keeps the flag off a key-billed turn is upstream, in the
   * catalogue's harness×mode axis — a key-billed grok selection offers no level
   * for anything to pick, which `catalogue.test.ts` and `reviewer-model.test.ts`
   * pin. Re-testing the billing mode here would be a second copy of that rule,
   * and the adapter does not receive a billing mode to test.
   */
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

      /**
       * planning#509 — the post-result kill exists so an MCP child holding the
       * event loop open cannot keep the session busy, and it has to take that
       * child's own descendants (a Playwright browser) with it.
       */
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
        // The docs/272 tour's load-bearing surfaces: the task panel, a read, an
        // edit, a shell command and a search — persisted under the Claude-spelled
        // names the recognition registries key on (planning#437), never the raw
        // wire ids. A mapping that dropped tool_use blocks would still produce
        // assistant text, which is exactly why this asserts on the calls rather
        // than on the turn's final prose.
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
        // Edit/Write bodies are already snake_case on this wire — untouched.
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
        // Unpaired ids are how a transcript ends up with a call that never
        // visibly finishes.
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
        // 4.6's foreground spawn unwraps to the report ("3"); 4.20's background
        // spawn unwraps to the launch acknowledgement. Either way, no raw
        // `{"type":…}` envelope reaches the SubagentCall card.
        expect(result?.content?.startsWith("{")).toBe(false);
        // Every OTHER result keeps its envelope verbatim — the honest wire
        // content, modal-only.
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

/**
 * planning#453 — an ERRORED terminal event, which no tour capture contains.
 *
 * Every fixture above is a successful tool tour, so nothing had ever exercised
 * the failure shape, and the adapter was written to Claude's contract: read the
 * reason off `result`. Grok does not do that. On an error it emits no `result`
 * key at all and puts the reason in an `errors` ARRAY — so the adapter fell
 * through to its placeholder and replaced the provider's own words with
 * `Grok ended the turn with subtype "error_during_execution"`.
 *
 * That is a quota bug, not a cosmetic one. `agent_result.error` is what the
 * orchestrator's `detectHardExhaustion` reads (`agent-listeners.ts`'s req-7
 * stamp and `turn-executor.ts`'s req-14 failover both key off it), and the
 * placeholder matches no pattern — so a Grok turn refused for quota looked like
 * a generic failure, the account was never benched, and the next turn walked
 * into the same wall.
 *
 * `__fixtures__/rate-limited-429-grok-4.5.ndjson` is a real capture, taken the
 * way the rest of this file's fixtures were except for who answered: CLI 1.0.1
 * driven against a LOCAL HTTP recorder returning 429 on `POST /v1/responses`,
 * on 2026-08-23, so no plan was spent to obtain it. The recorder chose the
 * 429 *body*; the CLI chose everything else — the event shape, the field, the
 * retry behaviour (`duration_ms: 120012` — two attempts a minute apart), and
 * the `"<code>: <error>"` join that lands the service's own wording in
 * `errors[0]` verbatim.
 */
describe("GrokAdapter — an errored terminal event (planning#453)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  /** The capture's own error text, read from the fixture so the two cannot drift. */
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
    // The whole point of the fix: this exact string already matches
    // `EXHAUSTION_PATTERNS`' `/out of (?:quota|credits)/i`. Nothing needed
    // widening — the text simply never arrived. Asserted here rather than by
    // importing the orchestrator matcher, which is that module's own test.
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
    // The other shape a refusal can take: `{"type":"error","message":…}` with no
    // result event after it. The close handler is the only place a terminal
    // result can come from, and it used to say `Grok exited with code 1 before
    // producing a result` — discarding the one sentence that says why.
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
    // One adapter, two spawns. Production builds an adapter per turn, but the
    // same instance serves consecutive runs here and on the sub-agent path, so
    // a held error must not outlive the turn that produced it.
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

/**
 * planning#444 second half — WHICH grok a spawn runs.
 *
 * `@xai-official/grok` ships two programs called `grok`: the npm `.bin` shim is
 * a JS launcher that bootstraps ~157MB into `$GROK_HOME` when it finds no binary
 * there, and the platform package's `bin/grok` is the real CLI. Every image
 * prepends `/opt/agent-cli/node_modules/.bin` to `PATH`, AHEAD of the
 * `/usr/local/bin` link the installer creates — so a bare-name spawn got the
 * launcher (measured live: `command -v grok` answered the `.bin` path). Combined
 * with this adapter's fresh per-spawn `GROK_HOME`, that is a 157MB bootstrap per
 * TURN, written into the per-session credentials volume.
 *
 * The installer now unlinks the shim; this pins the adapter's own half, so an
 * image built before that change still spawns the real binary.
 */
describe("GrokAdapter — which binary a spawn resolves to (planning#444)", () => {
  let root: string;
  let npmBin: string;
  let realBin: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-path-test-"));
    // The production shape, in order: the npm launcher first, the real link second.
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
    // A launcher-only install is still worse than no turn at all, so the bare
    // name stays the floor — with a warning, which is the part that was missing.
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

  // 2026-08-21 incident — a same-harness sub-agent spawn's isolated per-spawn
  // HOME (`AgentRunParams.homeDir`) outranks the constructor resolver: the
  // throwaway config root links its durable auth.json (and HOME itself) out of
  // THAT root's `.grok`, never the session's.
  it("prefers a per-spawn homeDir over the resolver for HOME and the auth source", () => {
    const spawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-spawn-home-"));
    try {
      fs.mkdirSync(path.join(spawnHome, ".grok"), { recursive: true });
      fs.writeFileSync(path.join(spawnHome, ".grok", "auth.json"), '{"scope":{"key":"isolated"}}');
      // The SESSION root has its own auth — the spawn must not read it.
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

  /**
   * planning#435 — the SUBSCRIPTION turn's whole credential handling, and the
   * failure it prevents is silent rather than loud.
   *
   * An account-delivered credential carries no `serviceRouting` at all (a login
   * IS the vendor's own, bound to the vendor's own endpoint), so the routed
   * branch never runs. Meanwhile the worker is handed every stored service
   * credential regardless of the turn's route — so on any install that has ever
   * saved an xAI key, the CLI would prefer `XAI_API_KEY` over the login on disk
   * and bill the key while ShipIt attributed the turn to the subscription.
   *
   * The gate is the auth FILE and not a scoped home, because `resolveHome` is
   * undefined inside a container — the one place this matters most.
   */
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
      // No endpoint override either: the CLI reaches cli-chat-proxy by itself
      // off auth.json, and a base URL meant for the key mode would redirect it.
      expect(sub.env().GROK_XAI_API_BASE_URL).toBeUndefined();
      sub.child.close(0);

      // The OTHER direction, which is why the scrub cannot simply be
      // unconditional: with no login on disk an unrouted spawn keeps the
      // ambient key, because "use the key in my environment" is the only thing
      // such a spawn could mean. Removing it would fail the turn with an auth
      // error naming no cause.
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
    // The durable state is what the links point AT. A cleanup that followed
    // them would delete this session's resume history and its credentials.
    expect(fs.existsSync(path.join(configRoot, "sessions", "conversation.json"))).toBe(true);
    expect(fs.readFileSync(path.join(configRoot, "auth.json"), "utf8")).toBe('{"scope":{"key":"secret"}}');
  });

  /**
   * planning#448 — the grok CLI refreshes by atomic-rename onto
   * `$GROK_HOME/auth.json`, which replaces the symlink `makeSpawnHome` created
   * with a regular file. Without a copy-back, the live token lives only in the
   * throwaway root: the session credentials the orchestrator watches never
   * move, publish-back is a no-op, and `rmSync` at turn end deletes the
   * rotation.
   */
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

  /**
   * planning#444 — THE regression guard. Every session image symlinks
   * `~/.grok` at `/credentials/.grok`, and key-billed Grok writes no credential
   * material, so nothing created the target: the link DANGLED in every session
   * container. `mkdirSync(realRoot, {recursive: true})` through a dangling
   * symlink throws, and the old `catch` returned that same dangling path as
   * `GROK_HOME` — the CLI then died at its own session creation with
   * `duration_ms: 0`, before any stream event.
   *
   * These build the shape literally (a symlink whose target does not exist), so
   * a fallback that ever again hands the CLI an unopenable root fails here.
   */
  describe("when the shared config root is a DANGLING symlink (planning#444)", () => {
    /** The container shape: `<home>/.grok` -> a target nothing ever created. */
    function danglingGrokHome(): string {
      const missing = path.join(home, "credentials-that-do-not-exist", ".grok");
      fs.symlinkSync(missing, path.join(home, ".grok"));
      return missing;
    }

    it("never hands the CLI the path that just failed", () => {
      const missing = danglingGrokHome();
      const { adapter, child, env, spawned } = build();
      adapter.run({ prompt: "p", cwd: "/workspace" });

      // The turn still starts — the old behaviour started it too, but pointed
      // at a root the CLI could not open.
      expect(spawned()).toBe(true);
      const spawnHome = env().GROK_HOME;
      expect(spawnHome).not.toBe(path.join(home, ".grok"));
      expect(spawnHome).not.toBe(missing);
      // And the root it DID get is genuinely usable: a real directory, with the
      // `sessions` dir whose absence is what killed the CLI, and this turn's
      // MCP config.
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

      // A silent fallback is what made this cost a process watcher to diagnose.
      expect(logs.join("\n")).toMatch(/config root/i);
      expect(logs.join("\n")).toMatch(/resume/i);
      child.close(0);
    });

    it("does not create anything inside the credentials tree it could not open", () => {
      const missing = danglingGrokHome();
      const { adapter, child } = build();
      adapter.run({ prompt: "p", cwd: "/workspace" });

      // Repairing the tree belongs to the orchestrator and the entrypoint: it is
      // per-session and uid-sensitive (docs/150, docs/270), so an adapter running
      // as the session uid must not conjure directories inside it.
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

/**
 * docs/276 — compaction. The fixture is a real capture of a manual `/compact`
 * run (CLI 1.0.1, `--output-format streaming-messages-json`, the format this
 * adapter parses), replayed byte-for-byte like every other capture here.
 *
 * The assertion that earns its keep is the TRIGGER one. Grok stamps
 * `compact_metadata.trigger: "auto"` on the wire even for a compaction ShipIt
 * asked for — the fixture line says `"auto"` and was produced by an explicit
 * `/compact` — so a mapping that forwarded the field would mislabel every
 * user-triggered compaction as spontaneous. If a future version starts telling
 * the truth there, this test still passes and the correlation stays correct;
 * what it forbids is trusting the field.
 */
describe("GrokAdapter — compaction (docs/276)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it("needs no special argv — `/compact` rides the prompt file", () => {
    const h = makeHarness({ prompt: "/compact", sessionId: "01a01f5d-b222-72c1-ba3d-a00426df1c32", compact: true });
    homes.push(h.home);
    // The trigger is in-band (Claude's shape), so the spawn is an ordinary
    // resumed turn whose prompt happens to be the slash command.
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
      // NOT the wire's "auto" — this fixture line came from an explicit
      // `/compact`, which is precisely why the field cannot be forwarded.
      trigger: "manual",
      preTokens: 12322,
    });
    // Grok reports no post-compaction figure and no duration; the card degrades
    // rather than inventing them.
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
    // And an ordinary turn must not claim ShipIt asked for it.
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
    // Unlike sendUserMessage, this must NOT emit an error: a best-effort
    // compaction failing must not tear down the turn it was asked about.
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
