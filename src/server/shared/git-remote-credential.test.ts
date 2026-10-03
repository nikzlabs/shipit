import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  configureLfsHostCredentialResolver,
  gitCredentialConfig,
  gitCredentialEnv,
  gitCredentialSpawnOverrides,
  parseRemoteOrigin,
  resolveTreeRemoteCredential,
  withPreemptiveAuthFallback,
  type GitRemoteCredential,
  type LfsHostResolution,
} from "./git-remote-credential.js";

describe("parseRemoteOrigin", () => {
  it("splits an https GitHub remote into origin, host, owner and repo", () => {
    expect(parseRemoteOrigin("https://github.com/acme/widgets.git")).toEqual({
      origin: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("tolerates a missing .git suffix and a trailing slash", () => {
    expect(parseRemoteOrigin("https://github.com/acme/widgets/")).toMatchObject({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("keeps a non-default port in the origin, because the helper is scoped to it", () => {
    expect(parseRemoteOrigin("https://ghe.example:8443/acme/widgets.git")?.origin)
      .toBe("https://ghe.example:8443");
  });

  it("follows the global insteadOf rewrite for a GitHub SSH remote", () => {
    for (const url of [
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
    ]) {
      expect(parseRemoteOrigin(url)).toEqual({
        origin: "https://github.com",
        host: "github.com",
        owner: "acme",
        repo: "widgets",
      });
    }
  });

  it("returns null for the remotes that authenticate nothing", () => {
    expect(parseRemoteOrigin("/workspace/sessions/abc/workspace")).toBeNull();
    expect(parseRemoteOrigin("file:///tmp/bare.git")).toBeNull();
    expect(parseRemoteOrigin("git@gitlab.example:acme/widgets.git")).toBeNull();
    expect(parseRemoteOrigin("ssh://git@ghe.example/acme/widgets.git")).toBeNull();
    expect(parseRemoteOrigin(undefined)).toBeNull();
    expect(parseRemoteOrigin("")).toBeNull();
  });

  it("returns the origin without owner/repo when the path names neither", () => {
    expect(parseRemoteOrigin("https://github.com/acme")).toEqual({
      origin: "https://github.com",
      host: "github.com",
    });
  });
});

describe("resolveTreeRemoteCredential", () => {
  const url = async (): Promise<string> => "https://github.com/acme/widgets.git";

  it("mints on an https remote, whatever uid the git would run as", async () => {
    const seen: string[] = [];
    const credential = await resolveTreeRemoteCredential(
      "/workspace/sessions/s1/workspace",
      "origin",
      async (remote) => {
        seen.push(`${remote.host}:${remote.owner}/${remote.repo}`);
        return { username: "x-access-token", password: "ghs_installation" };
      },
      url,
    );
    expect(seen).toEqual(["github.com:acme/widgets"]);
    expect(credential).toEqual({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_installation" },
    });
  });

  it("mints for a tree that needs no uid drop — the bare cache", async () => {
    let called = false;
    const credential = await resolveTreeRemoteCredential(
      "/workspace/repo-cache/abc",
      "origin",
      async () => { called = true; return { username: "u", password: "p" }; },
      url,
    );
    expect(called).toBe(true);
    expect(credential).toEqual({
      origin: "https://github.com",
      token: { username: "u", password: "p" },
    });
  });

  it("does NOT mint without a resolver", async () => {
    expect(
      await resolveTreeRemoteCredential("/w", "origin", undefined, url),
    ).toBeNull();
  });

  it("does NOT offer a credential to a non-https remote", async () => {
    let called = false;
    const credential = await resolveTreeRemoteCredential(
      "/workspace/sessions/s1/workspace",
      "origin",
      async () => { called = true; return { username: "u", password: "p" }; },
      async () => "/workspace/sessions/other/workspace",
    );
    expect(called).toBe(false);
    expect(credential).toBeNull();
  });

  it("degrades to null — never throws — when the resolver fails or declines", async () => {
    expect(
      await resolveTreeRemoteCredential("/w", "origin", async () => null, url),
    ).toBeNull();
    expect(
      await resolveTreeRemoteCredential(
        "/w", "origin",
        () => { throw new Error("mint exploded"); },
        url,
      ),
    ).toBeNull();
    expect(
      await resolveTreeRemoteCredential(
        "/w", "origin",
        async () => ({ username: "u", password: "p" }),
        () => { throw new Error("no such remote"); },
      ),
    ).toBeNull();
  });
});

describe("resolveTreeRemoteCredential with a declared LFS host (docs/320-lfs-host-credential)", () => {
  const url = async (): Promise<string> => "https://github.com/acme/widgets.git";
  const lfsHost = { origin: "https://lfs.example.com", username: "alice", password: "lfs-secret" };
  const register = (resolution: LfsHostResolution | null): string[] => {
    const seen: string[] = [];
    configureLfsHostCredentialResolver(async (dir) => {
      seen.push(dir);
      return resolution;
    });
    return seen;
  };
  const forLfs = { lfsHost: true };

  afterEach(() => { configureLfsHostCredentialResolver(undefined); });

  it("attaches the LFS host beside the remote's token when an LFS transfer asks", async () => {
    const seen = register({ credential: lfsHost });
    const credential = await resolveTreeRemoteCredential(
      "/w", "origin", async () => ({ username: "x-access-token", password: "ghs" }), url, forLfs,
    );
    expect(seen).toEqual(["/w"]);
    expect(credential).toEqual({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs" },
      lfsHost,
    });
  });

  it("never consults the LFS resolver for an operation that is not an LFS transfer", async () => {
    const seen = register({ credential: lfsHost });
    expect(await resolveTreeRemoteCredential("/w", "origin", async () => ({ username: "u", password: "p" }), url))
      .toEqual({ origin: "https://github.com", token: { username: "u", password: "p" } });
    expect(await resolveTreeRemoteCredential("/w", "origin", undefined, url)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("presents the LFS host alone when the remote has no token", async () => {
    register({ credential: lfsHost });
    expect(await resolveTreeRemoteCredential("/w", "origin", undefined, async () => "/some/local/remote", forLfs))
      .toEqual({ origin: "https://lfs.example.com", lfsHost });
  });

  it("keeps the LFS host on the anonymous retry after the remote refused its token", async () => {
    register({ credential: lfsHost });
    const credential = await resolveTreeRemoteCredential(
      "/w", "origin", async () => ({ username: "u", password: "stale" }), url, forLfs,
    );
    const attempts: (GitRemoteCredential | null)[] = [];
    await withPreemptiveAuthFallback(credential, "test", async (c) => {
      attempts.push(c);
      return attempts.length === 1 ? "HTTP 401" : "ok";
    }, (r) => r === "HTTP 401");
    expect(attempts[1]).toEqual({ origin: "https://github.com", lfsHost });
  });

  it("carries a refusal with or without a token, so the operation can say why", async () => {
    register({ refusal: "host mismatch", host: "lfs.example.com" });
    expect(await resolveTreeRemoteCredential("/w", "origin", async () => ({ username: "u", password: "p" }), url, forLfs))
      .toEqual({ origin: "https://github.com", token: { username: "u", password: "p" }, lfsHostRefusal: "host mismatch" });
    // Token-less: the helper reset still applies, and presents nothing.
    const alone = await resolveTreeRemoteCredential("/w", "origin", async () => null, url, forLfs);
    expect(alone).toEqual({ origin: "https://github.com", lfsHostRefusal: "host mismatch" });
    expect(gitCredentialConfig(alone!)).toEqual(["credential.helper="]);
  });

  it("turns a resolver that throws into a refusal, never a failed operation", async () => {
    configureLfsHostCredentialResolver(() => { throw new Error("database locked"); });
    const credential = await resolveTreeRemoteCredential(
      "/w", "origin", async () => ({ username: "u", password: "p" }), url, forLfs,
    );
    expect(credential?.lfsHostRefusal).toContain("database locked");
  });
});

describe("gitCredentialConfig against real git", () => {
  let tmpDir: string;
  let globalConfig: string;

  const fill = (input: string, args: string[], env: NodeJS.ProcessEnv = {}): string => {
    try {
      return execFileSync("git", [...args.flatMap((a) => ["-c", a]), "credential", "fill"], {
        input,
        encoding: "utf-8",
        cwd: tmpDir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return `FAILED: ${String((err as { stderr?: Buffer }).stderr ?? err)}`;
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-config-"));
    globalConfig = path.join(tmpDir, "gitconfig");
    // git config quotes the helper's semicolons, which would start config comments.
    fs.writeFileSync(globalConfig, "");
    execFileSync("git", [
      "config", "--file", globalConfig, "credential.helper",
      "!f() { echo username=inherited; echo password=inherited-pat; }; f",
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("the inherited helper answers when we add nothing (the state this replaces)", () => {
    const out = fill("protocol=https\nhost=github.com\n\n", []);
    expect(out).toContain("password=inherited-pat");
  });

  it("resets the inherited helper and answers with the supplied credential", () => {
    const credential = {
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_repo_scoped" },
    };
    const out = fill(
      "protocol=https\nhost=github.com\n\n",
      gitCredentialConfig(credential),
      gitCredentialEnv(credential),
    );
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=ghs_repo_scoped");
    expect(out).not.toContain("inherited-pat");
  });

  it("offers the credential to its own origin and to no other host", () => {
    const credential = {
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_repo_scoped" },
    };
    const out = fill(
      "protocol=https\nhost=evil.example\n\n",
      gitCredentialConfig(credential),
      gitCredentialEnv(credential),
    );
    expect(out).not.toContain("ghs_repo_scoped");
    expect(out).not.toContain("inherited-pat");
    expect(out).toContain("FAILED");
  });

  it("a token-less credential is genuinely anonymous, not quietly the global PAT", () => {
    const out = fill("protocol=https\nhost=github.com\n\n", gitCredentialConfig({ origin: "https://github.com" }));
    expect(out).not.toContain("inherited-pat");
    expect(out).toContain("FAILED");
  });

  it("answers a PATH-bearing fill, which is what a real fetch/push/LFS sends", () => {
    const credential = {
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_repo_scoped" },
    };
    const out = fill(
      "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n",
      gitCredentialConfig(credential),
      gitCredentialEnv(credential),
    );
    expect(out).toContain("password=ghs_repo_scoped");
    expect(out).not.toContain("inherited-pat");
  });

  it("scopes to the port as well as the host", () => {
    const credential = {
      origin: "https://ghe.example:8443",
      token: { username: "x-access-token", password: "ghs_enterprise" },
    };
    const args = gitCredentialConfig(credential);
    const env = gitCredentialEnv(credential);
    expect(fill("protocol=https\nhost=ghe.example:8443\n\n", args, env))
      .toContain("password=ghs_enterprise");
    expect(fill("protocol=https\nhost=ghe.example\n\n", args, env))
      .not.toContain("ghs_enterprise");
  });

  describe("with a declared LFS host", () => {
    const credential = {
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_repo_scoped" },
      lfsHost: { origin: "https://lfs.example.com", username: "alice", password: "lfs-secret" },
    };

    it("answers the LFS host with its own credential and the remote with the token", () => {
      const args = gitCredentialConfig(credential);
      const env = gitCredentialEnv(credential);
      const lfs = fill("protocol=https\nhost=lfs.example.com\n\n", args, env);
      expect(lfs).toContain("username=alice");
      expect(lfs).toContain("password=lfs-secret");
      expect(lfs).not.toContain("ghs_repo_scoped");
      const github = fill("protocol=https\nhost=github.com\n\n", args, env);
      expect(github).toContain("password=ghs_repo_scoped");
      expect(github).not.toContain("lfs-secret");
    });

    it("answers no other host, and resets the inherited helper for the LFS host too", () => {
      const args = gitCredentialConfig(credential);
      const env = gitCredentialEnv(credential);
      const other = fill("protocol=https\nhost=lfs.example.com.evil.example\n\n", args, env);
      expect(other).not.toContain("lfs-secret");
      expect(other).not.toContain("inherited-pat");
      expect(fill("protocol=http\nhost=lfs.example.com\n\n", args, env)).not.toContain("lfs-secret");
    });

    it("keeps the LFS secret out of argv, with or without a remote token", () => {
      for (const c of [credential, { origin: credential.lfsHost.origin, lfsHost: credential.lfsHost }]) {
        const { args, env } = gitCredentialSpawnOverrides(c);
        expect(args).toContain("credential.helper=");
        expect(args.join(" ")).not.toContain("lfs-secret");
        expect(Object.values(env)).toContain("lfs-secret");
      }
    });
  });

  it("refuses an origin that could reshape the config key", () => {
    expect(() => gitCredentialConfig({ origin: "https://github.com/../../x" })).toThrow(/Refusing/);
    expect(() => gitCredentialConfig({ origin: "https://github.com\nfoo" })).toThrow(/Refusing/);
  });
});

describe("gitCredentialSpawnOverrides", () => {
  it("is empty for a null credential, so a raw spawn site can spread it unconditionally", () => {
    expect(gitCredentialSpawnOverrides(null)).toEqual({ args: [], env: {} });
  });

  it("puts every config entry behind its own -c and the secret in the env, never the argv", () => {
    const { args, env } = gitCredentialSpawnOverrides({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_repo_scoped" },
    });
    expect(args[0]).toBe("-c");
    expect(args).toContain("credential.helper=");
    expect(args.filter((a) => a === "-c")).toHaveLength(2);
    expect(args.join(" ")).not.toContain("ghs_repo_scoped");
    expect(Object.values(env)).toContain("ghs_repo_scoped");
  });
});
