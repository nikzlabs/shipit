/**
 * Unit tests for the `gh` shim. Covers:
 * - argument parsing
 * - allowlist enforcement (rejected subcommands, --repo, --web)
 * - happy paths for each supported subcommand
 * - error formatting (auth, validation, unknown PR)
 * - exit codes
 *
 * The shim talks to the worker over HTTP. Tests inject a fake `call` function
 * so we never actually open a socket.
 */

import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runShim, parseFlags, type ShimIO } from "./gh.js";

interface RecordedCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Build a test harness. Returns the io capture, a recorder for calls, and a
 * `runner(argv, responses)` function. `responses` is keyed by `${method} ${path}`
 * and lets a single test queue specific results for the broker.
 */
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
      // Default: 200 with empty body so handlers fall through to "no PR" cases
      return { status: 200, body: { pr: null, prs: [] } };
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

describe("parseFlags", () => {
  it("parses positional + value flags + boolean flags", () => {
    const out = parseFlags(["42", "-t", "Title", "--draft"], {
      values: { "-t": "title" },
      booleans: { "--draft": "draft" },
    });
    expect(out.positional).toEqual(["42"]);
    expect(out.values).toEqual({ title: "Title" });
    expect(out.booleans.has("draft")).toBe(true);
  });

  it("supports --flag=value form", () => {
    const out = parseFlags(["--title=Hello"], { values: { "--title": "title" } });
    expect(out.values.title).toBe("Hello");
  });

  it("flags missing values are tracked as unsupported", () => {
    const out = parseFlags(["-t"], { values: { "-t": "title" } });
    expect(out.unsupported.length).toBe(1);
  });

  it("unknown flags appear in unsupported", () => {
    const out = parseFlags(["--mystery", "value"], { values: {} });
    expect(out.unsupported).toContain("--mystery");
  });

  it("collects repeated array flags in order", () => {
    const out = parseFlags(["--label", "a", "--label", "b"], {
      arrays: { "--label": "label" },
    });
    expect(out.arrays.label).toEqual(["a", "b"]);
  });

  it("supports --label=value form for array flags", () => {
    const out = parseFlags(["--label=feature", "-l", "bug"], {
      arrays: { "--label": "label", "-l": "label" },
    });
    expect(out.arrays.label).toEqual(["feature", "bug"]);
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
    expect(out.exitCode).toBe(0);
  });

  it("prints help on --help", async () => {
    const { run } = makeRunner();
    const out = await run(["--help"]);
    expect(out.stdout).toContain("Supported subcommands");
    expect(out.exitCode).toBe(0);
  });

  it("prints help on `gh pr` (no subcommand)", async () => {
    const { run } = makeRunner();
    const out = await run(["pr"]);
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
  it.each([
    ["api"],
    ["repo"],
    ["release"],
    ["workflow"],
    ["auth"],
    ["secret"],
    ["ssh-key"],
    ["codespace"],
    ["extension"],
    ["issue"],
    ["gist"],
    ["run"],
  ])("rejects gh %s with helpful error", async (sub) => {
    const { run } = makeRunner();
    const out = await run([sub]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(`Tried: gh ${sub}`);
    expect(out.stderr).toContain("/shipit-docs/github.md");
  });

  it("rejects unknown top-level subcommands", async () => {
    const { run } = makeRunner();
    const out = await run(["nonsense"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unknown gh subcommand");
  });

  it("rejects unsupported pr subcommand", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "merge"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unsupported gh pr subcommand");
  });

  it("rejects --repo on every subcommand", async () => {
    const { run } = makeRunner();
    for (const cmd of [["pr", "create"], ["pr", "view"], ["pr", "list"], ["pr", "comment", "-b", "x"]]) {
      const out = await run([...cmd, "--repo", "other/r"]);
      expect(out.exitCode).not.toBe(0);
      expect(out.stderr).toContain("does not support the --repo");
    }
  });

  it("rejects --web on pr create and pr view", async () => {
    const { run } = makeRunner();
    expect((await run(["pr", "create", "--web"])).exitCode).not.toBe(0);
    expect((await run(["pr", "view", "--web"])).exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gh pr create
// ---------------------------------------------------------------------------

describe("gh pr create", () => {
  it("posts to /agent-ops/pr/create with title + body and prints URL", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "My PR", "-b", "Body text"],
      {
        "POST /agent-ops/pr/create": {
          status: 200,
          body: { url: "https://github.com/x/y/pull/1", number: 1 },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("https://github.com/x/y/pull/1");
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].method).toBe("POST");
    expect(out.calls[0].path).toBe("/agent-ops/pr/create");
    expect(out.calls[0].body).toMatchObject({
      title: "My PR",
      body: "Body text",
      draft: false,
      fill: false,
    });
  });

  it("forwards --draft and --fill", async () => {
    const { run } = makeRunner();
    await run(
      ["pr", "create", "-t", "T", "--draft", "--fill"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    // Run again to inspect — the previous run reset state on each run() call.
    const out = await run(
      ["pr", "create", "-t", "T", "--draft", "--fill"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].body).toMatchObject({ draft: true, fill: true });
  });

  it("forwards -B base", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "-B", "develop"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].body).toMatchObject({ base: "develop" });
  });

  it("reads markdown body from --body-file without shell-interpreting backticks", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shipit-gh-"));
    const bodyPath = path.join(tmpDir, "pr-body.md");
    const body = "## Summary\nPreserve markdown like `code` and $(literal).\n";
    await fsp.writeFile(bodyPath, body, "utf8");

    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--body-file", bodyPath],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );

    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ body });
  });

  it("forwards a single --label as a labels array", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--label", "feature"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ labels: ["feature"] });
  });

  it("forwards repeated --label/-l flags as a labels array", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--label", "feature", "-l", "enhancement"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].body).toMatchObject({ labels: ["feature", "enhancement"] });
  });

  it("splits comma-separated --label values and de-dupes", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--label", "feature,bug", "--label", "bug"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].body).toMatchObject({ labels: ["feature", "bug"] });
  });

  it("omits labels from the payload when none are given", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].body).not.toHaveProperty("labels");
  });

  it("prints a best-effort label warning on stderr but still exits 0 with the URL", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--label", "nope"],
      {
        "POST /agent-ops/pr/create": {
          status: 200,
          body: {
            url: "https://github.com/x/y/pull/1",
            labelWarning: "Warning: could not apply label(s) nope: not found. The PR was still created/updated.",
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("https://github.com/x/y/pull/1");
    expect(out.stderr).toContain("could not apply label(s) nope");
  });

  it("still rejects a genuinely unsupported flag", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "create", "-t", "T", "--assignee", "octocat"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Unsupported flag for gh pr create");
  });

  it("rejects using both --body and --body-file", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "create", "-t", "T", "-b", "Body", "--body-file", "body.md"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("use either -b/--body or --body-file");
  });

  it("notes 'existing PR' on stderr when alreadyExisted is true", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "-b", "B"],
      {
        "POST /agent-ops/pr/create": {
          status: 200,
          body: { url: "https://github.com/x/y/pull/2", alreadyExisted: true },
        },
      },
    );
    expect(out.stderr).toContain("Existing PR");
    expect(out.stdout.trim()).toBe("https://github.com/x/y/pull/2");
    expect(out.exitCode).toBe(0);
  });

  it("formats 401 errors with a 'connect GitHub' hint", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T"],
      {
        "POST /agent-ops/pr/create": {
          status: 401,
          body: { error: "Not authenticated with GitHub" },
        },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("connect GitHub");
  });

  it("propagates 400 errors verbatim", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T"],
      {
        "POST /agent-ops/pr/create": { status: 400, body: { error: "PR title too long" } },
      },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("PR title too long");
  });
});

