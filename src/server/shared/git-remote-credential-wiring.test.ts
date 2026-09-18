import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitManager } from "./git.js";
import type { RemoteOrigin } from "./git-remote-credential.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

describe("GitManager: which ops resolve a remote credential", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;
  let asked: RemoteOrigin[];

  const manager = (): GitManager =>
    new GitManager(tmpDir, {
      resolveRemoteCredential: async (remote) => {
        asked.push(remote);
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
    // No credential is supplied; only the resolver request is under test.
    await expect(manager().fetch("origin")).rejects.toThrow();
    expect(asked).toEqual([{
      origin: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    }]);
  });

  it("the auto-commit path never asks — it acquires no network dependency", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content\n");
    const result = await manager().autoCommit("a turn");
    expect(result.commitHash).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it("a local-path remote is never offered a credential", async () => {
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
