/**
 * Unit tests for the `shipit` shim (docs/117). Covers:
 * - argument parsing
 * - allowlist enforcement (rejected subcommands, --repo / --owner)
 * - happy paths for create / list / view
 * - error formatting (validation, quota 429, generic broker error)
 * - exit codes + JSON output
 *
 * The shim talks to the worker over HTTP. Tests inject a fake `call`
 * function so we never actually open a socket.
 *
 * Kept structurally parallel to `gh.test.ts` so the two shims share
 * exactly one test harness shape.
 */

import { describe, it, expect } from "vitest";
import { runShim, parseFlags, type ShimIO } from "./shipit.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeRunner() {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const calls: RecordedCall[] = [];

  const io: ShimIO = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    exit: (code) => {
      exitCode = code;
      throw new Error("__shim_exit__");
    },
  };

  async function run(
    argv: string[],
    responses: Record<string, MockResponse> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; calls: RecordedCall[] }> {
    stdout = "";
    stderr = "";
    exitCode = null;
    calls.length = 0;

    const fakeCall = async (method: "GET" | "POST" | "PATCH", path: string, body: unknown) => {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      const matching = responses[key];
      if (matching) return { status: matching.status, body: matching.body };
      // Default: 200 with empty body so handlers fall through to "not found" cases
      return { status: 200, body: { child: null, children: [] } };
    };

    try {
      await runShim(argv, io, {}, fakeCall as never);
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode, calls: [...calls] };
  }

  return { run };
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe("parseFlags (shipit shim)", () => {
  it("parses positional + value flags + boolean flags", () => {
    const out = parseFlags(["abc", "-p", "Hello", "--json"], {
      values: { "-p": "prompt" },
      booleans: { "--json": "json" },
    });
    expect(out.positional).toEqual(["abc"]);
    expect(out.values).toEqual({ prompt: "Hello" });
    expect(out.booleans.has("json")).toBe(true);
  });

  it("supports --flag=value form", () => {
    const out = parseFlags(["--prompt=Hello"], { values: { "--prompt": "prompt" } });
    expect(out.values.prompt).toBe("Hello");
  });

  it("flags missing values are tracked as unsupported", () => {
    const out = parseFlags(["-p"], { values: { "-p": "prompt" } });
    expect(out.unsupported.length).toBe(1);
  });

  it("unknown flags appear in unsupported", () => {
    const out = parseFlags(["--mystery", "value"], { values: {} });
    expect(out.unsupported).toContain("--mystery");
  });
});

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

describe("runShim — help and version", () => {
  it("prints help when no args", async () => {
    const { run } = makeRunner();
    const out = await run([]);
    expect(out.stdout).toContain("ShipIt");
    expect(out.stdout).toContain("shipit session create");
    expect(out.exitCode).toBe(0);
  });

  it("prints help on --help", async () => {
    const { run } = makeRunner();
    const out = await run(["--help"]);
    expect(out.stdout).toContain("Supported subcommands");
    expect(out.exitCode).toBe(0);
  });

  it("prints help on `shipit session help`", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "help"]);
    expect(out.stdout).toContain("Supported subcommands");
    expect(out.exitCode).toBe(0);
  });

  it("prints help on `shipit session` (no subcommand)", async () => {
    const { run } = makeRunner();
    const out = await run(["session"]);
    expect(out.stdout).toContain("Supported subcommands");
    expect(out.exitCode).toBe(0);
  });

  it("--version prints the shim version", async () => {
    const { run } = makeRunner();
    const out = await run(["--version"]);
    expect(out.stdout).toContain("ShipIt shim");
    expect(out.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

describe("runShim — allowlist", () => {
  it("rejects unknown top-level subcommands", async () => {
    const { run } = makeRunner();
    const out = await run(["nonsense"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unknown shipit subcommand");
  });

  it.each([
    "delete",
    "archive",
    "message",
    "wait",
    "fork",
    "adopt",
    "merge",
    "rename",
    "switch",
  ])("rejects `shipit session %s` with a helpful error pointing at the docs", async (sub) => {
    const { run } = makeRunner();
    const out = await run(["session", sub]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(`Tried: shipit session ${sub}`);
    expect(out.stderr).toContain("/shipit-docs/sessions.md");
  });

  it("rejects unsupported session subcommand", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "nuke"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unsupported shipit session subcommand");
  });

  it("rejects --repo / --owner on create", async () => {
    const { run } = makeRunner();
    const repoOut = await run(["session", "create", "-p", "x", "--repo", "other/r"]);
    expect(repoOut.exitCode).not.toBe(0);
    expect(repoOut.stderr).toContain("--repo/--owner");

    const ownerOut = await run(["session", "create", "-p", "x", "--owner", "other"]);
    expect(ownerOut.exitCode).not.toBe(0);
    expect(ownerOut.stderr).toContain("--repo/--owner");
  });

  it("rejects unsupported flags on create", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "create", "-p", "x", "--bogus"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unsupported flag");
  });
});

// ---------------------------------------------------------------------------
// shipit session create
// ---------------------------------------------------------------------------

describe("shipit session create", () => {
  it("requires -p/--prompt", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "create"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("--prompt is required");
  });

  it("rejects a >50,000-char prompt before hitting the broker", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "create", "-p", "x".repeat(50_001)]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("exceeds 50,000");
  });

  it("posts to /agent-ops/session/create and prints the stable text block", async () => {
    const { run } = makeRunner();
    const out = await run(
      [
        "session", "create",
        "-p", "Port API to TS",
        "--title", "Port API",
        "--branch", "port-api-ts",
        "--turn", "turn-123",
      ],
      {
        "POST /agent-ops/session/create": {
          status: 200,
          body: {
            sessionId: "ses_abc",
            branch: "port-api-ts",
            status: "running",
            session: { id: "ses_abc" },
          },
        },
      },
    );

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("session-id: ses_abc");
    expect(out.stdout).toContain("branch:     port-api-ts");
    expect(out.stdout).toContain("status:     running");

    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].method).toBe("POST");
    expect(out.calls[0].path).toBe("/agent-ops/session/create");
    // `--turn` maps to `spawnedByTurn` on the wire.
    expect(out.calls[0].body).toMatchObject({
      prompt: "Port API to TS",
      title: "Port API",
      branch: "port-api-ts",
      spawnedByTurn: "turn-123",
    });
    // Don't send fields the agent didn't pass:
    const body = out.calls[0].body as Record<string, unknown>;
    expect("agent" in body).toBe(false);
    expect("base" in body).toBe(false);
    expect("model" in body).toBe(false);
  });

  it("forwards --agent, --model, --base when supplied", async () => {
    const { run } = makeRunner();
    const out = await run(
      [
        "session", "create",
        "-p", "x",
        "--agent", "codex",
        "--model", "claude-sonnet-4-20250514",
        "--base", "origin/main",
      ],
      {
        "POST /agent-ops/session/create": { status: 200, body: { sessionId: "s", branch: "b", status: "running" } },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({
      agent: "codex",
      model: "claude-sonnet-4-20250514",
      base: "origin/main",
    });
  });

  it("--json prints the full broker response on stdout", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "create", "-p", "x", "--json"],
      {
        "POST /agent-ops/session/create": {
          status: 200,
          body: { sessionId: "ses_x", branch: "b", status: "running" },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ sessionId: "ses_x", branch: "b" });
  });

  it("surfaces a quota 429 with a docs pointer", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "create", "-p", "x"],
      {
        "POST /agent-ops/session/create": {
          status: 429,
          body: { error: "Per-turn spawn limit reached" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Per-turn spawn limit");
    expect(out.stderr).toContain("/shipit-docs/sessions.md");
  });

  it("propagates a 400 error verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "create", "-p", "x"],
      {
        "POST /agent-ops/session/create": { status: 400, body: { error: "Invalid branch name" } },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Invalid branch name");
  });
});

