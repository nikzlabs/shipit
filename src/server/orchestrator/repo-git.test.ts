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

// The ownership gate is inert below root; spy to verify that callers consult it.
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
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
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
    fs.writeFileSync(path.join(cacheDir, ".shipit-last-fetch"), "stale");
    fs.writeFileSync(path.join(cacheDir, "config"), "[remote]\n");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "HEAD"))).toBe(true);
    expect(fs.readFileSync(path.join(cacheDir, "config"), "utf-8")).not.toBe("[remote]\n");
  });

  it("returns the existing cache when HEAD is present (no re-clone)", async () => {
    const cacheDir = path.join(tmpDir, "cache-valid");
    execSync(`git clone --bare ${remoteDir} ${cacheDir}`, { stdio: "ignore" });
    const markerPath = path.join(cacheDir, ".keep-me");
    fs.writeFileSync(markerPath, "preserve");

    const { recovered } = await ensureBareCache(cacheDir, remoteUrl, createRepoGit);

    expect(recovered).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});

function advanceRemote(seedDir: string, remoteUrl: string, content: string): string {
  fs.writeFileSync(path.join(seedDir, "README.md"), content);
  execSync("git add . && git commit -m advance --no-gpg-sign", { cwd: seedDir, stdio: "ignore" });
  execSync(`git push ${remoteUrl} HEAD:main --force`, { cwd: seedDir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: seedDir }).toString().trim();
}

describe("RepoGit bare-cache fetch advances HEAD", () => {
  it("fetchCache moves the bare cache HEAD when the remote advances", async () => {
    const seedDir = path.join(tmpDir, "seed");
    const cacheDir = path.join(tmpDir, "cache-advance");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

    const headBefore = await cacheGit.readHead();

    const remoteHead = advanceRemote(seedDir, remoteUrl, "# advanced\n");
    expect(remoteHead).not.toBe(headBefore);

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

describe("the bare cache is made ShipIt's own before git touches it", () => {
  it("fetchCache checks the cache it is about to write refs into", async () => {
    const cacheDir = path.join(tmpDir, "cache-gate-fetch");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);
    vi.mocked(ensureSharedTreeOwnedByShipIt).mockClear();

    await cacheGit.fetchCache(0);

    expect(vi.mocked(ensureSharedTreeOwnedByShipIt)).toHaveBeenCalledWith(cacheDir, expect.any(String));
  });

  it("cloneFromCache checks the SOURCE, which is the tree arming refused", async () => {
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

    expect(await cacheGit.isAncestor(c0, c0)).toBe(true);
    expect(await cacheGit.isAncestor(c0, c1)).toBe(true);
    expect(await cacheGit.isAncestor(c1, c0)).toBe(false);
    expect(await cacheGit.isAncestor("0000000000000000000000000000000000000000", c1)).toBe(false);
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

describe("no credential is recorded in a git config (docs/262 req 19)", () => {
  // Keep the fixture password below the secret scanner's length threshold.
  const CREDENTIALED = "https://x-access-token:pw@github.com/o/r.git";
  const CLEAN = "https://github.com/o/r.git";
  const CREDENTIAL_IN_URL = /^\s*url\s*=\s*\S+:\/\/[^\s/@]+@/m;

  it("cloneFromCache writes a credential-free origin into the session clone", async () => {
    const cacheDir = path.join(tmpDir, "cache-cred");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGit = createRepoGit(cacheDir);
    await cacheGit.cloneBare(remoteUrl);

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
    // Test setup permits only file transport; enable HTTP for the loopback server.
    const allowed = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    // Exclude ambient credential helpers from the anonymous-request assertion.
    const emptyGlobal = path.join(tmpDir, "empty.gitconfig");
    fs.writeFileSync(emptyGlobal, "");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    const cacheDir = path.join(tmpDir, "cache-clonebare-cred");
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      await createRepoGit(cacheDir)
        .cloneBare(`http://x-access-token:pw@127.0.0.1:${port}/plugin.git`)
        .catch(() => undefined);
    } finally {
      if (allowed === undefined) Reflect.deleteProperty(process.env, "GIT_ALLOW_PROTOCOL");
      else process.env.GIT_ALLOW_PROTOCOL = allowed;
      if (previousGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requests).toBeGreaterThan(0);
    expect(authorization).toBeUndefined();
    expect(Buffer.from((authorization ?? "").replace("Basic ", ""), "base64").toString("utf8"))
      .not.toContain("pw");
  }, 20_000);
});

describe("per-remote credential (RepoGit credential option)", () => {
  function globalConfigWithDecoy(): string {
    const file = path.join(tmpDir, "decoy.gitconfig");
    fs.writeFileSync(
      file,
      "[credential]\n\thelper = \"!f() { echo \\\"username=x-access-token\\\"; "
        + "echo \\\"password=DECOY-HOST-PAT\\\"; }; f\"\n",
    );
    return file;
  }

  function askGit(host: string, credential: GitRemoteCredential): string {
    const args = gitCredentialConfig(credential).flatMap((c) => ["-c", c]);
    return execFileSync("git", [...args, "credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
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
    const answer = askGit("github.com", cred);
    expect(answer).toContain("password=ghs_plugin_installation_token");
    expect(answer).not.toContain("DECOY-HOST-PAT");
  });

  it("offers the credential to its own host only", () => {
    expect(() => askGit("evil.example", cred)).toThrow();
  });

  it("keeps the token out of argv and out of the repository config", async () => {
    const cacheDir = path.join(tmpDir, "cache-credential");
    fs.mkdirSync(cacheDir, { recursive: true });
    const git = new RepoGit(cacheDir, cred);
    await git.cloneBare(remoteUrl);
    await git.fetchCache(0);

    expect(await git.readHead()).toMatch(/^[0-9a-f]{40}$/);
    const config = fs.readFileSync(path.join(cacheDir, "config"), "utf-8");
    expect(config).not.toContain(cred.token!.password);
    expect(gitCredentialConfig(cred).join(" ")).not.toContain(cred.token!.password);
  });

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
    const allowed = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    try {
      const cacheDir = path.join(tmpDir, `cache-http-${port}`);
      fs.mkdirSync(cacheDir, { recursive: true });
      const git = new RepoGit(cacheDir, credentialFor(port));
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
    const { authorization, requests } = await credentialGitSent(() => ({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_plugin_installation_token" },
    }));
    expect(requests).toBeGreaterThan(0);
    expect(authorization).toBeUndefined();
  }, 20_000);

  it("supplies nothing — but still resets — when no token is given", async () => {
    expect(gitCredentialConfig({ origin: "https://github.com" })).toEqual(["credential.helper="]);
    const { authorization, requests } = await credentialGitSent((port) => ({
      origin: `http://127.0.0.1:${port}`,
    }));
    expect(requests).toBeGreaterThan(0);
    expect(authorization).toBeUndefined();
  }, 20_000);

  it("survives the environment variables simple-git guards", async () => {
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
      GIT_CONFIG_GLOBAL: "/credentials/.gitconfig",
      GIT_EDITOR: "true",
    });
  });

  it("refuses to build a helper for an origin that could reshape the config key", () => {
    expect(() => gitCredentialConfig({ origin: "https://github.com" })).not.toThrow();
    expect(() => gitCredentialConfig({ origin: "https://github.com.helper=x" })).toThrow(/Refusing/);
    expect(() => gitCredentialConfig({ origin: "github.com" })).toThrow(/Refusing/);
    expect(() => gitCredentialConfig({ origin: "" })).toThrow(/Refusing/);
  });
});
