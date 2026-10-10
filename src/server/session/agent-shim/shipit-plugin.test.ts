
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
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

  async function run(
    argv: string[],
    responses: Record<string, BrokerResponse | (() => BrokerResponse | Promise<BrokerResponse>)> = {},
    timing?: { sleep?: (ms: number) => Promise<void> },
  ) {
    stdout = ""; stderr = ""; exitCode = null; calls.length = 0;
    const fakeCall = async (
      method: string, path: string, body: unknown, _env: unknown, timeoutMs?: number,
    ) => {
      calls.push({ method, path, body, timeoutMs });
      const response = responses[`${method} ${path.split("?")[0]}`] ?? { status: 200, body: { rows: [] } };
      return typeof response === "function" ? response() : response;
    };
    try {
      await runShim(argv, io, {}, fakeCall as never, timing);
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode, calls: [...calls] };
  }

  return { run, calls };
}

interface BrokerResponse {
  status: number;
  body: Record<string, unknown>;
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
    expect((await run(["plugin", "logs"])).exitCode).not.toBe(0);
    expect((await run(["plugin", "refresh", "a", "b"])).exitCode).not.toBe(0);
  });

  it("rejects a typo instead of silently refreshing everything", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--bogus"], { [REFRESH]: MOVED });

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--bogus");
    expect(res.calls).toHaveLength(0);
  });

  it("prints help for -h rather than refreshing", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "-h"], { [REFRESH]: MOVED });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: shipit plugin refresh");
    expect(res.calls).toHaveLength(0);
  });

  it("names both plugin docs, so the reader can pick the right one", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("/shipit-docs/plugins.md");
    expect(res.stdout).toContain("/shipit-docs/plugin-authoring.md");
    expect(res.calls).toHaveLength(0);
  });
});

const EXEC = "POST /agent-ops/plugin/exec";
const EXEC_STDIN = "POST /agent-ops/plugin/exec/stdin";

function useStdin(opts: { tty?: boolean } = {}): PassThrough {
  const stdin = new PassThrough();
  if (opts.tty) Object.assign(stdin, { isTTY: true });
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  return stdin;
}