// ---------------------------------------------------------------------------
// gh pr edit / comment / ready / close / reopen
// ---------------------------------------------------------------------------

describe("gh pr edit", () => {
  it("requires -t or -b", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "edit", "5"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("provide a title");
  });

  it("PATCHes /agent-ops/pr/N when number is given", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "-t", "New title"],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.calls[0].method).toBe("PATCH");
    expect(out.calls[0].path).toBe("/agent-ops/pr/5");
    expect(out.calls[0].body).toMatchObject({ title: "New title" });
    expect(out.exitCode).toBe(0);
  });

  it("falls back to current branch's PR when no number is passed", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "-b", "Updated body"],
      {
        "GET /agent-ops/pr/status": { status: 200, body: { pr: { number: 7 } } },
        "PATCH /agent-ops/pr/7": { status: 200, body: { url: "u", number: 7 } },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls.find((c) => c.method === "PATCH")?.path).toBe("/agent-ops/pr/7");
  });

  it("forwards --label without requiring a title or body", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--label", "documentation"],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ labels: ["documentation"] });
  });

  it("still errors when neither title, body, nor label is given", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "edit", "5"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("provide a title");
  });
});

describe("gh pr comment", () => {
  it("requires -b/--body", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "comment", "9"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("required");
  });

  it("POSTs comment body to the right PR", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "comment", "9", "-b", "Hello"],
      { "POST /agent-ops/pr/9/comment": { status: 200, body: { commentUrl: "c" } } },
    );
    expect(out.calls[0].body).toEqual({ body: "Hello" });
    expect(out.exitCode).toBe(0);
  });

  it("reads update body from --body-file", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "shipit-gh-"));
    const bodyPath = path.join(tmpDir, "pr-body.md");
    await fsp.writeFile(bodyPath, "Updated `body`\n", "utf8");

    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--body-file", bodyPath],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.calls[0].body).toMatchObject({ body: "Updated `body`\n" });
    expect(out.exitCode).toBe(0);
  });
});

