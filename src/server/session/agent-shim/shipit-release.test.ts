/**
 * Unit tests for `shipit release` (docs/214) — the deterministic release shim.
 * Verifies argument → payload mapping, the rejected `tag`/`publish`/`push`
 * subcommands, and result rendering. The shim talks to the worker over HTTP; we
 * inject a fake `call` so no socket is opened.
 */

import { describe, it, expect } from "vitest";
import { runShim, type ShimIO } from "./shipit.js";

interface RecordedCall { method: string; path: string; body: unknown }
interface MockResponse { status: number; body: Record<string, unknown> }

function makeRunner() {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const calls: RecordedCall[] = [];
  const io: ShimIO = {
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    exit: (code) => { exitCode = code; throw new Error("__shim_exit__"); },
  };

  async function run(argv: string[], responses: Record<string, MockResponse> = {}) {
    stdout = ""; stderr = ""; exitCode = null; calls.length = 0;
    const fakeCall = async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      const key = `${method} ${path.split("?")[0]}`;
      return responses[key] ?? { status: 200, body: {} };
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

describe("shipit release plan", () => {
  it("maps a bump + flags to the plan payload", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "plan", "minor", "--version-source-path", "packages/api/package.json"], {
      "POST /agent-ops/release/plan": {
        status: 200,
        body: { currentVersion: "0.3.0", version: "0.4.0", tag: "v0.4.0", bumpType: "minor", versionSource: "package.json", prerelease: false },
      },
    });
    expect(out.calls[0]?.path).toBe("/agent-ops/release/plan");
    expect(out.calls[0]?.body).toEqual({ bump: "minor", versionSourcePath: "packages/api/package.json" });
    expect(out.stdout).toContain("v0.4.0");
    expect(out.exitCode).toBe(0);
  });

  it("emits raw JSON with --json", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "plan", "--json"], {
      "POST /agent-ops/release/plan": { status: 200, body: { version: "1.0.0", tag: "v1.0.0" } },
    });
    expect(JSON.parse(out.stdout)).toEqual({ version: "1.0.0", tag: "v1.0.0" });
  });
});

describe("shipit release prepare", () => {
  it("maps --pick / --from / --release-branch to the prepare payload", async () => {
    const { run } = makeRunner();
    const out = await run(
      ["release", "prepare", "patch", "--pick", "abc123", "--pick", "def456", "--release-branch", "stable", "--notes", "hotfix"],
      {
        "POST /agent-ops/release/prepare": {
          status: 200,
          body: { kind: "pr-opened", version: "0.3.1", tag: "v0.3.1", releaseBranch: "stable", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", alreadyExisted: false },
        },
      },
    );
    expect(out.calls[0]?.body).toEqual({
      bump: "patch",
      pick: ["abc123", "def456"],
      releaseBranch: "stable",
      notes: "hotfix",
    });
    expect(out.stdout).toContain("opened release PR #7");
    expect(out.stdout).toContain("Merge the PR to publish");
  });

  it("maps --from / --allow-empty to the prepare payload", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare", "patch", "--from", "main", "--allow-empty"], {
      "POST /agent-ops/release/prepare": {
        status: 200,
        body: { kind: "pr-opened", version: "0.2.1", tag: "v0.2.1", releaseBranch: "stable", prNumber: 9, prUrl: "https://github.com/o/r/pull/9", alreadyExisted: false },
      },
    });
    expect(out.calls[0]?.body).toEqual({ bump: "patch", from: "main", allowEmpty: true });
    expect(out.stdout).toContain("opened release PR #9");
  });

  it("omits allowEmpty from the payload when --allow-empty is absent", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare", "patch", "--from", "main"], {
      "POST /agent-ops/release/prepare": {
        status: 200,
        body: { kind: "pr-opened", version: "0.2.1", tag: "v0.2.1", releaseBranch: "stable", prNumber: 9, prUrl: "https://github.com/o/r/pull/9", alreadyExisted: false },
      },
    });
    expect(out.calls[0]?.body).toEqual({ bump: "patch", from: "main" });
  });

  it("surfaces the content-free guard error (bare bump-only prepare)", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare", "patch"], {
      "POST /agent-ops/release/prepare": {
        status: 400,
        body: {
          error:
            'This release would contain no new commits — it would ship only the version bump, ' +
            'identical to what\'s already released on "stable". Pass --from <branch> (e.g. --from main) ' +
            "to bring content into the release, or --allow-empty to cut a bump-only release on purpose.",
        },
      },
    });
    expect(out.stderr).toContain("no new commits");
    expect(out.stderr).toContain("--from <branch>");
    expect(out.stderr).toContain("--allow-empty");
    expect(out.exitCode).toBe(1);
  });

  it("renders the prerelease proposed state", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare", "--prerelease"], {
      "POST /agent-ops/release/prepare": {
        status: 200,
        body: { kind: "prerelease-proposed", version: "0.3.1-rc.1", tag: "v0.3.1-rc.1", versionSource: "package.json", prerelease: true },
      },
    });
    expect(out.calls[0]?.body).toEqual({ prerelease: true });
    expect(out.stdout).toContain("--confirm");
  });

  it("passes --confirm for the rc tag push", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare", "--prerelease", "--confirm"], {
      "POST /agent-ops/release/prepare": {
        status: 200,
        body: { kind: "prerelease-tagged", version: "0.3.1-rc.1", tag: "v0.3.1-rc.1", sha: "abcdef1234", prerelease: true },
      },
    });
    expect(out.calls[0]?.body).toEqual({ prerelease: true, confirm: true });
    expect(out.stdout).toContain("pushed prerelease tag v0.3.1-rc.1");
  });

  it("surfaces an orchestrator error (e.g. ambiguous version source)", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "prepare"], {
      "POST /agent-ops/release/prepare": { status: 400, body: { error: "Multiple version sources detected" } },
    });
    expect(out.stderr).toContain("Multiple version sources detected");
    expect(out.exitCode).toBe(1);
  });
});

describe("shipit release rejected subcommands", () => {
  for (const sub of ["tag", "publish", "push"]) {
    it(`rejects \`shipit release ${sub}\``, async () => {
      const { run } = makeRunner();
      const out = await run(["release", sub]);
      expect(out.stderr).toContain(`does not support \`shipit release ${sub}\``);
      expect(out.calls).toHaveLength(0);
      expect(out.exitCode).not.toBe(0);
    });
  }

  it("rejects an unknown release subcommand", async () => {
    const { run } = makeRunner();
    const out = await run(["release", "frobnicate"]);
    expect(out.stderr).toContain("Unsupported shipit release subcommand: frobnicate");
  });
});
