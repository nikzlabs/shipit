import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  gitCredentialConfig,
  gitCredentialEnv,
  gitCredentialSpawnOverrides,
  parseRemoteOrigin,
  resolveTreeRemoteCredential,
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
    // `initGlobalGitConfig` rewrites exactly these two prefixes to HTTPS
    // (docs/200), so git never speaks SSH and DOES want an HTTPS credential.
    // Reading the configured URL literally would decline one and the push would
    // fail with "could not read Username" — a regression against E1, which
    // authenticated these through the global inline helper. (Review finding.)
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
    // A fork's origin before it is re-pointed, another session's directory
    // added as a remote, and every test's bare path.
    expect(parseRemoteOrigin("/workspace/sessions/abc/workspace")).toBeNull();
    expect(parseRemoteOrigin("file:///tmp/bare.git")).toBeNull();
    // Any OTHER ssh remote stays null — the image ships no key, so ShipIt holds
    // nothing for it, and there is no rewrite that turns it into HTTPS.
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
    // docs/288-preemptive-github-auth req 1 inverted this. It used to decline
    // here, on the argument that a root-side git reads the global helper anyway
    // — but git consults that helper only after a 401, so declining meant the
    // ~280 bare-cache fetches an hour all went out anonymous. What still bounds
    // the credential is the resolver (github.com only), not the uid.
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
    // docs/266-orchestrator-git-trust-boundary req 6 / CLAUDE.md invariant 2: the post-turn path may not gain a
    // way to fail. A credential that cannot be minted falls back to the
    // behaviour that shipped with E1; it never aborts the operation.
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

/**
 * The security properties of the `-c` bundle, checked against the git that is
 * actually installed rather than against a reading of its documentation.
 *
 * Real git matters here for one reason above the others: the whole mechanism
 * rests on `credential.helper=` (empty) RESETTING a multi-valued list that the
 * global config has already populated. If that were not true, the orchestrator's
 * own helper would answer first and the repo-scoped credential would never be
 * reached — and on an App-only install that reads as "no credential" with no
 * error anywhere.
 */
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
      // Prompts are disabled, so "no helper answered" exits non-zero. That IS
      // the assertion in the negative cases below.
      return `FAILED: ${String((err as { stderr?: Buffer }).stderr ?? err)}`;
    }
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-config-"));
    globalConfig = path.join(tmpDir, "gitconfig");
    // Stand in for the orchestrator's own global helper — the one a dropped-uid
    // git must NOT end up using. Written through `git config` so the value is
    // escaped the way git expects (a raw `;` in a config file starts a comment).
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
    // Neither ours nor the inherited PAT: the reset removed the unscoped helper
    // and our replacement is scoped to github.com.
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
    // The other fixtures send only protocol+host. git-lfs and a
    // `credential.useHttpPath` install both add `path=owner/repo.git`, and a
    // URL-scoped helper that stopped matching those would leave every real
    // operation uncredentialed while this suite stayed green. (Review finding:
    // a missing fixture, not a defect — checked against the installed git.)
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
    // A different port is a different origin and gets nothing.
    expect(fill("protocol=https\nhost=ghe.example\n\n", args, env))
      .not.toContain("ghs_enterprise");
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
    // /proc/<pid>/cmdline is readable by every uid in the container.
    expect(args.join(" ")).not.toContain("ghs_repo_scoped");
    expect(Object.values(env)).toContain("ghs_repo_scoped");
  });
});
