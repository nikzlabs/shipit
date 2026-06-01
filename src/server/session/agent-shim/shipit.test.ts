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
        "--turn", "turn-123",
      ],
      {
        "POST /agent-ops/session/create": {
          status: 200,
          body: {
            sessionId: "ses_abc",
            branch: "shipit/k7p2qz",
            status: "running",
            session: { id: "ses_abc" },
          },
        },
      },
    );

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("session-id: ses_abc");
    expect(out.stdout).toContain("branch:     shipit/k7p2qz");
    expect(out.stdout).toContain("status:     running");

    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].method).toBe("POST");
    expect(out.calls[0].path).toBe("/agent-ops/session/create");
    // `--turn` maps to `spawnedByTurn` on the wire.
    expect(out.calls[0].body).toMatchObject({
      prompt: "Port API to TS",
      title: "Port API",
      spawnedByTurn: "turn-123",
    });
    // Don't send fields the agent didn't pass:
    const body = out.calls[0].body as Record<string, unknown>;
    expect("agent" in body).toBe(false);
    expect("base" in body).toBe(false);
    expect("model" in body).toBe(false);
    // The agent cannot pick its own branch name — `--branch` was dropped
    // because agent-supplied names drifted outside the `shipit/` namespace.
    expect("branch" in body).toBe(false);
  });

  it("rejects --branch as an unsupported flag", async () => {
    const { run } = makeRunner();
    const out = await run([
      "session", "create",
      "-p", "x",
      "--branch", "port-api-ts",
    ]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("--branch");
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

// ---------------------------------------------------------------------------
// shipit session message  (docs/117 Phase 3)
// ---------------------------------------------------------------------------

describe("shipit session message", () => {
  it("requires a child session id", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "message", "-m", "hi"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("child session id is required");
  });

  it("requires -m/--message", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "message", "ses_a"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("--message is required");
  });

  it("rejects an oversized message client-side", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "message", "ses_a", "-m", "x".repeat(50_001)]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("exceeds 50,000");
  });

  it("posts to /agent-ops/session/message/:childId and prints queue position when enqueued", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "message", "ses_a", "-m", "Also do X"],
      {
        "POST /agent-ops/session/message/ses_a": {
          status: 200,
          body: { queuePosition: 2, enqueued: true },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("session-id: ses_a");
    expect(out.stdout).toContain("queued (position 2)");
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].method).toBe("POST");
    expect(out.calls[0].path).toBe("/agent-ops/session/message/ses_a");
    expect(out.calls[0].body).toEqual({ text: "Also do X" });
  });

  it("prints 'starting turn' when the runner accepts the message directly", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "message", "ses_a", "-m", "Hi"],
      {
        "POST /agent-ops/session/message/ses_a": {
          status: 200,
          body: { queuePosition: 0, enqueued: false },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("starting turn");
  });

  it("--json prints the broker response verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "message", "ses_a", "-m", "Hi", "--json"],
      {
        "POST /agent-ops/session/message/ses_a": {
          status: 200, body: { queuePosition: 1, enqueued: true },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ queuePosition: 1, enqueued: true });
  });

  it("surfaces a 404 'not a descendant' verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "message", "ses_other", "-m", "x"],
      {
        "POST /agent-ops/session/message/ses_other": {
          status: 404, body: { error: "Spawned session not found" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("not a descendant of this parent");
  });
});

// ---------------------------------------------------------------------------
// shipit session wait  (docs/117 Phase 3)
// ---------------------------------------------------------------------------

describe("shipit session wait", () => {
  it("requires a child session id", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "wait"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("child session id is required");
  });

  it("rejects a non-numeric or non-positive --timeout client-side", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "wait", "ses_a", "--timeout", "abc"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("--timeout must be a positive number");

    const out2 = await run(["session", "wait", "ses_a", "--timeout", "0"]);
    expect(out2.exitCode).not.toBe(0);
    expect(out2.stderr).toContain("--timeout must be a positive number");
  });

  it("posts to /agent-ops/session/wait/:childId, prints idle status on success", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "wait", "ses_a", "--timeout", "120"],
      {
        "GET /agent-ops/session/wait/ses_a": {
          status: 200,
          body: {
            child: { id: "ses_a", title: "T", status: "idle", queueLength: 0, branch: "br" },
            idle: true,
            timedOut: false,
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].path).toContain("/agent-ops/session/wait/ses_a");
    expect(out.calls[0].path).toContain("timeout=120");
    expect(out.stdout).toContain("idle:       true");
    expect(out.stdout).toContain("timed-out:  false");
  });

  it("exits non-zero with idle=false when the wait times out", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "wait", "ses_a"],
      {
        "GET /agent-ops/session/wait/ses_a": {
          status: 200,
          body: {
            child: { id: "ses_a", title: "T", status: "running", queueLength: 2 },
            idle: false,
            timedOut: true,
          },
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("timed-out:  true");
  });

  it("--json --timeout exits non-zero on timeout", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "wait", "ses_a", "--json"],
      {
        "GET /agent-ops/session/wait/ses_a": {
          status: 200,
          body: {
            child: { id: "ses_a", title: "T", status: "running" },
            idle: false,
            timedOut: true,
          },
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ timedOut: true });
  });

  it("surfaces a 404 'not a descendant' verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "wait", "ses_other"],
      {
        "GET /agent-ops/session/wait/ses_other": {
          status: 404, body: { error: "Spawned session not found" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("not a descendant of this parent");
  });
});

