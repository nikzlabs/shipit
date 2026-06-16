/**
 * docs/128 — service-level applyTemplate tests focused on the ops session path:
 * the server-authoritative kind="ops" must be stamped before any container can
 * boot, and the privileged template can only ever create a *fresh* session.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { applyTemplate, createRepoWithTemplate } from "./templates.js";
import { ServiceError } from "./types.js";
import { GitManager } from "../../shared/git.js";
import { RepoGit } from "../repo-git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import type { SessionManager } from "../sessions.js";
import type { SessionInfo } from "../../shared/types.js";

function fakeGitManager(): GitManager {
  return {
    init: async () => {},
    autoCommit: async () => {},
  } as unknown as GitManager;
}

interface FakeSessionState {
  kinds: Record<string, string>;
  sessions: Record<string, Partial<SessionInfo>>;
}

function fakeSessionManager(state: FakeSessionState): SessionManager {
  return {
    get: (id: string) =>
      state.sessions[id]
        ? ({ id, kind: state.kinds[id], ...state.sessions[id] } as SessionInfo)
        : undefined,
    setKind: (id: string, kind: string) => {
      state.kinds[id] = kind;
    },
  } as unknown as SessionManager;
}

describe("applyTemplate (service) — ops session", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function freshSessionDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-tmpl-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("stamps kind=ops and writes the privileged workspace on a fresh session", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    const createSessionDir = async (title: string) => {
      expect(title).toContain("Ops —");
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
    );

    // The server-authoritative kind was set.
    expect(state.kinds["new-sess"]).toBe("ops");
    expect(result.session?.kind).toBe("ops");
    // Privileged workspace files landed on disk.
    expect(fs.existsSync(path.join(sessionDir, "shipit.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "docker-compose.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(sessionDir, "shipit.yaml"), "utf-8")).toContain(
      "x-shipit-host-mounts",
    );
  });

  it("SECURITY: refuses to retrofit an existing session into an ops session", async () => {
    const state: FakeSessionState = {
      kinds: {},
      sessions: { "existing-sess": { id: "existing-sess", workspaceDir: "/tmp/whatever" } },
    };
    await expect(
      applyTemplate(
        fakeSessionManager(state),
        () => fakeGitManager(),
        async () => {
          throw new Error("should not create a fresh dir");
        },
        "ops",
        "existing-sess",
      ),
    ).rejects.toBeInstanceOf(ServiceError);
    // kind must not have been set on the existing session.
    expect(state.kinds["existing-sess"]).toBeUndefined();
  });

  it("seeds an investigation prompt and target-named title when given a targetSessionId", async () => {
    const state: FakeSessionState = {
      kinds: {},
      sessions: {
        "target-sess": {
          id: "target-sess",
          title: "Flaky checkout flow",
          branch: "fix/checkout",
          remoteUrl: "https://github.com/owner/shop.git",
        },
      },
    };
    const sessionDir = freshSessionDir();
    let createdTitle = "";
    const createSessionDir = async (title: string) => {
      createdTitle = title;
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
      undefined,
      "target-sess",
    );

    // Fresh ops session is still created (target is a reference, not retrofit).
    expect(state.kinds["new-sess"]).toBe("ops");
    // Named after its quarry, and the seed bakes in the concrete target id.
    expect(createdTitle).toBe("Ops — debug: Flaky checkout flow");
    expect(result.seedPrompt).toBeDefined();
    expect(result.seedPrompt).toContain("Flaky checkout flow");
    expect(result.seedPrompt).toContain("target-sess");
    expect(result.seedPrompt).toContain('--filter "name=target-sess"');
  });

  it("ignores an unknown targetSessionId and falls back to a generic ops session", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    let createdTitle = "";
    const createSessionDir = async (title: string) => {
      createdTitle = title;
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    const result = await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "ops",
      undefined,
      "does-not-exist",
    );

    expect(state.kinds["new-sess"]).toBe("ops");
    expect(result.seedPrompt).toBeUndefined();
    expect(createdTitle).toContain("Ops —");
    expect(createdTitle).not.toContain("debug:");
  });

  it("does NOT set kind for an ordinary template", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    const createSessionDir = async (title: string) => {
      state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
      return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
    };

    await applyTemplate(
      fakeSessionManager(state),
      () => fakeGitManager(),
      createSessionDir,
      "static-html",
    );

    expect(state.kinds["new-sess"]).toBeUndefined();
  });
});

/**
 * docs/192 — regression guard for the non-bare-cache bug. The template
 * creation path used to `git init` the shared cache dir as a *non-bare*
 * working tree with `main` checked out, which made every later cache fetch
 * fail with "refusing to fetch into branch 'refs/heads/main' checked out".
 * The cache must be a genuine bare repo, identical to the add-by-URL path.
 */
