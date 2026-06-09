/**
 * install-session service tests (docs/149 v1c).
 *
 * Verifies the repo-targeted install spawns a dedicated session, writes the
 * skill + commits in THAT session's workspace, opens a PR, graduates the
 * session, and leaves a pre-existing "current" session completely untouched.
 *
 * `agentCreatePr` / `activatePendingAutoMergeForPr` are mocked so the test
 * doesn't push to a real remote; `installPlugin` runs for real against a
 * fixture catalog so the file-write + path-scoped commit are exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { DatabaseManager } from "../../shared/database.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { GitManager } from "../../shared/git.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { MarketplaceStore } from "../marketplace-store.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { GitHubAuthManager } from "../github-auth.js";

// Stub the PR-create glue so no real push/remote is needed.
const agentCreatePrMock = vi.fn(async () => ({
  number: 7,
  url: "https://github.com/acme/widgets/pull/7",
  title: "Install commit-commands skill",
  baseBranch: "main",
  headBranch: "shipit/install-commit-commands-rand",
  insertions: 4,
  deletions: 0,
  alreadyExisted: false,
}));
vi.mock("./github.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    agentCreatePr: (...args: unknown[]) => agentCreatePrMock(...(args as [])),
    activatePendingAutoMergeForPr: vi.fn(async () => undefined),
  };
});

// Imported AFTER the mock is registered.
const { installPluginAsSession } = await import("./install-session.js");

const PLUGIN_NAME = "commit-commands";

function makeFakeCatalog(cacheRoot: string, id: string): void {
  const cacheDir = path.join(cacheRoot, id);
  fs.mkdirSync(path.join(cacheDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: id,
      plugins: [{ name: PLUGIN_NAME, description: "demo", source: `./plugins/${PLUGIN_NAME}`, author: { name: "Anthropic" } }],
    }),
  );
  const skillDir = path.join(cacheDir, "plugins", PLUGIN_NAME, "skills", "commit");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: commit\ndescription: commit\n---\n\nStage and commit\n");
}

async function initRepoOnBranch(workspace: string, branch: string): Promise<void> {
  fs.mkdirSync(workspace, { recursive: true });
  const sg = simpleGit(workspace);
  await sg.init(["--initial-branch=main"]);
  await sg.addConfig("user.name", "Test", undefined, "local");
  await sg.addConfig("user.email", "test@example.com", undefined, "local");
  fs.writeFileSync(path.join(workspace, "README.md"), "hi\n");
  await sg.add(["README.md"]);
  await sg.commit("init");
  await sg.raw(["checkout", "-b", branch]);
}

describe("installPluginAsSession (docs/149 v1c)", () => {
  let tmp: string;
  let dbm: DatabaseManager;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let store: MarketplaceStore;
  let cacheRoot: string;
  let agentRegistry: AgentRegistry;
  let nextSession = 0;
  const repoUrl = "https://github.com/acme/widgets.git";

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-session-"));
    dbm = new DatabaseManager(":memory:");
    sessionManager = new SessionManager(dbm);
    repoStore = new RepoStore(dbm);
    repoStore.add(repoUrl);
    store = new MarketplaceStore(dbm);
    store.seedIfMissing({ id: "test-catalog", source: { kind: "github", ownerRepo: "test/test" }, agentId: "claude", autoUpdate: true });
    cacheRoot = path.join(tmp, "marketplace-cache");
    makeFakeCatalog(cacheRoot, "test-catalog");
    agentRegistry = new AgentRegistry({ checkBinary: () => Promise.resolve(true) });
    await agentRegistry.detect();
    nextSession = 0;
    agentCreatePrMock.mockClear();
  });

  afterEach(() => {
    dbm.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function claimService(): ClaimSessionService {
    return {
      claim: vi.fn(async (url: string) => {
        nextSession += 1;
        const sessionId = `install-${nextSession}`;
        const workspaceDir = path.join(tmp, sessionId, "workspace");
        await initRepoOnBranch(workspaceDir, "shipit/rand123");
        sessionManager.track(sessionId, "Warm session", workspaceDir);
        sessionManager.setRemoteUrl(sessionId, url);
        sessionManager.setWarm(sessionId, true);
        return { sessionId, workspaceDir, fetchDurationMs: 0, claimPath: "slow-clone" as const };
      }),
    };
  }

  function deps(overrides: Partial<{ authenticated: boolean }> = {}) {
    const prStatusPoller = {
      trackSession: vi.fn(),
      forceRefreshSession: vi.fn(),
      getStatus: vi.fn(() => undefined),
    } as unknown as PrStatusPoller;
    return {
      claimService: claimService(),
      sessionManager,
      runnerRegistry: { get: vi.fn(() => undefined) } as unknown as SessionRunnerRegistry,
      repoStore,
      createGitManager: (dir: string) => new GitManager(dir),
      agentRegistry,
      marketplaceStore: store,
      cacheRoot,
      githubAuthManager: { authenticated: overrides.authenticated ?? true } as unknown as GitHubAuthManager,
      sseBroadcast: vi.fn(),
      defaultAgentId: "claude" as const,
      prStatusPoller,
    };
  }

  it("spawns a session, writes+commits the skill there, and opens a PR", async () => {
    const result = await installPluginAsSession(deps(), {
      repoUrl,
      marketplaceId: "test-catalog",
      pluginName: PLUGIN_NAME,
    });

    expect(result.pr).toEqual({ number: 7, url: "https://github.com/acme/widgets/pull/7" });
    expect(result.sessionId).toBe("install-1");
    expect(result.branch).toBe("shipit/install-commit-commands-rand123");
    expect(agentCreatePrMock).toHaveBeenCalledTimes(1);

    // The skill landed in the NEW session's workspace, committed.
    const ws = path.join(tmp, "install-1", "workspace");
    const skillMd = path.join(ws, ".claude", "skills", `${PLUGIN_NAME}__commit`, "SKILL.md");
    expect(fs.existsSync(skillMd)).toBe(true);
    expect(fs.readFileSync(skillMd, "utf-8")).toContain("name: commit-commands:commit");
    const log = await simpleGit(ws).log();
    expect(log.latest?.message).toMatch(/Install commit-commands/);

    // Session graduated (no longer warm) and is on the install branch.
    // `warm` is only present on the row when true, so graduated reads as falsy.
    const session = sessionManager.get("install-1");
    expect(session?.warm).not.toBe(true);
    expect(session?.branch).toBe("shipit/install-commit-commands-rand123");
  });

  it("leaves a pre-existing session untouched", async () => {
    // A "current" session the user is working in.
    const currentWs = path.join(tmp, "current", "workspace");
    await initRepoOnBranch(currentWs, "shipit/current-work");
    sessionManager.track("current", "Current work", currentWs);
    sessionManager.setBranch("current", "shipit/current-work");
    sessionManager.setWarm("current", false);

    await installPluginAsSession(deps(), { repoUrl, marketplaceId: "test-catalog", pluginName: PLUGIN_NAME });

    // No skill files in the current session's workspace.
    expect(fs.existsSync(path.join(currentWs, ".claude", "skills"))).toBe(false);
    // Current session row unchanged.
    const current = sessionManager.get("current");
    expect(current?.branch).toBe("shipit/current-work");
    expect(current?.workspaceDir).toBe(currentWs);
  });

  it("fails fast (401) when GitHub is not connected, without claiming", async () => {
    const d = deps({ authenticated: false });
    await expect(
      installPluginAsSession(d, { repoUrl, marketplaceId: "test-catalog", pluginName: PLUGIN_NAME }),
    ).rejects.toThrow(ServiceError);
    expect(d.claimService.claim).not.toHaveBeenCalled();
    expect(agentCreatePrMock).not.toHaveBeenCalled();
  });
});
