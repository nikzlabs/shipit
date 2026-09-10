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

    expect(state.kinds["new-sess"]).toBe("ops");
    expect(result.session?.kind).toBe("ops");
    expect(fs.existsSync(path.join(sessionDir, "shipit.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "docker-compose.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(sessionDir, "shipit.yaml"), "utf-8")).toContain(
      "x-shipit-host-mounts",
    );
  });

  it("still commits the applied template for an ops session", async () => {
    const state: FakeSessionState = { kinds: {}, sessions: {} };
    const sessionDir = freshSessionDir();
    const subjects: string[] = [];
    const recordingGit = {
      init: async () => {},
      autoCommit: async (summary: string) => { subjects.push(summary); },
    } as unknown as GitManager;

    await applyTemplate(
      fakeSessionManager(state),
      () => recordingGit,
      async (title: string) => {
        state.sessions["new-sess"] = { id: "new-sess", title, workspaceDir: sessionDir };
        return { appSessionId: "new-sess", sessionDir, workspaceDir: sessionDir };
      },
      "ops",
    );

    expect(state.kinds["new-sess"]).toBe("ops");
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toContain("Apply template:");
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

    expect(state.kinds["new-sess"]).toBe("ops");
    expect(createdTitle).toBe("Ops — debug: Flaky checkout flow");
    expect(result.seedPrompt).toBeDefined();
    expect(result.seedPrompt).toBe(
      'Investigate the session "Flaky checkout flow" (id `target-sess`, branch `fix/checkout`, https://github.com/owner/shop.git). This is a read-only investigation.\n\nContext: ',
    );
    expect(result.seedPrompt).not.toContain("docker");
    expect(result.seedPrompt).not.toContain("journalctl");
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

    const isBare = execSync("git rev-parse --is-bare-repository", { cwd: cacheDir })
      .toString()
      .trim();
    expect(isBare).toBe("true");

    expect(fs.existsSync(path.join(cacheDir, "index.html"))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, ".git"))).toBe(false);

    const tree = execSync("git ls-tree --name-only main", { cwd: cacheDir }).toString();
    expect(tree).toContain("index.html");

    const localHelper = execSync("git config --local --get-all credential.helper || true", {
      cwd: cacheDir,
    })
      .toString()
      .trim();
    expect(localHelper).toBe("");

    const originUrl = execSync("git config --get remote.origin.url", { cwd: cacheDir })
      .toString()
      .trim();
    expect(originUrl).toBe(originDir);

    const originLog = execSync("git log --format=%s main", { cwd: originDir }).toString();
    expect(originLog).toContain("Initial setup: Static HTML");
  });

  it("threads a trimmed org owner into createRepo, and omits it for the personal account", async () => {
    const seen: { opts: { owner?: string } }[] = [];
    const run = (owner?: string) => {
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

    await run("  acme  ");
    expect(seen[0].opts.owner).toBe("acme");

    await run("");
    expect("owner" in seen[1].opts).toBe(false);
  });
});