describe("createRepoWithTemplate (service) — bare cache", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmpl-repo-test-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(tmpDir, "credentials"));
    setGitIdentity("Test User", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the shared repo cache as a bare repo (not a non-bare working tree)", async () => {
    // A local bare repo stands in for the freshly-created GitHub remote, so the
    // scaffold push and the cache's `cloneBare` operate against a real origin
    // without needing network or credentials.
    const originDir = path.join(tmpDir, "origin.git");
    fs.mkdirSync(originDir, { recursive: true });
    execSync("git init --bare -b main", { cwd: originDir, stdio: "pipe" });

    const cacheDir = path.join(tmpDir, "repo-cache", "abc123");

    const result = await createRepoWithTemplate(
      (dir) => new GitManager(dir),
      (dir) => new RepoGit(dir),
      {
        authenticated: true,
        createRepo: async () => ({ success: true, cloneUrl: originDir }),
      },
      () => cacheDir,
      "my-static-site",
      "static-html",
    );

    expect(result.success).toBe(true);
    expect(result.repoUrl).toBe(originDir);

    // The cache is a genuine bare repo …
    const isBare = execSync("git rev-parse --is-bare-repository", { cwd: cacheDir })
      .toString()
      .trim();
    expect(isBare).toBe("true");

    // … with NO checked-out working tree (the file the template scaffolds must
    // not be sitting at the top level of the cache dir).
    expect(fs.existsSync(path.join(cacheDir, "index.html"))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, ".git"))).toBe(false);

    // … carrying the pushed template in its object store …
    const tree = execSync("git ls-tree --name-only main", { cwd: cacheDir }).toString();
    expect(tree).toContain("index.html");

    // … and no repo-local credential helper (the bare cache is orchestrator-only
    // and never mounted into a session container, so it needs no broker helper).
    const localHelper = execSync("git config --local --get-all credential.helper || true", {
      cwd: cacheDir,
    })
      .toString()
      .trim();
    expect(localHelper).toBe("");

    // … and origin repointed at the real remote, not the throwaway scaffold dir
    // (which is deleted — a stale origin would break every future cache fetch).
    const originUrl = execSync("git config --get remote.origin.url", { cwd: cacheDir })
      .toString()
      .trim();
    expect(originUrl).toBe(originDir);

    // The remote actually received the scaffold push on main.
    const originLog = execSync("git log --format=%s main", { cwd: originDir }).toString();
    expect(originLog).toContain("Initial setup: Static HTML");
  });

  it("threads a trimmed org owner into createRepo, and omits it for the personal account", async () => {
    const seen: { opts: { owner?: string } }[] = [];
    const run = (owner?: string) => {
      // Each run gets its own bare origin — pushing two fresh scaffolds at the
      // same remote's main would be rejected non-fast-forward.
      const idx = seen.length;
      const originDir = path.join(tmpDir, `origin-${idx}.git`);
      fs.mkdirSync(originDir, { recursive: true });
      execSync("git init --bare -b main", { cwd: originDir, stdio: "pipe" });
      return createRepoWithTemplate(
        (dir) => new GitManager(dir),
        (dir) => new RepoGit(dir),
        {
          authenticated: true,
          createRepo: async (_name, opts) => {
            seen.push({ opts });
            return { success: true, cloneUrl: originDir };
          },
        },
        () => path.join(tmpDir, "repo-cache", `c${idx}`),
        "my-site",
        "static-html",
        undefined,
        undefined,
        owner,
      );
    };

    // Whitespace-padded org login is trimmed and routed as `owner`.
    await run("  acme  ");
    expect(seen[0].opts.owner).toBe("acme");

    // Personal account (empty owner) must NOT carry an owner key — otherwise it
    // would hit POST /orgs/{owner}/repos with a username and 404/422.
    await run("");
    expect("owner" in seen[1].opts).toBe(false);
  });
});
