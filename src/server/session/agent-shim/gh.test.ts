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
    // docs/211 — the cwd `gh` ran in. The shim forwards it so the orchestrator
    // can resolve the repo-aware target. Fixed here so payloads are deterministic.
    cwd = "/workspace/myrepo",
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
      await runShim(argv, io, {}, fakeCall as never, cwd);
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
    ["auth"],
    ["secret"],
    ["ssh-key"],
    ["codespace"],
    ["extension"],
    ["issue"],
    ["gist"],
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

  it("forwards --add-label as an addLabels array without requiring a title or body", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--add-label", "enhancement"],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ addLabels: ["enhancement"] });
  });

  it("treats --label/-l as additive aliases for --add-label", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--label", "documentation"],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ addLabels: ["documentation"] });
  });

  it("forwards --remove-label as a removeLabels array", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--remove-label", "documentation"],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ removeLabels: ["documentation"] });
  });

  it("supports add and remove together, each repeated and comma-separated", async () => {
    const { run } = makeRunner();
    const out = await run(
      [
        "pr", "edit", "5",
        "--add-label", "enhancement,feature", "--add-label", "feature",
        "--remove-label", "documentation",
      ],
      { "PATCH /agent-ops/pr/5": { status: 200, body: { url: "u", number: 5 } } },
    );
    expect(out.exitCode).toBe(0);
    // De-duped and comma-split, mirroring `gh pr create --label`.
    expect(out.calls[0].body).toMatchObject({
      addLabels: ["enhancement", "feature"],
      removeLabels: ["documentation"],
    });
  });

  it("falls back to current branch's PR for a label-only edit", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "--add-label", "bug"],
      {
        "GET /agent-ops/pr/status": { status: 200, body: { pr: { number: 7 } } },
        "PATCH /agent-ops/pr/7": { status: 200, body: { url: "u", number: 7 } },
      },
    );
    expect(out.exitCode).toBe(0);
    const patch = out.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/agent-ops/pr/7");
    expect(patch?.body).toMatchObject({ addLabels: ["bug"] });
  });

  it("prints a best-effort label warning on stderr but still exits 0", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "edit", "5", "--add-label", "nope"],
      {
        "PATCH /agent-ops/pr/5": {
          status: 200,
          body: {
            url: "https://github.com/x/y/pull/5",
            number: 5,
            labelWarning: "Warning: could not apply label(s) nope: not found. The PR was still updated.",
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe("https://github.com/x/y/pull/5");
    expect(out.stderr).toContain("could not apply label(s) nope");
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
    expect(out.calls[0].body).toMatchObject({ body: "Hello" });
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

// ---------------------------------------------------------------------------
// Repo-aware brokering (docs/211) — cwd inference + --repo
// ---------------------------------------------------------------------------

describe("repo-aware brokering (docs/211)", () => {
  it("forwards the cwd in the create payload so the broker resolves the clone", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
      "/workspace/cloned-repo",
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ title: "T", cwd: "/workspace/cloned-repo" });
    // No --repo given, so the payload carries no explicit repo override.
    expect(out.calls[0].body).not.toHaveProperty("repo");
  });

  it("accepts --repo on create and forwards it (no longer rejected)", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "--repo", "octocat/hello"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ repo: "octocat/hello", cwd: "/workspace/myrepo" });
  });

  it("accepts -R as the --repo alias on create", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "create", "-t", "T", "-R", "octocat/hello"],
      { "POST /agent-ops/pr/create": { status: 200, body: { url: "u" } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ repo: "octocat/hello" });
  });

  it("forwards cwd and repo as query params on read ops (view/list/status)", async () => {
    const { run } = makeRunner();

    const view = await run(
      ["pr", "view", "3", "--repo", "octocat/hello"],
      { "GET /agent-ops/pr/view": { status: 200, body: { pr: { title: "T", number: 3, url: "u", body: "b" } } } },
      "/workspace/clone-a",
    );
    expect(view.calls[0].path).toContain("number=3");
    expect(view.calls[0].path).toContain("cwd=%2Fworkspace%2Fclone-a");
    expect(view.calls[0].path).toContain("repo=octocat%2Fhello");

    const list = await run(
      ["pr", "list", "--state", "closed"],
      { "GET /agent-ops/pr/list": { status: 200, body: { prs: [] } } },
      "/workspace/clone-b",
    );
    expect(list.calls[0].path).toContain("state=closed");
    expect(list.calls[0].path).toContain("cwd=%2Fworkspace%2Fclone-b");

    const status = await run(
      ["pr", "status"],
      { "GET /agent-ops/pr/status": { status: 200, body: { pr: null } } },
      "/workspace/clone-c",
    );
    expect(status.calls[0].path).toContain("cwd=%2Fworkspace%2Fclone-c");
  });

  it("forwards cwd/repo on the simple ops (ready/close/reopen) body", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "close", "11", "--repo", "octocat/hello"],
      { "POST /agent-ops/pr/11/close": { status: 200, body: { url: "u" } } },
      "/workspace/clone-x",
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].body).toMatchObject({ cwd: "/workspace/clone-x", repo: "octocat/hello" });
  });

  it("repo-aware status fallback when no PR number is given carries cwd/repo", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["pr", "comment", "--repo", "octocat/hello", "-b", "hi"],
      {
        "GET /agent-ops/pr/status": { status: 200, body: { pr: { number: 7 } } },
        "POST /agent-ops/pr/7/comment": { status: 200, body: { commentUrl: "c" } },
      },
      "/workspace/clone-y",
    );
    expect(out.exitCode).toBe(0);
    // The status lookup that resolved the PR number forwarded the target...
    const statusCall = out.calls.find((c) => c.path.startsWith("/agent-ops/pr/status"));
    expect(statusCall?.path).toContain("cwd=%2Fworkspace%2Fclone-y");
    expect(statusCall?.path).toContain("repo=octocat%2Fhello");
    // ...and the comment POST carried the same target in its body.
    const commentCall = out.calls.find((c) => c.path === "/agent-ops/pr/7/comment");
    expect(commentCall?.body).toMatchObject({ body: "hi", cwd: "/workspace/clone-y", repo: "octocat/hello" });
  });
});