// ---------------------------------------------------------------------------
// shipit session list
// ---------------------------------------------------------------------------

describe("shipit session list", () => {
  it("prints 'No spawned sessions' when the broker returns an empty list", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "list"], {
      "GET /agent-ops/session/list": { status: 200, body: { children: [] } },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("No spawned sessions");
  });

  it("prints a tab-separated row per child", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "list"],
      {
        "GET /agent-ops/session/list": {
          status: 200,
          body: {
            children: [
              { id: "ses_a", title: "A", branch: "br-a", status: "running" },
              { id: "ses_b", title: "B", branch: "br-b", status: "idle" },
            ],
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("ses_a");
    expect(out.stdout).toContain("running");
    expect(out.stdout).toContain("br-a");
    expect(out.stdout).toContain("ses_b");
  });

  it("forwards --turn to the broker", async () => {
    const { run } = makeRunner();
    await run(
      ["session", "list", "--turn", "turn-xyz"],
      { "GET /agent-ops/session/list": { status: 200, body: { children: [] } } },
    );
    const { run: run2 } = makeRunner();
    const out = await run2(
      ["session", "list", "--turn", "turn-xyz"],
      { "GET /agent-ops/session/list": { status: 200, body: { children: [] } } },
    );
    expect(out.calls[0].path).toContain("turn=turn-xyz");
  });

  it("--json prints the array as-is", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "list", "--json"],
      {
        "GET /agent-ops/session/list": {
          status: 200,
          body: { children: [{ id: "ses_a", title: "A" }] },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([{ id: "ses_a", title: "A" }]);
  });
});

// ---------------------------------------------------------------------------
// shipit session view
// ---------------------------------------------------------------------------

describe("shipit session view", () => {
  it("requires a session id", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "view"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("child session id is required");
  });

  it("prints the plain-text view for a child", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "view", "ses_a"],
      {
        "GET /agent-ops/session/view/ses_a": {
          status: 200,
          body: {
            child: {
              id: "ses_a",
              title: "Port API",
              branch: "port-api-ts",
              status: "running",
              queueLength: 0,
              spawnedAt: "2026-05-04T14:22:31Z",
              spawnedByTurn: "turn-1",
            },
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Port API (ses_a)");
    expect(out.stdout).toContain("status:     running");
    expect(out.stdout).toContain("branch:     port-api-ts");
    expect(out.stdout).toContain("turn:       turn-1");
  });

  it("--json prints just the child object", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "view", "ses_a", "--json"],
      {
        "GET /agent-ops/session/view/ses_a": {
          status: 200,
          body: { child: { id: "ses_a", title: "A", status: "idle" } },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ id: "ses_a", title: "A", status: "idle" });
  });

  it("exits non-zero on 404 with a 'not a descendant' message", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "view", "ses_other"],
      {
        "GET /agent-ops/session/view/ses_other": { status: 404, body: { error: "Spawned session not found" } },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("not a descendant of this parent");
  });

  it("exits non-zero when the broker responds with child:null on 200", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "view", "ses_a"], {
      "GET /agent-ops/session/view/ses_a": { status: 200, body: { child: null } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Spawned session not found");
  });
});