describe("shipit plugin exec", () => {
  // The test runner's own stdin is open and sends nothing.
  beforeEach(() => {
    useStdin().end();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the plugin's argv through `--` untouched, on the unbounded transport", async () => {
    const { run } = makeRunner();
    const res = await run(
      ["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--", "list", "--json", "--alias", "x"],
      { [EXEC]: { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } } },
    );

    expect(res.calls[0]).toMatchObject({ method: "POST", path: "/agent-ops/plugin/exec", timeoutMs: 0 });
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

  const ARGV = ["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--"];
  const DONE: BrokerResponse = { status: 200, body: { exitCode: 0, stdout: "", stderr: "" } };
  const ACCEPTED: BrokerResponse = { status: 200, body: { accepted: true } };
  const noWait = { sleep: () => Promise.resolve() };

  // A call that does not finish before the test says so, as a command that runs for a while.
  function pendingExec(): { response: () => Promise<BrokerResponse>; finish: () => void } {
    let finish: () => void = () => undefined;
    const done = new Promise<BrokerResponse>((resolve) => { finish = () => resolve(DONE); });
    return { response: () => done, finish: () => finish() };
  }

  const stdinParts = (calls: RecordedCall[]): unknown[] =>
    calls.filter((c) => c.path === "/agent-ops/plugin/exec/stdin").map((c) => c.body);

  it("sends input that ended at once with the call, in one request", async () => {
    useStdin().end("line one\nline two\n");
    const { run } = makeRunner();

    const res = await run(ARGV, { [EXEC]: DONE });

    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].body).toMatchObject({ stdin: "line one\nline two\n" });
    expect(res.calls[0].body).not.toHaveProperty("stdinId");
  });

  it("sends a terminal's stdin as no input, and does not read it", async () => {
    const stdin = useStdin({ tty: true });
    const { run } = makeRunner();

    const res = await run(ARGV, { [EXEC]: DONE });

    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].body).toMatchObject({ stdin: "" });
    expect(stdin.readableFlowing).toBeNull();
  });

  it("sends the call after a wait too short to notice when stdin is open and sends nothing", async () => {
    useStdin();
    const { run } = makeRunner();
    const waits: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };

    const res = await run(ARGV, { [EXEC]: { status: 200, body: { exitCode: 4, stdout: "out", stderr: "" } } }, { sleep });

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0].body).not.toHaveProperty("stdin");
    expect((res.calls[0].body as { stdinId: string }).stdinId).toMatch(/\S/);
    expect(res.stdout).toBe("out");
    expect(res.exitCode).toBe(4);
  });

  it("delivers input that starts after the call was sent, in order, and then the end", async () => {
    const stdin = useStdin();
    const { run, calls } = makeRunner();
    const exec = pendingExec();

    const running = run(ARGV, { [EXEC]: exec.response, [EXEC_STDIN]: ACCEPTED }, noWait);
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    stdin.write("late one\n");
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    stdin.end("late two\n");
    await vi.waitFor(() => { expect(calls).toHaveLength(4); });
    exec.finish();
    const res = await running;

    const id = (res.calls[0].body as { stdinId: string }).stdinId;
    expect(stdinParts(res.calls)).toEqual([
      { id, seq: 0, data: "late one\n", end: false },
      { id, seq: 1, data: "late two\n", end: false },
      { id, seq: 2, data: "", end: true },
    ]);
    expect(res.calls.every((c) => c.timeoutMs === 0)).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("sends input that is too large for one request in parts, although it ended at once", async () => {
    const large = "0123456789abcdef".repeat(20 * 1024);
    useStdin().end(large);
    const { run, calls } = makeRunner();
    const exec = pendingExec();

    const running = run(ARGV, { [EXEC]: exec.response, [EXEC_STDIN]: ACCEPTED });
    await vi.waitFor(() => { expect(stdinParts(calls).at(-1)).toMatchObject({ end: true }); });
    exec.finish();
    const res = await running;

    const parts = stdinParts(res.calls) as { seq: number; data: string }[];
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((p) => p.data).join("")).toBe(large);
    expect(Math.max(...parts.map((p) => p.data.length))).toBeLessThanOrEqual(128 * 1024);
    expect(parts.map((p) => p.seq)).toEqual(parts.map((_, i) => i));
    expect(res.calls[0].body).not.toHaveProperty("stdin");
  });

  it("reads little more input than one request holds before it sends the call", async () => {
    // A producer that does not stop, in chunks of 64 Ki characters, as a pipe gives them.
    const CHUNK = 64 * 1024;
    let produced = 0;
    const stdin = new Readable({
      read() {
        produced += CHUNK;
        this.push("x".repeat(CHUNK));
      },
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const { run } = makeRunner();
    // A wait that never ends: only the size of the input can send the call.
    const sleep = (): Promise<void> => new Promise(() => undefined);
    let producedAtCall = -1;

    const res = await run(ARGV, {
      [EXEC]: () => {
        producedAtCall = produced;
        return DONE;
      },
      [EXEC_STDIN]: { status: 200, body: { accepted: false } },
    }, { sleep });
    stdin.destroy();

    expect(res.calls[0]).toMatchObject({ path: "/agent-ops/plugin/exec" });
    expect(res.calls[0].body).not.toHaveProperty("stdin");
    // One request holds 128 Ki; the read that passes it and what the stream reads ahead are the rest.
    expect(producedAtCall).toBeGreaterThan(128 * 1024);
    expect(producedAtCall).toBeLessThanOrEqual(128 * 1024 + 3 * CHUNK);
  });

  it("sends the next part only when the last one was answered", async () => {
    const stdin = useStdin();
    const { run, calls } = makeRunner();
    const exec = pendingExec();
    let answer: () => void = () => undefined;
    const held = new Promise<BrokerResponse>((resolve) => { answer = () => resolve(ACCEPTED); });

    const running = run(ARGV, { [EXEC]: exec.response, [EXEC_STDIN]: () => held }, noWait);
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    stdin.write("first\n");
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    stdin.write("second\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stdinParts(calls)).toHaveLength(1);

    answer();
    await vi.waitFor(() => { expect(stdinParts(calls)).toHaveLength(2); });
    exec.finish();
    await running;
  });

  it("does not cut a character in two between parts", async () => {
    // One character of two code units, placed across the size of a part.
    const text = `${"a".repeat(128 * 1024 - 1)}\u{1F600}tail`;
    useStdin().end(text);
    const { run, calls } = makeRunner();
    const exec = pendingExec();

    const running = run(ARGV, { [EXEC]: exec.response, [EXEC_STDIN]: ACCEPTED });
    await vi.waitFor(() => { expect(stdinParts(calls).at(-1)).toMatchObject({ end: true }); });
    exec.finish();
    const res = await running;

    const parts = (stdinParts(res.calls) as { data: string }[]).map((p) => p.data);
    expect(parts.map((data) => Buffer.from(data, "utf8").toString("utf8")).join("")).toBe(text);
    expect(parts.join("")).toBe(text);
  });

  it("stops sending when the command takes no more input", async () => {
    const stdin = useStdin();
    const { run, calls } = makeRunner();
    const exec = pendingExec();

    const running = run(
      ARGV,
      { [EXEC]: exec.response, [EXEC_STDIN]: { status: 200, body: { accepted: false } } },
      noWait,
    );
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    stdin.write("not taken\n");
    await vi.waitFor(() => { expect(calls).toHaveLength(2); });
    stdin.end("never sent\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    exec.finish();
    const res = await running;

    expect(stdinParts(res.calls)).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("says so, and does not report success, when it could not deliver the input", async () => {
    const stdin = useStdin();
    const { run, calls } = makeRunner();
    const exec = pendingExec();

    const running = run(
      ARGV,
      { [EXEC]: exec.response, [EXEC_STDIN]: { status: 502, body: { error: "the orchestrator is restarting" } } },
      noWait,
    );
    await vi.waitFor(() => { expect(calls).toHaveLength(1); });
    stdin.write("lost\n");
    const res = await running;

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Could not deliver stdin to `reqs`");
    expect(res.stderr).toContain("the orchestrator is restarting");
  });

  const TIMED = {
    status: 200,
    body: {
      exitCode: 0,
      stdout: "out",
      stderr: "",
      timings: {
        prepareMs: 41, networkMs: 12, networkReused: true,
        createMs: 62, startMs: 310, commandMs: 95, cleanupMs: 120,
      },
    },
  };

  it("says where the call's time went when SHIPIT_PLUGIN_TIMING is set, on stderr only", async () => {
    vi.stubEnv("SHIPIT_PLUGIN_TIMING", "1");
    try {
      const { run } = makeRunner();
      const res = await run(["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--"], { [EXEC]: TIMED });

      expect(res.stdout).toBe("out");
      expect(res.stderr).toBe(
        "[shipit] plugin exec timing: prepare 41 ms, network 12 ms (reused), create 62 ms, "
        + "start 310 ms, command 95 ms, cleanup 120 ms\n",
      );
      expect(res.exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("adds nothing to the command's streams without it", async () => {
    vi.stubEnv("SHIPIT_PLUGIN_TIMING", "");
    try {
      const { run } = makeRunner();
      const res = await run(["plugin", "exec", "--alias", "reqs", "--command", "reqs", "--"], { [EXEC]: TIMED });

      expect(res.stdout).toBe("out");
      expect(res.stderr).toBe("");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

  it("prints a dependency-store notice as a cost, not as a problem", async () => {
    const { run } = makeRunner();
    const notice = "Dependencies are installed from scratch in every session and never shared: "
      + "`web`'s install command is not one ShipIt can identify the inputs of.";
    const res = await run(["plugin", "status"], {
      [STATUS]: {
        status: 200,
        body: {
          repos: [{
            ...BROKEN_STATUS.body.repos[0],
            issues: [],
            usable: true,
            depStoreNotice: notice,
          }],
          warnings: [],
        },
      },
    });

    expect(res.stdout).toContain(`~ ${notice}`);
    expect(res.stdout).not.toContain(`! ${notice}`);
    expect(res.stdout).toContain("usable");
  });

  it("exits 0 for a broken plugin: asking succeeded, the answer is bad news", async () => {
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
    const { run } = makeRunner();
    const res = await run(["plugin", "status"], {
      [STATUS]: { status: 200, body: { repos: [{ repo: "tools", status: "active" }], warnings: [] } },
    });
    expect(res.stdout).toContain("NOT USABLE");
  });

  it("does not point a mid-refresh repository at --force", async () => {
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

const INSTALLED = {
  status: 200,
  body: {
    rows: [{
      repo: "tools", ref: "branch main",
      before: "e".repeat(40), after: "e".repeat(40), status: "unchanged",
      install: {
        commit: "e".repeat(40),
        at: "2026-08-16T12:00:00.000Z",
        outcome: "succeeded",
        output: "added 41 packages\nbuilt dist/index.js",
      },
    }],
  },
};

describe("shipit plugin refresh — the last install's output", () => {
  it("emits a successful install's output under --json", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--json"], { [REFRESH]: INSTALLED });

    const install = JSON.parse(res.stdout).rows[0].install;
    expect(install.outcome).toBe("succeeded");
    expect(install.output).toContain("built dist/index.js");
    expect(install.commit).toBe("e".repeat(40));
  });

  it("keeps it out of the human output, which is a status line and not a log", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh"], { [REFRESH]: INSTALLED });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("already at eeeeeeeee");
    expect(res.stdout).not.toContain("built dist/index.js");
  });

  it("drops a record with no commit rather than printing an invented one", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "--json"], {
      [REFRESH]: {
        status: 200,
        body: {
          rows: [{
            repo: "tools", ref: "branch main", before: null, after: "e".repeat(40),
            status: "activated",
            install: { outcome: "succeeded", output: "added 41 packages" },
          }],
        },
      },
    });
    expect(JSON.parse(res.stdout).rows[0].install).toBeUndefined();
  });

  it("tells the reader the flag exists", async () => {
    const { run } = makeRunner();
    const res = await run(["plugin", "refresh", "-h"]);
    expect(res.stdout).toContain("--json");
    expect(res.stdout).toContain("PRINTED");
  });
});
