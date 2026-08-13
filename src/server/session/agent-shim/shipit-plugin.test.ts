/**
 * Unit tests for `shipit plugin refresh` (docs/262 req 12).
 *
 * Two things here are load-bearing beyond the output text. The transport must
 * be UNBOUNDED — a refresh can fetch a repository and run that plugin's install,
 * so a default deadline would abort work that is still running and report a
 * failure that did not happen. And a failed refresh must exit non-zero while
 * still naming the commit that is LIVE: req 15 keeps the prior generation
 * serving, so the agent's real problem is that it is working against the old
 * version, not that the session is broken.
 */

import { describe, it, expect } from "vitest";
import { runShim, type ShimIO } from "./shipit.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  timeoutMs?: number;
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

  async function run(argv: string[], responses: Record<string, { status: number; body: Record<string, unknown> }> = {}) {
    stdout = ""; stderr = ""; exitCode = null; calls.length = 0;
    const fakeCall = async (
      method: string, path: string, body: unknown, _env: unknown, timeoutMs?: number,
    ) => {
      calls.push({ method, path, body, timeoutMs });
      return responses[`${method} ${path.split("?")[0]}`] ?? { status: 200, body: { rows: [] } };
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

const REFRESH = "POST /agent-ops/plugin/refresh";
const MOVED = {
  status: 200,
  body: {
    rows: [{
      repo: "tools", ref: "branch main",
      before: "a".repeat(40), after: "b".repeat(40), status: "activated",
    }],
  },
};

describe("shipit plugin refresh", () => {
  it("prints the before and after commit, and exits 0", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], { [REFRESH]: MOVED });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("tools (branch main)");
    expect(res.stdout).toContain("aaaaaaaaa");
    expect(res.stdout).toContain("bbbbbbbbb");
  });

  it("goes through agent-ops on the UNBOUNDED transport", async () => {
    // Not the browser's /api/plugin-repos (a snapshot GET must never activate
    // anything), and not a bounded call (a refresh can run a plugin's install).
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], { [REFRESH]: MOVED });

    expect(res.calls[0]).toMatchObject({
      method: "POST",
      path: "/agent-ops/plugin/refresh",
      timeoutMs: 0,
    });
  });

  it("passes a named repository through, and omits it when unnamed", async () => {
    const { run } = makeRunner();
    expect((await run(["plugin", "refresh", "tools"], { [REFRESH]: MOVED })).calls[0]!.body)
      .toEqual({ repo: "tools" });
    expect((await run(["plugin", "refresh"], { [REFRESH]: MOVED })).calls[0]!.body)
      .toEqual({});
  });

  it("says a repository is already current rather than inventing a change", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], {
      [REFRESH]: {
        status: 200,
        body: {
          rows: [{
            repo: "tools", ref: "branch main",
            before: "c".repeat(40), after: "c".repeat(40), status: "unchanged",
          }],
        },
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("already at ccccccccc");
  });

  it("exits non-zero on a failure, and names the commit still live", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], {
      [REFRESH]: {
        status: 200,
        body: {
          rows: [{
            repo: "tools", ref: "branch main",
            before: "d".repeat(40), after: "d".repeat(40),
            status: "failed", detail: "could not fetch: authorization failed",
          }],
        },
      },
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("refresh failed");
    // The half that matters: the session still works, on the OLD version.
    expect(res.stderr).toContain("still on ddddddddd");
    expect(res.stderr).toContain("authorization failed");
  });

  it("surfaces the server's own message for a repository that is not declared", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "ghost"], {
      [REFRESH]: {
        status: 400,
        body: { error: "`ghost` is not a declared plugin repository. This project declares `tools`." },
      },
    });

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("`ghost`");
    expect(res.stderr).toContain("`tools`");
  });

  it("says so plainly when the project declares no plugin repositories", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], { [REFRESH]: { status: 200, body: { rows: [] } } });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("declares no tracked plugin repositories");
  });

  it("emits machine-readable rows with --json", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--json"], { [REFRESH]: MOVED });
    expect(JSON.parse(res.stdout).rows[0].repo).toBe("tools");
  });

  it("rejects an unknown action and a second positional", async () => {
    const { run } = makeRunner();
    expect((await run(["plugin", "status"])).exitCode).not.toBe(0);
    expect((await run(["plugin", "refresh", "a", "b"])).exitCode).not.toBe(0);
  });

  it("rejects a typo instead of silently refreshing everything", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--bogus"], { [REFRESH]: MOVED });

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--bogus");
    // And nothing was refreshed on the way to that error.
    expect(res.calls).toHaveLength(0);
  });

  it("prints help for -h rather than refreshing", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "-h"], { [REFRESH]: MOVED });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: shipit plugin refresh");
    expect(res.calls).toHaveLength(0);
  });
});

/**
 * `shipit plugin exec` (docs/262 req 17) — the other end of a generated
 * wrapper. Its whole job is to be a transparent pipe, so the properties worth
 * asserting are the ones a wrapper would break by being clever: the plugin's
 * own argv survives untouched past `--`, its output is not decorated, and its
 * exit code is the shim's.
 */
const EXEC = "POST /agent-ops/plugin/exec";

describe("shipit plugin exec", () => {
  it("passes the plugin's argv through `--` untouched, on the unbounded transport", async () => {
    const { run } = makeRunner();
    const res = await run(
      ["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--", "list", "--json", "--alias", "x"],
      { [EXEC]: { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } } },
    );

    expect(res.calls[0]).toMatchObject({ method: "POST", path: "/agent-ops/plugin/exec", timeoutMs: 0 });
    // `--json` and `--alias` after the separator are the PLUGIN's flags. Parsing
    // them here would silently rewrite the command the agent asked for.
    expect((res.calls[0].body as { args: string[] }).args).toEqual(["list", "--json", "--alias", "x"]);
    expect(res.calls[0].body).toMatchObject({ alias: "reqs", command: "reqs" });
  });

  it("is a pipe: the command's own streams and its own exit code", async () => {
    const { run } = makeRunner();
    const res = await run(
      ["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--"],
      { [EXEC]: { status: 200, body: { exitCode: 3, stdout: "out", stderr: "err" } } },
    );

    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.exitCode).toBe(3);
  });

  // A ShipIt REFUSAL rides a 2xx — the route answers in the command's own shape
  // so a caller never has to tell a transport failure from a command failure.
  // The shim therefore has to print `error` itself, and did not: the agent got
  // exit 126 with no output at all (review finding).
  it("prints a refusal that arrives on a 2xx, and keeps its exit code", async () => {
    const { run } = makeRunner();
    const res = await run(
      ["plugin", "exec", "--alias", "ghost", "--command", "reqs", "--"],
      {
        [EXEC]: {
          status: 200,
          body: { error: "`ghost` is not a plugin this project imports", exitCode: 126, stdout: "", stderr: "" },
        },
      },
    );

    expect(res.exitCode).toBe(126);
    expect(res.stderr).toContain("is not a plugin this project imports");
    expect(res.stdout).toBe("");
  });

  it("reports a transport failure as ShipIt's, not as the command's output", async () => {
    const { run } = makeRunner();
    const res = await run(
      ["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--"],
      { [EXEC]: { status: 502, body: { error: "the orchestrator is restarting" } } },
    );

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("the orchestrator is restarting");
  });

  it("refuses a call with no alias or command rather than guessing", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "exec", "--alias", "reqs"], {});
    expect(res.exitCode).not.toBe(0);
    expect(res.calls).toHaveLength(0);
  });
});