// ---------------------------------------------------------------------------
// gh run list / view (read-only GitHub Actions)
// ---------------------------------------------------------------------------

describe("gh run list", () => {
  const RUN = {
    databaseId: 42, number: 7, displayTitle: "Deploy", workflowName: "CI",
    headBranch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success",
  };

  it("GETs /agent-ops/run/list and prints a tab-separated table", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "list"],
      { "GET /agent-ops/run/list": { status: 200, body: { runs: [RUN] } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("completed\tsuccess\tDeploy\tCI\tmain\tworkflow_dispatch\t42");
  });

  it("forwards --workflow/--branch/--status/--limit and cwd as query params", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "list", "-w", "ci.yml", "-b", "main", "-s", "failure", "-L", "5"],
      { "GET /agent-ops/run/list": { status: 200, body: { runs: [] } } },
      "/workspace/clone-z",
    );
    const path = out.calls[0].path;
    expect(path).toContain("workflow=ci.yml");
    expect(path).toContain("branch=main");
    expect(path).toContain("status=failure");
    expect(path).toContain("limit=5");
    expect(path).toContain("cwd=%2Fworkspace%2Fclone-z");
  });

  it("emits JSON filtered to --json fields", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "list", "--json", "databaseId,conclusion"],
      { "GET /agent-ops/run/list": { status: 200, body: { runs: [RUN] } } },
    );
    expect(JSON.parse(out.stdout)).toEqual([{ databaseId: 42, conclusion: "success" }]);
  });

  it("prints a friendly message when there are no runs", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "list"],
      { "GET /agent-ops/run/list": { status: 200, body: { runs: [] } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("No workflow runs found.");
  });
});

describe("gh run view", () => {
  it("renders run + jobs and omits the run id when none is given", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "view"],
      {
        "GET /agent-ops/run/view": {
          status: 200,
          body: {
            run: { displayTitle: "Deploy", workflowName: "CI", number: 7, status: "completed", conclusion: "failure", headBranch: "main", event: "push", url: "https://gh/run/42" },
            jobs: [{ name: "build", status: "completed", conclusion: "failure" }],
            logs: "",
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].path).not.toContain("id=");
    expect(out.stdout).toContain("Deploy · CI #7");
    expect(out.stdout).toContain("completed (failure)");
    expect(out.stdout).toContain("build");
  });

  it("forwards a run id and --log-failed as query params and prints logs", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "view", "42", "--log-failed"],
      {
        "GET /agent-ops/run/view": {
          status: 200,
          body: { run: { displayTitle: "X", workflowName: "CI", number: 1, status: "completed", conclusion: "failure" }, jobs: [], logs: "boom: error" },
        },
      },
    );
    expect(out.calls[0].path).toContain("id=42");
    expect(out.calls[0].path).toContain("logFailed=true");
    expect(out.stdout).toContain("boom: error");
  });

  it("merges jobs into the object for --json", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "view", "42", "--json", "conclusion,jobs"],
      {
        "GET /agent-ops/run/view": {
          status: 200,
          body: { run: { conclusion: "success" }, jobs: [{ name: "build" }], logs: "" },
        },
      },
    );
    expect(JSON.parse(out.stdout)).toEqual({ conclusion: "success", jobs: [{ name: "build" }] });
  });

  it("exits non-zero with a clear message when no run is found", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["run", "view"],
      { "GET /agent-ops/run/view": { status: 200, body: { run: null } } },
    );
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("No workflow run found.");
  });

  it("rejects --web", async () => {
    const { run } = makeRunner();
    const out = await run(["run", "view", "--web"]);
    expect(out.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gh workflow list / view (read-only)
// ---------------------------------------------------------------------------

describe("gh workflow list", () => {
  it("GETs /agent-ops/workflow/list and prints name/state/id", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["workflow", "list"],
      { "GET /agent-ops/workflow/list": { status: 200, body: { workflows: [{ id: 1, name: "CI", state: "active", path: ".github/workflows/ci.yml" }] } } },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("CI\tactive\t1");
  });
});

describe("gh workflow view", () => {
  it("requires a workflow argument", async () => {
    const { run } = makeRunner();
    const out = await run(["workflow", "view"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("a workflow name");
  });

  it("renders the workflow + recent runs and forwards the workflow query param", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["workflow", "view", "CI"],
      {
        "GET /agent-ops/workflow/view": {
          status: 200,
          body: {
            workflow: { id: 1, name: "CI", state: "active", path: ".github/workflows/ci.yml", url: "https://gh/wf/1" },
            runs: [{ status: "completed", conclusion: "success", displayTitle: "Deploy", headBranch: "main", databaseId: 42 }],
          },
        },
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.calls[0].path).toContain("workflow=CI");
    expect(out.stdout).toContain("CI (active)");
    expect(out.stdout).toContain("Recent runs:");
    expect(out.stdout).toContain("Deploy");
  });

  it("rejects --yaml with guidance to read the file from the workspace", async () => {
    const { run } = makeRunner();
    const out = await run(["workflow", "view", "CI", "--yaml"]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Read the workflow file from the workspace");
  });
});
