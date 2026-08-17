/**
 * Unit tests for Git LFS detection and materialization (docs/231).
 *
 * The bug these guard (nikzlabs/shipit#1729) is a *silent* one: an LFS repo
 * checks out ~130-byte pointer stubs, the preview renders broken images and
 * fails to decode audio, and nothing anywhere says why. So the assertions here
 * are as much about "a non-materialized outcome always carries a warning" as
 * about the detection logic itself.
 *
 * Detection runs against real temp repos rather than a stubbed git, because the
 * subtle parts — the `*.gitattributes` pathspec matching nested files, and
 * `git grep`'s exit code 1 meaning "no match" rather than "error" — only have
 * meaning against a real git.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  repoDeclaresLfs,
  materializeLfsContent,
  materializeLfsWithWarning,
  restoreLfsAfterTreeRewrite,
  isGitLfsAvailable,
  resetGitLfsAvailabilityCache,
  classifyPullFailure,
  buildLfsUnresolvedAgentNotice,
} from "./git-lfs.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/** An initialized repo with no commits — `HEAD` is unborn. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-"));
  git(dir, "init --initial-branch=main");
  git(dir, 'config user.email "t@example.com"');
  git(dir, 'config user.name "Test"');
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, "add -A");
  git(dir, `commit -m "${message}" --no-gpg-sign`);
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const LFS_ATTRS = "*.png filter=lfs diff=lfs merge=lfs -text\n";

describe("repoDeclaresLfs", () => {
  const dirs: string[] = [];
  function track(d: string): string {
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("detects LFS filters in a root .gitattributes", async () => {
    const dir = track(makeRepo());
    writeFile(dir, ".gitattributes", LFS_ATTRS);
    commitAll(dir, "add lfs attrs");
    expect(await repoDeclaresLfs(dir)).toBe(true);
  });

  it("detects LFS filters in a nested .gitattributes", async () => {
    // The `*.gitattributes` pathspec has to match `packages/ui/.gitattributes`
    // too — git pathspec globs cross `/`, unlike a shell glob. A monorepo that
    // declares LFS only in a subpackage is the case this covers.
    const dir = track(makeRepo());
    writeFile(dir, "README.md", "# root\n");
    writeFile(dir, "packages/ui/.gitattributes", LFS_ATTRS);
    commitAll(dir, "add nested lfs attrs");
    expect(await repoDeclaresLfs(dir)).toBe(true);
  });

  it("returns false for a .gitattributes with no LFS filters", async () => {
    const dir = track(makeRepo());
    writeFile(dir, ".gitattributes", "* text=auto\n*.sh eol=lf\n");
    commitAll(dir, "add plain attrs");
    expect(await repoDeclaresLfs(dir)).toBe(false);
  });

  it("returns false for a repo with no .gitattributes at all", async () => {
    const dir = track(makeRepo());
    writeFile(dir, "index.js", "console.log(1);\n");
    commitAll(dir, "initial");
    expect(await repoDeclaresLfs(dir)).toBe(false);
  });

  it("returns false (not a throw) on an unborn HEAD", async () => {
    // `git grep HEAD` exits 128 here. Anything other than 0 must degrade to
    // "no LFS" rather than erroring — a session whose provisioning throws is
    // strictly worse than one whose assets are stubs.
    const dir = track(makeRepo());
    await expect(repoDeclaresLfs(dir)).resolves.toBe(false);
  });

  it("returns false (not a throw) outside a git repo", async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-plain-")));
    await expect(repoDeclaresLfs(dir)).resolves.toBe(false);
  });
});

describe("materializeLfsContent", () => {
  const dirs: string[] = [];
  function track(d: string): string {
    dirs.push(d);
    return d;
  }
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.SHIPIT_GIT_LFS;
    delete process.env.SHIPIT_GIT_LFS;
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.SHIPIT_GIT_LFS;
    else process.env.SHIPIT_GIT_LFS = savedMode;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A repo whose committed `.gitattributes` declares LFS filters. */
  function lfsRepo(): string {
    const dir = track(makeRepo());
    writeFile(dir, ".gitattributes", LFS_ATTRS);
    commitAll(dir, "add lfs attrs");
    return dir;
  }

  it("short-circuits on a non-LFS repo without touching git-lfs", async () => {
    const dir = track(makeRepo());
    writeFile(dir, "index.js", "console.log(1);\n");
    commitAll(dir, "initial");
    const result = await materializeLfsContent(dir, {
      isAvailable: () => Promise.reject(new Error("must not probe for a non-LFS repo")),
    });
    expect(result).toEqual({ status: "not-an-lfs-repo", usesLfs: false });
    expect(result.warning).toBeUndefined();
  });

  it("reports binary-missing with a warning when git-lfs is not installed", async () => {
    const result = await materializeLfsContent(lfsRepo(), { isAvailable: () => Promise.resolve(false) });
    expect(result.status).toBe("binary-missing");
    expect(result.usesLfs).toBe(true);
    // The regression this whole feature exists for: never fail silently.
    expect(result.warning).toMatch(/git-lfs/);
    expect(result.warning).toMatch(/pointer stubs/);
  });

  it("reports disabled — ahead of the binary probe — when SHIPIT_GIT_LFS=off", async () => {
    process.env.SHIPIT_GIT_LFS = "off";
    const result = await materializeLfsContent(lfsRepo(), {
      isAvailable: () => Promise.reject(new Error("must not probe when downloads are disabled")),
    });
    expect(result.status).toBe("disabled");
    expect(result.warning).toMatch(/SHIPIT_GIT_LFS=off/);
    expect(result.warning).toMatch(/git lfs pull/);
  });

  it("ignores an unrelated SHIPIT_GIT_LFS value", async () => {
    process.env.SHIPIT_GIT_LFS = "auto";
    const result = await materializeLfsContent(lfsRepo(), { isAvailable: () => Promise.resolve(false) });
    expect(result.status).toBe("binary-missing");
  });

  // planning#426 — the pull is a REMOTE op, and since docs/266 E1/E3 the git that
  // runs it on a session workspace has dropped uid and cannot read the
  // orchestrator's PAT. It must therefore carry its own credential, the way
  // `GitManager.remoteGit` does; without it a private LFS repo dies with
  // `fatal: could not read Username for 'https://github.com'`.
  it("carries the resolved credential on the pull's argv and environment", async () => {
    const dir = lfsRepo();
    // `origin` has to be a real https remote or the resolver would decline —
    // this asserts the wiring, so the credential is injected directly.
    git(dir, "remote add origin https://github.com/example/private.git");
    const seen: { args: string[]; env: Record<string, string | undefined> }[] = [];
    await materializeLfsContent(dir, {
      isAvailable: () => Promise.resolve(true),
      resolveCredential: () => Promise.resolve({
        origin: "https://github.com",
        token: { username: "x-access-token", password: "ghp_secret" },
      }),
      spawnGit: (args, _cwd, _timeout, env) => {
        seen.push({ args, env: env ?? {} });
        return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
      },
    });

    expect(seen).toHaveLength(1);
    const { args, env } = seen[0];
    // The SHAPE rides the argv, ahead of the subcommand, because no `.env()` can
    // remove it — `shared/git-remote-credential.ts` explains why that asymmetry
    // is load-bearing. The empty reset is what stops the workspace-LOCAL helper
    // (the container's broker binary, absent on the orchestrator) from answering.
    expect(args.slice(-2)).toEqual(["lfs", "pull"]);
    expect(args).toContain("credential.helper=");
    expect(args.some((a) => a.startsWith("credential.https://github.com.helper="))).toBe(true);
    // The SECRET rides the environment, so it never lands in `/proc/<pid>/cmdline`.
    expect(args.join(" ")).not.toContain("ghp_secret");
    expect(env.SHIPIT_GIT_CRED_PASSWORD).toBe("ghp_secret");
    expect(env.SHIPIT_GIT_CRED_USERNAME).toBe("x-access-token");
  });

  // Review finding. `GIT_CONFIG_COUNT` outranks every `-c`, so an inherited one
  // could reinstate the helper the reset just cleared; `GIT_ASKPASS` would be
  // reached instead of the helper we supplied. `credentialledGit` drops both, and
  // the credentialled pull has to match it.
  it("drops the inherited variables that could override the supplied credential", async () => {
    const dir = lfsRepo();
    const saved = { count: process.env.GIT_CONFIG_COUNT, askpass: process.env.GIT_ASKPASS };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "credential.helper";
    process.env.GIT_CONFIG_VALUE_0 = "!echo password=attacker";
    process.env.GIT_ASKPASS = "/tmp/askpass";
    let seen: NodeJS.ProcessEnv = {};
    try {
      await materializeLfsContent(dir, {
        isAvailable: () => Promise.resolve(true),
        resolveCredential: () => Promise.resolve({
          origin: "https://github.com",
          token: { username: "x-access-token", password: "ghp_secret" },
        }),
        spawnGit: (_args, _cwd, _timeout, env) => {
          seen = env ?? {};
          return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
        },
      });
    } finally {
      if (saved.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.count;
      if (saved.askpass === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = saved.askpass;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }

    expect(seen.GIT_CONFIG_COUNT).toBeUndefined();
    expect(seen.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(seen.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(seen.GIT_ASKPASS).toBeUndefined();
    // The credential itself still made it through.
    expect(seen.SHIPIT_GIT_CRED_PASSWORD).toBe("ghp_secret");
  });

  it("runs the pull unchanged when no credential applies", async () => {
    const dir = lfsRepo();
    const seen: string[][] = [];
    await materializeLfsContent(dir, {
      isAvailable: () => Promise.resolve(true),
      // `null` is the answer on every path that is NOT a dropped-uid git — root
      // git reads the global helper, which reads the root-only PAT file — so this
      // must stay byte-for-byte what it was before planning#426.
      resolveCredential: () => Promise.resolve(null),
      spawnGit: (args) => {
        seen.push(args);
        return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
      },
    });
    expect(seen).toEqual([["lfs", "pull"]]);
  });

  // The issue's "separate the two shapes explicitly — they need different fixes".
  it("reports a credential-less failure as a plumbing fault, with its own advice", async () => {
    const result = await materializeLfsContent(lfsRepo(), {
      isAvailable: () => Promise.resolve(true),
      resolveCredential: () => Promise.resolve(null),
      spawnGit: () => Promise.resolve({
        code: 2,
        stdout: "",
        stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
          + "batch response: Git credentials for https://github.com/example/private.git not found",
        timedOut: false,
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("no-credential");
    expect(result.warning).toMatch(/could not present a credential/);
  });

  it("reports a refused credential as an access problem, not a plumbing one", async () => {
    const result = await materializeLfsContent(lfsRepo(), {
      isAvailable: () => Promise.resolve(true),
      resolveCredential: () => Promise.resolve(null),
      spawnGit: () => Promise.resolve({
        code: 2,
        stdout: "",
        stderr: "batch response: Repository or object not found: 403 Forbidden",
        timedOut: false,
      }),
    });
    expect(result.failure).toBe("access-denied");
    expect(result.warning).toMatch(/refused the credential/);
  });
});

describe("classifyPullFailure", () => {
  it("separates the two credential shapes and defaults to `other`", () => {
    // git's words for "no helper answered" …
    expect(classifyPullFailure("fatal: could not read Username for 'https://github.com'")).toBe("no-credential");
    expect(classifyPullFailure("fatal: could not read Password: terminal prompts disabled")).toBe("no-credential");
    // … and git-lfs's own words for the same thing, which is the line the
    // planning#410 soak actually captured.
    expect(
      classifyPullFailure("batch response: Git credentials for https://github.com/a/b.git not found"),
    ).toBe("no-credential");
    // A credential WAS offered and refused — a legitimate outcome, different fix.
    expect(classifyPullFailure("batch response: 403 Forbidden")).toBe("access-denied");
    expect(classifyPullFailure("Authentication failed for 'https://github.com/a/b.git'")).toBe("access-denied");
    // Anything else keeps the generic advice rather than guessing.
    expect(classifyPullFailure("error: dial tcp: lookup github.com: no such host")).toBe("other");
    expect(classifyPullFailure("")).toBe("other");
  });
});

describe("buildLfsUnresolvedAgentNotice", () => {
  // planning#426's reporting half. A toast is gone in seconds; the party that
  // reads the stubs as if they were content arrives on the next turn, which may
  // be tomorrow.
  it("names the cause and teaches the one cheap check", () => {
    const notice = buildLfsUnresolvedAgentNotice({
      status: "failed", usesLfs: true, failure: "no-credential",
    });
    expect(notice.startsWith("[System]")).toBe(true);
    expect(notice).toMatch(/could not present a credential/);
    // The header is the whole point: it is what distinguishes "this asset is a
    // stub" from the misdiagnoses the original docs/231 reporter lost time to.
    expect(notice).toContain("version https://git-lfs.github.com/spec/v1");
    expect(notice).toMatch(/git lfs pull/);
    // "may", not "are" — a batched pull can fail part-way.
    expect(notice).toMatch(/may therefore\s+hold|may therefore hold/);
  });

  it("distinguishes every non-materialized cause", () => {
    expect(buildLfsUnresolvedAgentNotice({ status: "disabled", usesLfs: true }))
      .toMatch(/downloads are disabled/);
    expect(buildLfsUnresolvedAgentNotice({ status: "binary-missing", usesLfs: true }))
      .toMatch(/binary is not available/);
    expect(buildLfsUnresolvedAgentNotice({ status: "failed", usesLfs: true, failure: "access-denied" }))
      .toMatch(/refused the credential/);
    expect(buildLfsUnresolvedAgentNotice({ status: "failed", usesLfs: true, failure: "timeout" }))
      .toMatch(/time limit/);
    expect(buildLfsUnresolvedAgentNotice({ status: "failed", usesLfs: true }))
      .toMatch(/the pull failed/);
  });
});

describe("materializeLfsWithWarning", () => {
  const dirs: string[] = [];
  function track(d: string): string {
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("forwards the warning prefixed with the repo label", async () => {
    const dir = track(makeRepo());
    writeFile(dir, ".gitattributes", LFS_ATTRS);
    commitAll(dir, "add lfs attrs");
    const warnings: string[] = [];
    const result = await materializeLfsWithWarning(dir, "https://github.com/acme/art", (m) => warnings.push(m), {
      isAvailable: () => Promise.resolve(false),
    });
    expect(result.status).toBe("binary-missing");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("https://github.com/acme/art");
    expect(warnings[0]).toContain("git-lfs");
  });

  it("stays silent when there is nothing to warn about", async () => {
    const dir = track(makeRepo());
    writeFile(dir, "index.js", "console.log(1);\n");
    commitAll(dir, "initial");
    const warnings: string[] = [];
    await materializeLfsWithWarning(dir, "repo", (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });

  it("swallows a thrown error rather than failing session provisioning", async () => {
    // The contract callers rely on: LFS is an asset-quality concern, and no
    // failure in it may take down the provisioning path it's wired into.
    const warnings: string[] = [];
    const result = await materializeLfsWithWarning(
      path.join(os.tmpdir(), "shipit-lfs-does-not-exist-zzz"),
      "repo",
      (m) => warnings.push(m),
      { isAvailable: () => Promise.resolve(true) },
    );
    expect(result.usesLfs).toBeTypeOf("boolean");
    expect(warnings.length).toBeLessThanOrEqual(1);
  });
});

/**
 * nikzlabs/shipit#2349 — the reported bug, end to end against a real git and a real
 * git-lfs.
 *
 * A stub can't produce it: what goes wrong is that the ORCHESTRATOR's git has
 * the LFS smudge filter disabled, so a tree rewrite (rebase / `reset --hard` /
 * merge) re-materializes tracked assets as ~130-byte pointer text, `git status`
 * reports the tree CLEAN because the pointer in the index never changed, and
 * files the rewrite did NOT touch keep their real bytes. Every one of those is a
 * property of the actual filter configuration, so the fixture reproduces that
 * configuration rather than describing it.
 */
describe("restoreLfsAfterTreeRewrite (nikzlabs/shipit#2349)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    resetGitLfsAvailabilityCache();
  });

  /** Content big enough that a pointer stub is unmistakably the wrong bytes. */
  const ASSET_V1 = "A".repeat(4096);
  const ASSET_V2 = "B".repeat(8192);
  const UNTOUCHED = "C".repeat(2048);

  /**
   * An origin repo with two commits that change an LFS-tracked asset, plus a
   * second tracked asset that only ever exists in its v1 form — that one is the
   * control: a rewrite that doesn't touch it must leave its content alone, which
   * is what tells "the rewrite path is broken" apart from "LFS is broken here".
   */
  function makeLfsOrigin(): string {
    const dir = makeRepo();
    dirs.push(dir);
    git(dir, "lfs install --local");
    writeFile(dir, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFile(dir, "asset.bin", ASSET_V1);
    writeFile(dir, "untouched.bin", UNTOUCHED);
    commitAll(dir, "v1");
    writeFile(dir, "asset.bin", ASSET_V2);
    commitAll(dir, "v2");
    return dir;
  }

  /**
   * A session clone as the orchestrator holds one: cloned `--local` from a
   * filesystem path, with the clean filter live and smudge disabled — i.e. what
   * `git lfs install --system --skip-smudge` produces in the orchestrator image.
   * `git clone --local` does not carry `.git/lfs`, so the object store is copied
   * in explicitly, mirroring both the docs/232 hardlink seeding and the reported
   * case (the object was already local; only the working copy was wrong).
   */
  function makeSkipSmudgeClone(origin: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-clone-"));
    dirs.push(dir);
    // Skip smudge for the clone's own checkout too, not just afterwards: with it
    // active the clone materializes content and the fixture would never hold the
    // stubs the orchestrator's clone actually starts from.
    const skipSmudge = `-c filter.lfs.smudge="git-lfs smudge --skip -- %f" -c filter.lfs.process="git-lfs filter-process --skip"`;
    execSync(`git ${skipSmudge} clone --quiet --local ${origin} ${dir}`, { stdio: ["ignore", "pipe", "ignore"] });
    git(dir, 'config user.email "t@example.com"');
    git(dir, 'config user.name "Test"');
    git(dir, 'config filter.lfs.clean "git-lfs clean -- %f"');
    git(dir, 'config filter.lfs.smudge "git-lfs smudge --skip -- %f"');
    git(dir, 'config filter.lfs.process "git-lfs filter-process --skip"');
    git(dir, "config filter.lfs.required true");
    fs.cpSync(path.join(origin, ".git", "lfs"), path.join(dir, ".git", "lfs"), {
      recursive: true,
      force: true,
    });
    return dir;
  }

  function read(dir: string, rel: string): string {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  }

  it("git-lfs is installed, so the rest of this describe means something", async () => {
    // Guarding the fixture itself rather than skipping on a missing binary: a
    // silently-skipped regression test for a silent bug is the worst of both.
    expect(await isGitLfsAvailable()).toBe(true);
  });

  it("restores content a tree rewrite left as pointer text, and leaves git clean", async () => {
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    await restoreLfsAfterTreeRewrite(clone, "clone");
    expect(read(clone, "asset.bin")).toBe(ASSET_V2);

    // The rewrite: exactly what a sync onto a moved base does to the worktree.
    git(clone, "reset --hard HEAD~1");

    // The bug, reproduced. Both halves matter — the pointer text AND the fact
    // that nothing about the repo state says anything is wrong.
    const stub = read(clone, "asset.bin");
    expect(stub).toContain("version https://git-lfs.github.com/spec/v1");
    expect(stub.length).toBeLessThan(200);
    expect(git(clone, "status --porcelain")).toBe("");

    const warnings: string[] = [];
    const result = await restoreLfsAfterTreeRewrite(clone, "Sync with main", (m) => warnings.push(m));

    expect(result.status).toBe("materialized");
    expect(warnings).toEqual([]);
    expect(read(clone, "asset.bin")).toBe(ASSET_V1);
    // Restoring content must not dirty the tree: the pointer in the index never
    // changed, so there is nothing to re-commit (the reporter's own finding).
    expect(git(clone, "status --porcelain")).toBe("");
  });

  it("leaves LFS files the rewrite did not touch alone", async () => {
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    await restoreLfsAfterTreeRewrite(clone, "clone");
    git(clone, "reset --hard HEAD~1");

    // The tell from the report: only the rewritten path went stale.
    expect(read(clone, "untouched.bin")).toBe(UNTOUCHED);
    await restoreLfsAfterTreeRewrite(clone, "Sync with main");
    expect(read(clone, "untouched.bin")).toBe(UNTOUCHED);
  });

  it("warns with the operation label when the content cannot be restored", async () => {
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    const warnings: string[] = [];
    const result = await restoreLfsAfterTreeRewrite(clone, "Sync with main", (m) => warnings.push(m), {
      isAvailable: () => Promise.resolve(false),
    });
    // The issue's fallback ask: if the content can't be restored, say so rather
    // than leaving the session to consume the pointer.
    expect(result.status).toBe("binary-missing");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Sync with main");
  });

  it("swallows a throwing warn sink — callers run it in a `finally`", async () => {
    // A throw here would replace the rebase driver's real error with this one,
    // and would make a completed pre-turn reset report itself as not-moved.
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    const result = await restoreLfsAfterTreeRewrite(
      clone,
      "Sync with main",
      () => { throw new Error("the SSE broadcaster is gone"); },
      { isAvailable: () => Promise.resolve(false) },
    );
    expect(result.status).toBe("failed");
  });

  it("serializes concurrent restores of one workspace", async () => {
    // Two restores of one clone must not overlap: `git lfs checkout` writes the
    // working file IN PLACE (measured against git-lfs 3.3.0 — same inode before
    // and after), so two writers can interleave INSIDE one asset rather than one
    // simply losing. The rebase driver reaches this on its auto-resolve timeout.
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    const order: string[] = [];
    const probe = (tag: string) => async () => {
      order.push(`start:${tag}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${tag}`);
      return true;
    };
    const [a, b] = await Promise.all([
      restoreLfsAfterTreeRewrite(clone, "A", () => {}, { isAvailable: probe("A") }),
      restoreLfsAfterTreeRewrite(clone, "B", () => {}, { isAvailable: probe("B") }),
    ]);
    expect(a.status).toBe("materialized");
    expect(b.status).toBe("materialized");
    // Never `start:A, start:B, …` — the second waits for the first to finish.
    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("does not serialize across different workspaces", async () => {
    // The chain is per directory: one asset-heavy session must not delay another.
    //
    // The property is OVERLAP, not an order. Which call reaches its probe first
    // is a genuine race — each awaits `repoDeclaresLfs` on its own directory
    // before probing — so asserting `["start:A", "start:B"]` pinned a coin flip
    // and flaked in CI. Both probes therefore park on one barrier that only the
    // second arrival opens: with a per-directory chain both arrive and it opens,
    // and a cross-directory chain leaves the first waiting alone, which the
    // in-flight count reports as 1 rather than as a timeout with no diagnosis.
    const origin = makeLfsOrigin();
    const first = makeSkipSmudgeClone(origin);
    const second = makeSkipSmudgeClone(origin);
    let inFlight = 0;
    let maxInFlight = 0;
    let openBarrier = () => {};
    const bothArrived = new Promise<void>((resolve) => { openBarrier = resolve; });
    const probe = () => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 2) openBarrier();
      // Bounded, so a regression fails on the assertion below rather than by
      // hanging until vitest's own timeout.
      await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 2000))]);
      inFlight -= 1;
      return true;
    };
    const [a, b] = await Promise.all([
      restoreLfsAfterTreeRewrite(first, "A", () => {}, { isAvailable: probe() }),
      restoreLfsAfterTreeRewrite(second, "B", () => {}, { isAvailable: probe() }),
    ]);
    expect(maxInFlight).toBe(2);
    expect([a.status, b.status]).toEqual(["materialized", "materialized"]);
  });

  it("costs one grep and says nothing on a repo that doesn't use LFS", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    writeFile(dir, "index.js", "console.log(1);\n");
    commitAll(dir, "initial");
    const warnings: string[] = [];
    const result = await restoreLfsAfterTreeRewrite(dir, "Sync with main", (m) => warnings.push(m));
    expect(result.status).toBe("not-an-lfs-repo");
    expect(warnings).toEqual([]);
  });
});

describe("isGitLfsAvailable", () => {
  afterEach(() => resetGitLfsAvailabilityCache());

  it("resolves to a boolean and memoizes the probe", async () => {
    const first = isGitLfsAvailable();
    const second = isGitLfsAvailable();
    expect(second).toBe(first); // same promise — one probe, shared by concurrent callers
    expect(await first).toBeTypeOf("boolean");
  });
});
