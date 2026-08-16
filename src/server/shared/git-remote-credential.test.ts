import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { GitTreeUidDeps } from "./git-tree-uid.js";
import {
  gitCredentialConfig,
  gitCredentialEnv,
  parseRemoteOrigin,
  resolveTreeRemoteCredential,
} from "./git-remote-credential.js";

/**
 * The dropped-uid state, faked. `resolveGitTreeUid` answers "no drop" for any
 * process that is not root, and this container has no root and refuses
 * `unshare -r` — so the branch docs/266 E3 exists for is only reachable
 * through this seam. What it can NOT prove is stated in `plan.md` §4.
 */
const AS_ROOT_ON_WORKER_TREE: GitTreeUidDeps = {
  getuid: () => 0,
  statOwner: () => ({ uid: 1000, gid: 1000 }),
};

const NOT_ROOT: GitTreeUidDeps = {
  getuid: () => 1000,
  statOwner: () => ({ uid: 1000, gid: 1000 }),
};

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

  it("returns null for the remotes that authenticate nothing", () => {
    // A fork's origin before it is re-pointed, another session's directory
    // added as a remote, and every test's bare path.
    expect(parseRemoteOrigin("/workspace/sessions/abc/workspace")).toBeNull();
    expect(parseRemoteOrigin("file:///tmp/bare.git")).toBeNull();
    // SSH: the orchestrator rewrites GitHub SSH URLs to HTTPS globally
    // (docs/200) and ships no key, so one that survives has no credential we
    // hold.
    expect(parseRemoteOrigin("git@github.com:acme/widgets.git")).toBeNull();
    expect(parseRemoteOrigin("ssh://git@github.com/acme/widgets.git")).toBeNull();
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

  it("mints for a dropped-uid git on an https remote", async () => {
    const seen: string[] = [];
    const credential = await resolveTreeRemoteCredential(
      "/workspace/sessions/s1/workspace",
      "origin",
      async (remote) => {
        seen.push(`${remote.host}:${remote.owner}/${remote.repo}`);
        return { username: "x-access-token", password: "ghs_installation" };
      },
      url,
      AS_ROOT_ON_WORKER_TREE,
    );
    expect(seen).toEqual(["github.com:acme/widgets"]);
    expect(credential).toEqual({
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghs_installation" },
    });
  });

  it("does NOT mint when the tree needs no uid drop", async () => {
    // The bare cache, /opt/shipit, local mode, the session worker, every test.
    // Those keep reading the orchestrator's own global helper, which reads the
    // root-only PAT file — handing them a second credential would be churn.
    let called = false;
    const credential = await resolveTreeRemoteCredential(
      "/workspace/repo-cache/abc",
      "origin",
      async () => { called = true; return { username: "u", password: "p" }; },
      url,
      NOT_ROOT,
    );
    expect(called).toBe(false);
    expect(credential).toBeNull();
  });

  it("does NOT mint without a resolver", async () => {
    expect(
      await resolveTreeRemoteCredential("/w", "origin", undefined, url, AS_ROOT_ON_WORKER_TREE),
    ).toBeNull();
  });

  it("does NOT offer a credential to a non-https remote", async () => {
    let called = false;
    const credential = await resolveTreeRemoteCredential(
      "/workspace/sessions/s1/workspace",
      "origin",
      async () => { called = true; return { username: "u", password: "p" }; },
      async () => "/workspace/sessions/other/workspace",
      AS_ROOT_ON_WORKER_TREE,
    );
    expect(called).toBe(false);
    expect(credential).toBeNull();
  });

  it("degrades to null — never throws — when the resolver fails or declines", async () => {
    // docs/266 req 6 / CLAUDE.md invariant 2: the post-turn path may not gain a
    // way to fail. A credential that cannot be minted falls back to the
    // behaviour that shipped with E1; it never aborts the operation.
    expect(
      await resolveTreeRemoteCredential("/w", "origin", async () => null, url, AS_ROOT_ON_WORKER_TREE),
    ).toBeNull();
    expect(
      await resolveTreeRemoteCredential(
        "/w", "origin",
        () => { throw new Error("mint exploded"); },
        url,
        AS_ROOT_ON_WORKER_TREE,
      ),
    ).toBeNull();
    expect(
      await resolveTreeRemoteCredential(
        "/w", "origin",
        async () => ({ username: "u", password: "p" }),
        () => { throw new Error("no such remote"); },
        AS_ROOT_ON_WORKER_TREE,
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

  it("refuses an origin that could reshape the config key", () => {
    expect(() => gitCredentialConfig({ origin: "https://github.com/../../x" })).toThrow(/Refusing/);
    expect(() => gitCredentialConfig({ origin: "https://github.com\nfoo" })).toThrow(/Refusing/);
  });
});