// ---------------------------------------------------------------------------
// shipit session archive  (docs/117 Phase 3)
// ---------------------------------------------------------------------------

describe("shipit session archive", () => {
  it("requires a child session id", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "archive"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("child session id is required");
  });

  it("posts to /agent-ops/session/archive/:childId on success", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "archive", "ses_a"],
      {
        "POST /agent-ops/session/archive/ses_a": {
          status: 200, body: { archived: true },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].method).toBe("POST");
    expect(out.calls[0].path).toBe("/agent-ops/session/archive/ses_a");
    expect(out.stdout).toContain("archived:   true");
  });

  it("--json prints the broker response verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "archive", "ses_a", "--json"],
      {
        "POST /agent-ops/session/archive/ses_a": {
          status: 200, body: { archived: true, sessions: [] },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ archived: true });
  });

  it("surfaces a 409 'session is running' error from the orchestrator", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "archive", "ses_a"],
      {
        "POST /agent-ops/session/archive/ses_a": {
          status: 409, body: { error: "Cannot archive a running child session" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Cannot archive a running child session");
  });

  it("surfaces a 404 'not a descendant' verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "archive", "ses_other"],
      {
        "POST /agent-ops/session/archive/ses_other": {
          status: 404, body: { error: "Spawned session not found" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("not a descendant of this parent");
  });
});

// ---------------------------------------------------------------------------
// shipit source (docs/162) — read-only ShipIt source surface, Ops-only
// ---------------------------------------------------------------------------

describe("shipit source", () => {
  it("status prints the resolved ref and exactness", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "status"], {
      "GET /agent-ops/source/status": {
        status: 200,
        body: { available: true, ref: "abc123def456", exact: true, refSource: "build-id", remoteUrl: "https://github.com/acme/shipit.git" },
      },
    });
    expect(out.calls[0]).toMatchObject({ method: "GET", path: "/agent-ops/source/status" });
    expect(out.stdout).toContain("ref:        abc123def456");
    expect(out.stdout).toContain("exact:      true");
    expect(out.exitCode).toBe(0);
  });

  it("status warns and exits non-zero when unavailable", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "status"], {
      "GET /agent-ops/source/status": {
        status: 200,
        body: { available: false, exact: false, reason: "ShipIt source is unavailable: no git checkout at /opt/shipit." },
      },
    });
    expect(out.stderr).toContain("unavailable");
    expect(out.exitCode).toBe(1);
  });

  it("status flags an approximate ref", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "status"], {
      "GET /agent-ops/source/status": {
        status: 200,
        body: { available: true, ref: "deadbeef", exact: false, refSource: "checkout-head" },
      },
    });
    expect(out.stdout).toContain("approximate");
    expect(out.stdout).toContain("--approximate");
  });

  it("tree lists entries for a path", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "tree", "src/server"], {
      "GET /agent-ops/source/tree": {
        status: 200,
        body: { ref: "abc", path: "src/server", entries: [{ name: "orchestrator", type: "dir" }, { name: "index.ts", type: "file" }], truncated: false },
      },
    });
    expect(out.calls[0].path).toBe("/agent-ops/source/tree?path=src%2Fserver");
    expect(out.stdout).toContain("dir   orchestrator/");
    expect(out.stdout).toContain("file  index.ts");
  });

  it("search requires a query", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "search"]);
    expect(out.stderr).toContain("a query is required");
    expect(out.exitCode).not.toBe(0);
  });

  it("search passes q and --path through and renders matches", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "search", "ContainerSessionRunner", "--path", "src"], {
      "GET /agent-ops/source/search": {
        status: 200,
        body: { ref: "abc", query: "ContainerSessionRunner", matches: [{ path: "src/a.ts", line: 4, text: "class ContainerSessionRunner {" }], truncated: false },
      },
    });
    const q = out.calls[0].path;
    expect(q).toContain("q=ContainerSessionRunner");
    expect(q).toContain("path=src");
    expect(out.stdout).toContain("src/a.ts:4:class ContainerSessionRunner {");
  });

  it("cat prints file content", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "cat", "src/index.ts"], {
      "GET /agent-ops/source/cat": {
        status: 200,
        body: { ref: "abc", path: "src/index.ts", content: "export const x = 1;\n", truncated: false },
      },
    });
    expect(out.calls[0].path).toBe("/agent-ops/source/cat?path=src%2Findex.ts");
    expect(out.stdout).toBe("export const x = 1;\n");
    expect(out.exitCode).toBe(0);
  });

  it("cat requires a path", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "cat"]);
    expect(out.stderr).toContain("a file path is required");
    expect(out.exitCode).not.toBe(0);
  });

  it("log renders commit rows and passes path + --limit", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "log", "src/server", "--limit", "5"], {
      "GET /agent-ops/source/log": {
        status: 200,
        body: {
          ref: "abc", path: "src/server", truncated: false,
          commits: [
            { hash: "deadbeef1234", shortHash: "deadbeef1234", author: "Alice", date: "2026-01-02T03:04:05Z", subject: "Fix loop" },
          ],
        },
      },
    });
    const p = out.calls[0].path;
    expect(p).toContain("path=src%2Fserver");
    expect(p).toContain("limit=5");
    expect(out.stdout).toContain("deadbeef1234");
    expect(out.stdout).toContain("2026-01-02");
    expect(out.stdout).toContain("Fix loop");
    expect(out.exitCode).toBe(0);
  });

  it("blame requires a path and renders attributed lines", async () => {
    const { run } = makeRunner();
    const missing = await run(["source", "blame"]);
    expect(missing.stderr).toContain("a file path is required");
    expect(missing.exitCode).not.toBe(0);

    const out = await run(["source", "blame", "src/index.ts"], {
      "GET /agent-ops/source/blame": {
        status: 200,
        body: {
          ref: "abc", path: "src/index.ts", truncated: false,
          lines: [{ line: 1, shortHash: "deadbeef1234", author: "Alice", text: "export const x = 1;" }],
        },
      },
    });
    expect(out.calls[0].path).toBe("/agent-ops/source/blame?path=src%2Findex.ts");
    expect(out.stdout).toContain("deadbeef1234");
    expect(out.stdout).toContain("export const x = 1;");
  });

  it("show requires a commit and prints the diff", async () => {
    const { run } = makeRunner();
    const missing = await run(["source", "show"]);
    expect(missing.stderr).toContain("a commit is required");
    expect(missing.exitCode).not.toBe(0);

    const out = await run(["source", "show", "abc123", "src/a.ts"], {
      "GET /agent-ops/source/show": {
        status: 200,
        body: { ref: "abc123", path: "src/a.ts", content: "diff --git a/src/a.ts b/src/a.ts\n+new\n", truncated: false },
      },
    });
    const p = out.calls[0].path;
    expect(p).toContain("commit=abc123");
    expect(p).toContain("path=src%2Fa.ts");
    expect(out.stdout).toContain("diff --git a/src/a.ts");
    expect(out.exitCode).toBe(0);
  });

  it("rejects mutating source subcommands with a pointer to --shipit-source", async () => {
    const { run } = makeRunner();
    for (const sub of ["edit", "commit", "push", "checkout", "git"]) {
      const out = await run(["source", sub]);
      expect(out.stderr).toContain("read-only");
      expect(out.stderr).toContain("--shipit-source");
      expect(out.exitCode).not.toBe(0);
    }
  });

  it("forwards a 403 from a non-ops session", async () => {
    const { run } = makeRunner();
    const out = await run(["source", "status"], {
      "GET /agent-ops/source/status": {
        status: 403, body: { error: "ShipIt source access is only available in Ops sessions." },
      },
    });
    expect(out.stderr).toContain("only available in Ops sessions");
    expect(out.exitCode).toBe(1);
  });
});

describe("shipit session create --shipit-source (docs/162)", () => {
  it("forwards shipitSource and approximateSource in the payload", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["session", "create", "-p", "Fix the lifecycle loop", "--shipit-source", "--approximate"],
      {
        "POST /agent-ops/session/create": {
          status: 200, body: { sessionId: "ses_fix", branch: "shipit/x", status: "running" },
        },
      },
    );
    expect(out.calls[0].body).toMatchObject({
      prompt: "Fix the lifecycle loop",
      shipitSource: true,
      approximateSource: true,
    });
    expect(out.stdout).toContain("session-id: ses_fix");
  });

  it("rejects --approximate without --shipit-source", async () => {
    const { run } = makeRunner();
    const out = await run(["session", "create", "-p", "x", "--approximate"]);
    expect(out.stderr).toContain("--approximate only applies with --shipit-source");
    expect(out.exitCode).not.toBe(0);
  });
});
