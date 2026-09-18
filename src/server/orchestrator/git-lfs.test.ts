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

  it("carries the resolved credential on the pull's argv and environment", async () => {
    const dir = lfsRepo();
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
    expect(args.slice(-2)).toEqual(["lfs", "pull"]);
    expect(args).toContain("credential.helper=");
    expect(args.some((a) => a.startsWith("credential.https://github.com.helper="))).toBe(true);
    expect(args.join(" ")).not.toContain("ghp_secret");
    expect(env.SHIPIT_GIT_CRED_PASSWORD).toBe("ghp_secret");
    expect(env.SHIPIT_GIT_CRED_USERNAME).toBe("x-access-token");
  });

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

    expect(seen.GIT_CONFIG_KEY_0).not.toBe("credential.helper");
    expect(seen.GIT_CONFIG_KEY_0).toBe("http.https://github.com.extraHeader");
    expect(seen.GIT_CONFIG_VALUE_0).not.toContain("attacker");
    expect(seen.GIT_CONFIG_COUNT).toBe("1");
    expect(seen.GIT_ASKPASS).toBeUndefined();
    expect(seen.SHIPIT_GIT_CRED_PASSWORD).toBe("ghp_secret");
  });

  it("runs the pull unchanged when no credential applies", async () => {
    const dir = lfsRepo();
    const seen: string[][] = [];
    await materializeLfsContent(dir, {
      isAvailable: () => Promise.resolve(true),
      resolveCredential: () => Promise.resolve(null),
      spawnGit: (args) => {
        seen.push(args);
        return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
      },
    });
    expect(seen).toEqual([["lfs", "pull"]]);
  });

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
    expect(classifyPullFailure("fatal: could not read Username for 'https://github.com'")).toBe("no-credential");
    expect(classifyPullFailure("fatal: could not read Password: terminal prompts disabled")).toBe("no-credential");
    expect(
      classifyPullFailure("batch response: Git credentials for https://github.com/a/b.git not found"),
    ).toBe("no-credential");
    expect(classifyPullFailure("batch response: 403 Forbidden")).toBe("access-denied");
    expect(classifyPullFailure("Authentication failed for 'https://github.com/a/b.git'")).toBe("access-denied");
    expect(classifyPullFailure("error: dial tcp: lookup github.com: no such host")).toBe("other");
    expect(classifyPullFailure("")).toBe("other");
  });
});

describe("buildLfsUnresolvedAgentNotice", () => {
  it("names the cause and teaches the one cheap check", () => {
    const notice = buildLfsUnresolvedAgentNotice({
      status: "failed", usesLfs: true, failure: "no-credential",
    });
    expect(notice.startsWith("[System]")).toBe(true);
    expect(notice).toMatch(/could not present a credential/);
    expect(notice).toContain("version https://git-lfs.github.com/spec/v1");
    expect(notice).toMatch(/git lfs pull/);
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

describe("restoreLfsAfterTreeRewrite (nikzlabs/shipit#2349)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    resetGitLfsAvailabilityCache();
  });

  const ASSET_V1 = "A".repeat(4096);
  const ASSET_V2 = "B".repeat(8192);
  const UNTOUCHED = "C".repeat(2048);

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

  function makeSkipSmudgeClone(origin: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-clone-"));
    dirs.push(dir);
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
    expect(await isGitLfsAvailable()).toBe(true);
  });

  it("restores content a tree rewrite left as pointer text, and leaves git clean", async () => {
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    await restoreLfsAfterTreeRewrite(clone, "clone");
    expect(read(clone, "asset.bin")).toBe(ASSET_V2);

    git(clone, "reset --hard HEAD~1");

    const stub = read(clone, "asset.bin");
    expect(stub).toContain("version https://git-lfs.github.com/spec/v1");
    expect(stub.length).toBeLessThan(200);
    expect(git(clone, "status --porcelain")).toBe("");

    const warnings: string[] = [];
    const result = await restoreLfsAfterTreeRewrite(clone, "Sync with main", (m) => warnings.push(m));

    expect(result.status).toBe("materialized");
    expect(warnings).toEqual([]);
    expect(read(clone, "asset.bin")).toBe(ASSET_V1);
    expect(git(clone, "status --porcelain")).toBe("");
  });

  it("leaves LFS files the rewrite did not touch alone", async () => {
    const origin = makeLfsOrigin();
    const clone = makeSkipSmudgeClone(origin);
    await restoreLfsAfterTreeRewrite(clone, "clone");
    git(clone, "reset --hard HEAD~1");

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
    expect(result.status).toBe("binary-missing");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Sync with main");
  });

  it("swallows a throwing warn sink — callers run it in a `finally`", async () => {
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
    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("does not serialize across different workspaces", async () => {
    // Measure overlap; arrival order depends on each repo's detection probe.
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
    expect(second).toBe(first);
    expect(await first).toBeTypeOf("boolean");
  });
});
