import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import type { RemoteOrigin } from "./git-remote-credential.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * docs/266-orchestrator-git-trust-boundary E3 (planning#404) — which
 * {@link GitManager} operations ask for a credential, and which must never.
 *
 * docs/288-preemptive-github-auth removed the uid predicate this suite used to
 * fake: a remote op asks whatever identity it will run as, because the point is
 * no longer "a dropped git cannot read the PAT file" but "the credential has to
 * be on the FIRST request". What still decides is the REMOTE — the resolver is
 * github.com-only — so the local-path and unknown-remote cases below are the
 * ones carrying the boundary now.
 */
describe("GitManager: which ops resolve a remote credential", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let asked: RemoteOrigin[];

  const manager = (): GitManager =>
    new GitManager(tmpDir, {
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

  it("a remote op asks, naming the parsed remote", async () => {
    // The fetch itself cannot succeed (github.com/acme/widgets is not ours), and
    // that is fine — the assertion is that the credential seam was consulted
    // with the right remote before git ran.
    await expect(manager().fetch("origin")).rejects.toThrow();
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
    const result = await manager().autoCommit("a turn");
    expect(result.commitHash).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("a local-path remote is never offered a credential", async () => {
    // A fork's origin before it is re-pointed, and another session's directory
    // added as a remote. Offering a GitHub token to either is the host-confusion
    // bug docs/172 Gap 2 fixed.
    const bare = path.join(os.tmpdir(), `shipit-cred-wiring-bare-${process.pid}.git`);
    fs.rmSync(bare, { recursive: true, force: true });
    const git = manager();
    await git.addRemote("local", bare);
    await expect(git.fetch("local")).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("a remote that does not exist resolves nothing rather than throwing early", async () => {
    const git = manager();
    await expect(git.fetch("nope")).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});
