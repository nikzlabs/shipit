import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import http from "node:http";
import {
  RepoGit,
  ensureBareCache,
  gitCredentialConfig,
  gitCredentialEnv,
  sanitizeGitEnv,
  type GitRemoteCredential,
} from "./repo-git.js";
import { ensureSharedTreeOwnedByShipIt } from "./shared-tree-ownership.js";

// docs/272-shared-cache-ownership — the gate is inert below root by design, so a
// real call proves nothing here. Spy on it and keep the real implementation, so
// these tests observe that it is consulted without changing what it does.
vi.mock("./shared-tree-ownership.js", async (load) => {
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  const real = await load<typeof import("./shared-tree-ownership.js")>();
  return { ...real, ensureSharedTreeOwnedByShipIt: vi.fn(real.ensureSharedTreeOwnedByShipIt) };
});

let tmpDir: string;
let remoteDir: string;
let remoteUrl: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-git-test-"));
  // Build a local "remote" — a real on-disk bare repo with one commit.
  // We use the file:// URL so `ensureBareCache` can `git clone --bare`
  // without touching the network.
  const seedDir = path.join(tmpDir, "seed");
  fs.mkdirSync(seedDir, { recursive: true });
  execSync("git init -b main", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: seedDir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: seedDir, stdio: "ignore" });
  fs.writeFileSync(path.join(seedDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  remoteDir = path.join(tmpDir, "remote.git");
  execSync(`git clone --bare ${seedDir} ${remoteDir}`, { stdio: "ignore" });
  remoteUrl = `file://${remoteDir}`;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createRepoGit(dir: string): RepoGit {
  return new RepoGit(dir);
}

describe("ensureBareCache", () => {
  it("re-clones when the cache directory is missing", async () => {
    const cacheDir = path.join(tmpDir, "cache-missing");
    expect(fs.existsSync(cacheDir)).toBe(false);

    const { git, recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(git).toBeDefined();
    // Valid bare repo has HEAD at the top
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    // The repo should have at least one commit (the seed README)
    expect(await git.isEmpty()).toBe(false);
  });

  it("re-clones when the cache directory exists but is empty", async () => {
    const cacheDir = path.join(tmpDir, "cache-empty");
    fs.mkdirSync(cacheDir, { recursive: true });

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
  });

  it("re-clones when the cache directory exists but has no HEAD (corrupt)", async () => {
    const cacheDir = path.join(tmpDir, "cache-corrupt");
    fs.mkdirSync(cacheDir, { recursive: true });
    // Leave behind some unrelated files but no HEAD — simulates a partial
    // download or a hand-edited cache.
    fs.writeFileSync(path.join(cacheDir, ".shipit-last-fetch"), "stale");
    fs.writeFileSync(path.join(cacheDir, "config"), "[remote]\n");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    // Stale marker should be wiped by the re-clone
    expect(fs.readFileSync(path.join(cacheDir, "config"), "utf-8")).not.toBe("[remote]\n");
  });

  it("returns the existing cache when HEAD is present (no re-clone)", async () => {
    const cacheDir = path.join(tmpDir, "cache-valid");
    // Set up a valid bare cache by cloning once.
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    // Drop a marker we can use to confirm the dir was NOT wiped.
    const markerPath = path.join(cacheDir, ".keep-me");
    fs.writeFileSync(markerPath, "preserve");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});

/** Append a commit to the seed working clone and push it to the remote. */
function advanceRemote(seedDir: string, remoteUrl: string, content: string): string {
  fs.writeFileSync(path.join(seedDir, "README.md"), content);
  execSync("git add . && git commit -m advance --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  // seed was the clone SOURCE for remote.git, so it has no remote configured.
  execSync(`git push ${remoteUrl} HEAD:main --force`, { cwd: seedDir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
}

describe("RepoGit bare-cache fetch advances HEAD", () => {
  it("fetchCache moves the bare cache HEAD when the remote advances", async () => {
    // Regression for docs/157: `git clone --bare` configures no fetch
    // refspec, so `git fetch --all` only writes FETCH_HEAD and the cache's
    // HEAD (→ refs/heads/main) stays frozen at clone time forever. Every
    // --local clone then branches from that stale snapshot.
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-advance");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const headBefore = await cacheGit.readHead();

    const remoteHead = advanceRemote(seedDir, remoteUrl, "# advanced\n");
    expect(remoteHead).not.toBe(headBefore);

    // ttlMs=0 bypasses the 60s freshness guard so the fetch always runs.
    await cacheGit.fetchCache(0);

    const headAfter = await cacheGit.readHead();
    expect(headAfter).toBe(remoteHead);
    expect(headAfter).not.toBe(headBefore);
  });

  it("a fresh --local clone from the cache sees the advanced commit", async () => {
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-clone");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const remoteHead = advanceRemote(seedDir, remoteUrl, "# advanced again\n");
    await cacheGit.fetchCache(0);

    const workspaceDir = path.join(tmpDir, "workspace");
    await cacheGit.cloneFromCache(workspaceDir, remoteUrl);

    const cloneOriginHead = execSync("git rev-parse origin/main", { cwd: workspaceDir })
      .toString()
      .trim();
    expect(cloneOriginHead).toBe(remoteHead);
  });

  // docs/198 — clone prep excludes pnpm's relocated /workspace/.pnpm-store from git
  // (via .git/info/exclude) so the post-turn auto-commit never stages the store.
  it("a fresh clone has .pnpm-store/ in .git/info/exclude", async () => {
    const cacheDir = path.join(tmpDir, "cache-exclude");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const workspaceDir = path.join(tmpDir, "workspace-exclude");
    await cacheGit.cloneFromCache(workspaceDir, remoteUrl);

    const exclude = fs.readFileSync(path.join(workspaceDir, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n").some((l) => l.trim() === ".pnpm-store/")).toBe(true);
  });
});

/**
 * planning#425 / planning#428 / docs/272-shared-cache-ownership req 1 & 4 — the
 * bare cache must be ShipIt's own before ShipIt's git runs in it.
 *
 * Spied at the seam rather than exercised for real, because the failing state is
 * not creatable here: it needs a root process and a foreign-owned tree, and a
 * session container has neither (no root, `unshare -r` refused). The gate itself
 * is unit-tested in `shared-tree-ownership.test.ts`; what these two assert is the
 * part no behavioural test can reach — that the gate is CONSULTED, on both
 * operations, and by a path that does not depend on `ensureBareCache` having been
 * called first.
 */
describe("the bare cache is made ShipIt's own before git touches it", () => {
  it("fetchCache checks the cache it is about to write refs into", async () => {
    // The planning#425 site. A uid-1000 cache root makes `safeSimpleGit(repoDir)`
    // drop to uid 1000, which then cannot create `refs/heads/shipit/<x>.lock`
    // inside a root-owned subdirectory a pre-drop build left behind.
    const cacheDir = path.join(tmpDir, "cache-gate-fetch");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);
    vi.mocked(ensureSharedTreeOwnedByShipIt).mockClear();

    await cacheGit.fetchCache(0);

    expect(vi.mocked(ensureSharedTreeOwnedByShipIt)).toHaveBeenCalledWith(cacheDir, expect.any(String));
  });

  it("cloneFromCache checks the SOURCE, which is the tree arming refused", async () => {
    // The planning#428 site, and the reason it survived three audits: the census
    // asked who owned the DESTINATION (already handled — `handWorkspaceBackToWorker`
    // runs at the end of this function) and never who owned the SOURCE. Root
    // reading a uid-1000 cache is `fatal: detected dubious ownership`, and 6 of 10
    // production caches were uid 1000.
    const cacheDir = path.join(tmpDir, "cache-gate-clone");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);
    vi.mocked(ensureSharedTreeOwnedByShipIt).mockClear();

    await cacheGit.cloneFromCache(path.join(tmpDir, "workspace-gate"), remoteUrl);

    const checked = vi.mocked(ensureSharedTreeOwnedByShipIt).mock.calls.map((c) => c[0]);
    expect(checked).toContain(cacheDir);
  });
});

describe("RepoGit overlay publish oracle (docs/183)", () => {
  it("isAncestor orders commits by ancestry (reflexive, forward, behind)", async () => {
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-ancestor");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);
    const c0 = await cacheGit.readHead();

    const c1 = advanceRemote(seedDir, remoteUrl, "# c1\n");
    await cacheGit.fetchCache(0);

    expect(await cacheGit.isAncestor(c0, c0)).toBe(true); // reflexive
    expect(await cacheGit.isAncestor(c0, c1)).toBe(true); // strictly forward
    expect(await cacheGit.isAncestor(c1, c0)).toBe(false); // behind
    expect(await cacheGit.isAncestor("0000000000000000000000000000000000000000", c1)).toBe(false); // unknown
  });

  it("resolveDefaultBranchCommit tracks the bare cache's default branch tip", async () => {
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-default");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    expect(await cacheGit.resolveDefaultBranchCommit()).toBe(await cacheGit.readHead());

    const c1 = advanceRemote(seedDir, remoteUrl, "# moved\n");
    await cacheGit.fetchCache(0);
    expect(await cacheGit.resolveDefaultBranchCommit()).toBe(c1);
  });
});

/**
 * docs/262 req 19 — **no credential ever reaches `/project/.git/config`.**
 *
 * This is the assertion whose absence kept the violation open: every existing
 * plugin guard test checks a plugin container's mounts, environment and network,
 * and NONE of them can see a token sitting in the session clone's own git
 * config — which is mounted at `/project` and readable by the agent, by every
 * companion CLI, and (once that surface ships) by every plugin service.
 *
 * These drive real git and read the real config file, so they fail if any later
 * change re-introduces the credential by another route.
 *
 * Fixture note: the password is deliberately short and generic. `secret-scan.ts`
 * flags `<user>:<8+ chars>@` in a URL, so a realistic-looking PAT here would
 * trip the scanner on every commit. Don't "improve" it.
 */
describe("no credential is recorded in a git config (docs/262 req 19)", () => {
  const CREDENTIALED = "https://x-access-token:pw@github.com/o/r.git";
  const CLEAN = "https://github.com/o/r.git";
  /** The shape `secret-scan.ts` looks for, minus its length floor. */
  const CREDENTIAL_IN_URL = /^\s*url\s*=\s*\S+:\/\/[^\s/@]+@/m;

  it("cloneFromCache writes a credential-free origin into the session clone", async () => {
    const cacheDir = path.join(tmpDir, "cache-cred");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    // The session clone. In production this directory is the container's
    // `/project`, so its `.git/config` is `/project/.git/config`.
    const workspaceDir = path.join(tmpDir, "workspace-cred");
    await cacheGit.cloneFromCache(workspaceDir, CREDENTIALED);

    const config = fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8");
    expect(config).not.toContain("pw@");
    expect(config).not.toMatch(CREDENTIAL_IN_URL);
    expect(
      execFileSync("git", ["-C", workspaceDir, "remote", "get-url", "origin"], { encoding: "utf-8" }).trim(),
    ).toBe(CLEAN);
  });

  it("setRemoteUrl can only remove a credential, never install one", async () => {
    const cacheDir = path.join(tmpDir, "cache-seturl");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    await cacheGit.setRemoteUrl(CREDENTIALED);

    const config = fs.readFileSync(path.join(cacheDir, "config"), "utf-8");
    expect(config).not.toContain("pw@");
    expect(config).not.toMatch(CREDENTIAL_IN_URL);
  });

  it("cloneBare never offers a URL-embedded credential, and never records one", async () => {
    // Isolates `cloneBare` itself against a REAL server: an earlier version of
    // this test reached the credential through `setRemoteUrl`, so a regression
    // confined to `cloneBare` would have passed it. git sends URL userinfo as
    // Basic auth, so "the server saw no Authorization header" is direct proof
    // the credential was dropped before git ran — and the accepted cost is
    // visible in the same assertion: the fetch is anonymous.
    let authorization: string | undefined;
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      if (req.headers.authorization) authorization ??= req.headers.authorization;
      res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git\"" });
      res.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // `server-test-setup.ts` pins GIT_ALLOW_PROTOCOL to `file`; this server IS
    // the loopback, so opt in for the duration and put the guard back.
    const allowed = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    // And pin an EMPTY global config: `setGlobalCredentialHelper` (exercised by
    // other suites in this process) installs a host-blind helper into the real
    // global git config, which would answer for this loopback server and make
    // the assertion below depend on test ordering rather than on this code.
    const emptyGlobal = path.join(tmpDir, "empty.gitconfig");
    fs.writeFileSync(emptyGlobal, "");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    const cacheDir = path.join(tmpDir, "cache-clonebare-cred");
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      await createRepoGit(cacheDir)
        .cloneBare(`http://x-access-token:pw@127.0.0.1:${port}/plugin.git`)
        .catch(() => undefined); // Always refused — what matters is what git offered.
    } finally {
      if (allowed === undefined) Reflect.deleteProperty(process.env, "GIT_ALLOW_PROTOCOL");
      else process.env.GIT_ALLOW_PROTOCOL = allowed;
      if (previousGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toBeGreaterThan(0); // Not vacuous: git did reach the server.
    expect(authorization).toBeUndefined();
    // Stated separately so a future ambient helper cannot make this pass
    // vacuously: whatever git offered, it was never the URL's own credential.
    expect(Buffer.from((authorization ?? "").replace("Basic ", ""), "base64").toString("utf8"))
      .not.toContain("pw");
  }, 20_000);
});

/**
 * docs/262 req 10 — the per-instance credential. These drive REAL git, because
 * every part of the mechanism that can be wrong is a git behavior: whether the
 * inherited helper list is actually reset, whether a URL-scoped helper matches,
 * and whether the helper git shells out to inherits our environment.
 */
describe("per-remote credential (RepoGit credential option)", () => {
  /** A global gitconfig with a decoy helper — this stands in for the host PAT. */
  function globalConfigWithDecoy(): string {
    const file = path.join(tmpDir, "decoy.gitconfig");
    fs.writeFileSync(
      file,
      "[credential]\n\thelper = \"!f() { echo \\\"username=x-access-token\\\"; "
        + "echo \\\"password=DECOY-HOST-PAT\\\"; }; f\"\n",
    );
    return file;
  }

  /** Ask git what credential it would use for `host`, under our config + env. */
  function askGit(host: string, credential: GitRemoteCredential): string {
    const args = gitCredentialConfig(credential).flatMap((c) => ["-c", c]);
    return execFileSync("git", [...args, "credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
      // The same environment the production path builds — including the
      // sanitizing, without which an inherited `GIT_ASKPASS` answers for a host
      // the credential was never scoped to.
      env: {
        ...sanitizeGitEnv(process.env),
        GIT_CONFIG_GLOBAL: globalConfigWithDecoy(),
        GIT_TERMINAL_PROMPT: "0",
        ...gitCredentialEnv(credential),
      },
      encoding: "utf-8",
    });
  }

  const cred: GitRemoteCredential = {
    origin: "https://github.com",
    token: { username: "x-access-token", password: "ghs_plugin_installation_token" },
  };

  it("overrides the global helper instead of queueing behind it", () => {
    // Without the reset the global helper answers first and the App token is
    // never reached — which on an App-only install means no credential at all.
    const answer = askGit("github.com", cred);
    expect(answer).toContain("password=ghs_plugin_installation_token");
    expect(answer).not.toContain("DECOY-HOST-PAT");
  });

  it("offers the credential to its own host only", () => {
    // A host-blind helper hands the token to whatever host git asks about
    // (docs/172 Gap 2). Another host must get no answer at all — with prompts
    // disabled, that is a failure, not a silent leak.
    expect(() => askGit("evil.example", cred)).toThrow();
  });

  it("keeps the token out of argv and out of the repository config", async () => {
    const cacheDir = path.join(tmpDir, "cache-credential");
    fs.mkdirSync(cacheDir, { recursive: true });
    // A file:// remote needs no credential, so this also proves the extra
    // config and environment do not disturb an ordinary fetch.
    const git = new RepoGit(cacheDir, cred);
    await git.cloneBare(remoteUrl);
    await git.fetchCache(0);

    expect(await git.readHead()).toMatch(/^[0-9a-f]{40}$/);
    const config = fs.readFileSync(path.join(cacheDir, "config"), "utf-8");
    expect(config).not.toContain(cred.token!.password);
    expect(gitCredentialConfig(cred).join(" ")).not.toContain(cred.token!.password);
  });

  /**
   * The end-to-end proof, through `RepoGit` and simple-git rather than a git
   * command this test composed itself: a server that demands Basic auth records
   * what git actually sent. Everything in between — simple-git's `-c` handling,
   * `.env()`, the helper, the scoping — is exercised for real.
   */
  async function credentialGitSent(
    credentialFor: (port: number) => GitRemoteCredential,
  ): Promise<{ authorization: string | undefined; requests: number }> {
    const seen: string[] = [];
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      if (req.headers.authorization) seen.push(req.headers.authorization);
      res.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git\"" });
      res.end("no");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // `server-test-setup.ts` pins GIT_ALLOW_PROTOCOL to `file` so no test pays
    // for a network round-trip. This server IS the loopback, and http is the
    // only transport it can speak without a certificate — so opt in for the
    // duration, and put the guard back.
    const allowed = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    try {
      const cacheDir = path.join(tmpDir, `cache-http-${port}`);
      fs.mkdirSync(cacheDir, { recursive: true });
      const git = new RepoGit(cacheDir, credentialFor(port));
      // Always refused — what matters is what git offered on the way.
      await git.cloneBare(`http://127.0.0.1:${port}/plugin.git`).catch(() => undefined);
    } finally {
      if (allowed === undefined) Reflect.deleteProperty(process.env, "GIT_ALLOW_PROTOCOL");
      else process.env.GIT_ALLOW_PROTOCOL = allowed;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return { authorization: seen[0], requests };
  }

  it("actually sends the supplied credential — through simple-git, to a real server", async () => {
    const { authorization } = await credentialGitSent((port) => ({
      origin: `http://127.0.0.1:${port}`,
      token: { username: "x-access-token", password: "ghs_plugin_installation_token" },
    }));
    expect(authorization).toBeDefined();
    expect(Buffer.from(authorization!.replace("Basic ", ""), "base64").toString("utf8"))
      .toBe("x-access-token:ghs_plugin_installation_token");
  }, 20_000);

  it("sends nothing when the request is for another origin", async () => {
    // Same server, credential scoped elsewhere: git offers no credential at
    // all rather than handing this one to a host it was not minted for.
    const { authorization, requests } = await credentialGitSent(() => ({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_plugin_installation_token" },
    }));
    // git DID ask the server (so this is not vacuously true) and offered nothing.
    expect(requests).toBeGreaterThan(0);
    expect(authorization).toBeUndefined();
  }, 20_000);

  it("supplies nothing — but still resets — when no token is given", async () => {
    // The anonymous case (`mode: "none"`): a public repository must still
    // fetch, and a stale global helper must NOT answer for it.
    expect(gitCredentialConfig({ origin: "https://github.com" })).toEqual(["credential.helper="]);
    const { authorization, requests } = await credentialGitSent((port) => ({
      origin: `http://127.0.0.1:${port}`,
    }));
    expect(requests).toBeGreaterThan(0);
    expect(authorization).toBeUndefined();
  }, 20_000);

  it("survives the environment variables simple-git guards", async () => {
    // Any one of these present used to fail EVERY credentialed fetch before git
    // ran — `PAGER=cat` was enough (review finding, P1).
    const guarded = {
      PAGER: "cat",
      GIT_PAGER: "less",
      GIT_ASKPASS: "/bin/echo",
      SSH_ASKPASS: "/bin/echo",
      GIT_SSH_COMMAND: "ssh -v",
      GIT_EXTERNAL_DIFF: "/bin/echo",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!f() { echo password=INJECTED; }; f",
    };
    const restore = { ...process.env };
    Object.assign(process.env, guarded);
    try {
      const { authorization } = await credentialGitSent((port) => ({
        origin: `http://127.0.0.1:${port}`,
        token: { username: "x-access-token", password: "ghs_survives" },
      }));
      expect(authorization).toBeDefined();
      // And the env-injected helper did not win either.
      expect(Buffer.from(authorization!.replace("Basic ", ""), "base64").toString("utf8"))
        .toBe("x-access-token:ghs_survives");
    } finally {
      for (const key of Object.keys(guarded)) Reflect.deleteProperty(process.env, key);
      Object.assign(process.env, restore);
    }
  }, 20_000);

  it("drops exactly the guarded variables and keeps the deliberate ones", () => {
    const cleaned = sanitizeGitEnv({
      PATH: "/usr/bin",
      GIT_CONFIG_GLOBAL: "/credentials/.gitconfig",
      GIT_EDITOR: "true",
      PAGER: "cat",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "x",
      GIT_CONFIG_VALUE_0: "y",
    });
    expect(cleaned).toEqual({
      PATH: "/usr/bin",
      // Kept on purpose — identity, `safe.directory`, and no interactive editor.
      GIT_CONFIG_GLOBAL: "/credentials/.gitconfig",
      GIT_EDITOR: "true",
    });
  });

  it("refuses to build a helper for an origin that could reshape the config key", () => {
    expect(() => gitCredentialConfig({ origin: "https://github.com" })).not.toThrow();
    expect(() => gitCredentialConfig({ origin: "https://github.com.helper=x" })).toThrow(/Refusing/);
    expect(() => gitCredentialConfig({ origin: "github.com" })).toThrow(/Refusing/); // no scheme
    expect(() => gitCredentialConfig({ origin: "" })).toThrow(/Refusing/);
  });
});