describe("gh pr ready / close / reopen", () => {
  it("ready POSTs to /ready", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "ready", "10"],
      { "POST /agent-ops/pr/10/ready": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].path).toBe("/agent-ops/pr/10/ready");
    expect(out.exitCode).toBe(0);
  });

  it("close POSTs to /close", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "close", "11"],
      { "POST /agent-ops/pr/11/close": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].path).toBe("/agent-ops/pr/11/close");
    expect(out.exitCode).toBe(0);
  });

  it("reopen requires a PR number explicitly", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "reopen"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("PR number is required");
  });

  it("reopen POSTs to /reopen", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "reopen", "12"],
      { "POST /agent-ops/pr/12/reopen": { status: 200, body: { url: "u" } } },
    );
    expect(out.calls[0].path).toBe("/agent-ops/pr/12/reopen");
    expect(out.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gh pr view / list / status
// ---------------------------------------------------------------------------

describe("gh pr view", () => {
  it("prints plain-text view when no --json", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "view", "3"],
      {
        "GET /agent-ops/pr/view": {
          status: 200,
          body: {
            pr: {
              title: "T", number: 3, head: "feat", base: "main",
              url: "https://github.com/x/y/pull/3", body: "Body", state: "open", isDraft: false,
            },
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("T #3");
    expect(out.stdout).toContain("https://github.com/x/y/pull/3");
  });

  it("prints filtered JSON when --json is requested", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "view", "--json", "title,number"],
      {
        "GET /agent-ops/pr/view": {
          status: 200,
          body: {
            pr: { title: "T", number: 3, head: "feat", base: "main", url: "u", body: "b", state: "open", isDraft: false },
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(parsed).toEqual({ title: "T", number: 3 });
  });

  it("exits non-zero when no PR is found", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "view"], {
      "GET /agent-ops/pr/view": { status: 200, body: { pr: null } },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("No pull request");
  });
});

describe("gh pr list", () => {
  it("prints JSON array when --json", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "list", "--json", "number,title"],
      {
        "GET /agent-ops/pr/list": {
          status: 200,
          body: {
            prs: [
              { number: 1, title: "A", state: "open", isDraft: false, head: "h", base: "b", url: "u" },
              { number: 2, title: "B", state: "open", isDraft: true, head: "h2", base: "b", url: "u2" },
            ],
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([
      { number: 1, title: "A" },
      { number: 2, title: "B" },
    ]);
  });

  it("prints plain text rows otherwise", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "list"],
      {
        "GET /agent-ops/pr/list": {
          status: 200,
          body: {
            prs: [
              { number: 1, title: "A", state: "open", isDraft: false, head: "h", base: "b", url: "u" },
            ],
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("#1");
    expect(out.stdout).toContain("A");
  });

  it("forwards --state to the broker", async () => {
    const { run } = makeRunner();
    await run(
      ["pr", "list", "--state", "closed"],
      { "GET /agent-ops/pr/list": { status: 200, body: { prs: [] } } },
    );
    // The path will include ?state=closed in the broker call
    const { run: run2 } = makeRunner();
    const out = await run2(
      ["pr", "list", "--state", "closed"],
      { "GET /agent-ops/pr/list": { status: 200, body: { prs: [] } } },
    );
    expect(out.calls[0].path).toContain("state=closed");
  });
});

describe("gh pr status", () => {
  it("reports 'No PR' when broker returns null", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "status"], {
      "GET /agent-ops/pr/status": { status: 200, body: { pr: null } },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("No PR");
  });

  it("prints title and url when a PR exists", async () => {
    const { run } = makeRunner();
    const out = await run(["pr", "status"], {
      "GET /agent-ops/pr/status": {
        status: 200,
        body: {
          pr: {
            title: "T", number: 4, headBranch: "h", baseBranch: "main",
            url: "https://github.com/x/y/pull/4",
          },
        },
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("T #4");
    expect(out.stdout).toContain("https://github.com/x/y/pull/4");
  });
});
