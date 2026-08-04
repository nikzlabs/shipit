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
  isGitLfsAvailable,
  resetGitLfsAvailabilityCache,
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

describe("isGitLfsAvailable", () => {
  afterEach(() => resetGitLfsAvailabilityCache());

  it("resolves to a boolean and memoizes the probe", async () => {
    const first = isGitLfsAvailable();
    const second = isGitLfsAvailable();
    expect(second).toBe(first); // same promise — one probe, shared by concurrent callers
    expect(await first).toBeTypeOf("boolean");
  });
});
