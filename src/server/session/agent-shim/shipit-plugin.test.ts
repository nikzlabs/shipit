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
    // `status` was the unknown action this test used until docs/266 made it a
    // real verb — `logs` takes its place, and is still the one the issue asked
    // for and did not get.
    const { run } = makeRunner();
    expect((await run(["plugin", "logs"])).exitCode).not.toBe(0);
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

/**
 * docs/266 — the two additions the plugin author in nikzlabs/shipit#2323 needed:
 * a way to SEE why the live version is broken, and a way to RETRY it.
 *
 * The load-bearing parts are not the wording. `status` must be a GET on a
 * bounded transport (it activates nothing, and a diagnostic that can hang is
 * one an agent stops running); `--force` must never reach the orchestrator
 * without a repository name, because it discards a live version's install
 * output; and refresh must print the live version's own degradation even on the
 * round that found nothing to do — the exact case that exited 0 and said
 * `unchanged` while every surface of the plugin was failing.
 */
const STATUS = "GET /agent-ops/plugin/status";

const BROKEN_STATUS = {
  status: 200,
  body: {
    repos: [{
      repo: "tools",
      source: "acme/dev-tools",
      ref: "branch main",
      commit: "d".repeat(40),
      status: "active",
      issues: ["`web` declares an install command, which this runtime cannot run."],
      install: { commit: "d".repeat(40), at: "2026-08-16T10:00:00.000Z", outcome: "not-run" },
      installSummary: "install NOT RUN for ddddddddd (this runtime cannot run plugin installs)",
      usable: false,
    }],
    warnings: [],
  },
};

describe("shipit plugin status", () => {
  it("reads over a bounded GET — it activates nothing", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], { [STATUS]: BROKEN_STATUS });

    expect(res.calls[0]).toMatchObject({ method: "GET", path: "/agent-ops/plugin/status" });
    expect(res.calls[0]!.timeoutMs).toBeUndefined();
  });

  it("says the version is not usable, why, and what the install did", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], { [STATUS]: BROKEN_STATUS });

    expect(res.stdout).toContain("NOT USABLE");
    expect(res.stdout).toContain("ddddddddd");
    expect(res.stdout).toContain("install NOT RUN");
    expect(res.stdout).toContain("cannot run");
  });

  it("exits 0 for a broken plugin: asking succeeded, the answer is bad news", async () => {
    // An agent diagnosing a failure must be able to run this without its own
    // tooling treating the diagnosis as a second failure.
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], { [STATUS]: BROKEN_STATUS });
    expect(res.exitCode).toBe(0);
  });

  it("passes a named repository as a query parameter", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "status", "tools"], { [STATUS]: BROKEN_STATUS });
    expect(res.calls[0]!.path).toBe("/agent-ops/plugin/status?repo=tools");
  });

  it("emits the orchestrator's own object under --json", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "status", "--json"], { [STATUS]: BROKEN_STATUS });
    expect(JSON.parse(res.stdout)).toMatchObject({ repos: [{ usable: false }] });
  });

  it("reports an unusable version as unusable when the field is missing", async () => {
    // A reader that cannot tell must not report "fine".
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], {
      [STATUS]: { status: 200, body: { repos: [{ repo: "tools", status: "active" }], warnings: [] } },
    });
    expect(res.stdout).toContain("NOT USABLE");
  });

  it("does not point a mid-refresh repository at --force", async () => {
    // `activating` is also `usable: false`, but it is not a broken version and
    // must not read like one.
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], {
      [STATUS]: {
        status: 200,
        body: {
          repos: [{ repo: "tools", status: "activating", usable: false, installSummary: "n/a" }],
          warnings: [],
        },
      },
    });
    expect(res.stdout).toContain("a round is in progress");
    expect(res.stdout).not.toContain("NOT USABLE");
  });
});


describe("shipit plugin refresh --force", () => {
  it("refuses without a repository name, and never calls the orchestrator", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--force"], { [REFRESH]: MOVED });

    expect(res.exitCode).not.toBe(0);
    expect(res.calls).toHaveLength(0);
    expect(res.stderr).toContain("needs the name of one plugin repository");
  });

  it("forwards force with the repository name", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "tools", "--force"], { [REFRESH]: MOVED });
    expect(res.calls[0]!.body).toEqual({ repo: "tools", force: true });
  });

  it("does not send force when it was not asked for", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "tools"], { [REFRESH]: MOVED });
    expect(res.calls[0]!.body).toEqual({ repo: "tools" });
  });
});

describe("shipit plugin refresh — the live version's own degradation", () => {
  it("prints it on a round that found nothing to do, and still exits 0", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], {
      [REFRESH]: {
        status: 200,
        body: {
          rows: [{
            repo: "tools", ref: "branch main",
            before: "e".repeat(40), after: "e".repeat(40), status: "unchanged",
            degraded: ["`web` declares an install command, which this runtime cannot run."],
          }],
        },
      },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("already at eeeeeeeee");
    expect(res.stdout).toContain("cannot run");
    expect(res.stdout).toContain("shipit plugin status");
  });

  it("says nothing extra when the live version is fine", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], { [REFRESH]: MOVED });
    expect(res.stdout).not.toContain("shipit plugin status");
  });
});
