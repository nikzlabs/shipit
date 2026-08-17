import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import type { GitTreeUidDeps } from "./git-tree-uid.js";
import type { RemoteOrigin } from "./git-remote-credential.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * docs/266-orchestrator-git-trust-boundary E3 (planning#404) — which {@link GitManager} operations ask for a
 * credential, and which must never.
 *
 * `gitTreeUidDeps` fakes the dropped-uid state. It has to: `resolveGitTreeUid`
 * answers "no drop" for any process that is not root, and a session container
 * has no root and refuses `unshare -r`, so the branch this whole feature exists
 * for is otherwise unreachable from a test. What that leaves unproven is
 * recorded in `docs/266-orchestrator-git-trust-boundary/plan.md` §4 — the
 * *decision* is exercised here, the *setuid spawn* is not.
 */
const DROPPED: GitTreeUidDeps = {
  getuid: () => 0,
  statOwner: () => ({ uid: 1000, gid: 1000 }),
};

const NOT_DROPPED: GitTreeUidDeps = {
  getuid: () => 1000,
  statOwner: () => ({ uid: 1000, gid: 1000 }),
};

describe("GitManager: which ops resolve a remote credential", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let asked: RemoteOrigin[];

  const manager = (treeUidDeps: GitTreeUidDeps): GitManager =>
    new GitManager(tmpDir, {
      gitTreeUidDeps: treeUidDeps,
      resolveRemoteCredential: async (remote) => {
        asked.push(remote);
        // Deliberately declines: this suite is about WHICH ops ask and with
        // what, and declining keeps every op on its unchanged code path so a
        // failing network call cannot be mistaken for a wiring failure.
        return null;
      },
    });

  beforeEach(async () => {
    asked = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-wiring-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
    const setup = new GitManager(tmpDir);
    await setup.init();
    await setup.addRemote("origin", "https://github.com/acme/widgets.git");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a remote op on a dropped-uid tree asks, naming the parsed remote", async () => {
    // The push itself cannot succeed (github.com/acme/widgets is not ours), and
    // that is fine — the assertion is that the credential seam was consulted
    // with the right remote before git ran.
    await expect(manager(DROPPED).fetch("origin")).rejects.toThrow();
    expect(asked).toEqual([{
      origin: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    }]);
  });

  it("the auto-commit path never asks — it acquires no network dependency", async () => {
    // docs/266-orchestrator-git-trust-boundary req 6 and CLAUDE.md invariant 2. `autoCommit` is purely local;
    // if it ever started resolving a credential it would gain a way to fail
    // for an environmental reason, and uncommitted agent work has no reflog
    // entry and no recovery.
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content\n");
    const result = await manager(DROPPED).autoCommit("a turn");
    expect(result.commitHash).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("a git that did NOT drop uid never asks", async () => {
    // The bare cache, /opt/shipit, local mode, the session worker, every test.
    // They keep reading the orchestrator's own global helper, which reads the
    // root-only PAT file.
    await expect(manager(NOT_DROPPED).fetch("origin")).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("a local-path remote is never offered a credential", async () => {
    // A fork's origin before it is re-pointed, and another session's directory
    // added as a remote. Offering a GitHub token to either is the host-confusion
    // bug docs/172 Gap 2 fixed.
    const bare = path.join(os.tmpdir(), `shipit-cred-wiring-bare-${process.pid}.git`);
    fs.rmSync(bare, { recursive: true, force: true });
    const git = manager(DROPPED);
    await git.addRemote("local", bare);
    await expect(git.fetch("local")).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("a remote that does not exist resolves nothing rather than throwing early", async () => {
    const git = manager(DROPPED);
    await expect(git.fetch("nope")).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});
