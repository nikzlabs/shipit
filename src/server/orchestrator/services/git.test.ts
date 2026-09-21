// Short fixture passwords avoid matching the secret scanner's eight-character threshold.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { setGitRemote, gitPush } from "./git.js";
import type { GitHubAuthManager } from "../github-auth.js";

let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  sessionManager = new SessionManager(dbManager);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-set-remote-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  execSync("git init -b main", { cwd: workspaceDir, stdio: "ignore" });
  sessionManager.track("s1", "S", workspaceDir);
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * docs/312-base-branch-push-protection req 7 — this endpoint names the branch, so
 * it reaches a shared one without the workspace ever being checked out there. The
 * guards on the automatic push paths all read `getCurrentBranch()` and miss it.
 */
describe("gitPush refuses a shared branch the caller names", () => {
  const auth = { authenticated: true } as unknown as GitHubAuthManager;

  function seedRemote(): string {
    const bare = path.join(tmpDir, "remote.git");
    execSync(`git init --bare -b main "${bare}"`, { stdio: "ignore" });
    execSync("git config user.email t@t && git config user.name T", { cwd: workspaceDir, stdio: "ignore", shell: "/bin/bash" });
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "# seed\n");
    execSync("git add -A && git commit -m seed --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore", shell: "/bin/bash" });
    execSync(`git remote add origin "${bare}" && git push -u origin main`, { cwd: workspaceDir, stdio: "ignore", shell: "/bin/bash" });
    execSync("git checkout -q -b shipit/work", { cwd: workspaceDir, stdio: "ignore" });
    return bare;
  }

  it("refuses an explicitly named default branch, and does not move the remote", async () => {
    const bare = seedRemote();
    const before = execSync("git rev-parse refs/heads/main", { cwd: bare }).toString().trim();
    fs.writeFileSync(path.join(workspaceDir, "a.txt"), "a\n");
    execSync("git add -A && git commit -m a --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore", shell: "/bin/bash" });
    execSync("git branch -f main HEAD", { cwd: workspaceDir, stdio: "ignore" });

    await expect(gitPush(new GitManager(workspaceDir), auth, "origin", "main"))
      .rejects.toThrow(/default branch/);
    expect(execSync("git rev-parse refs/heads/main", { cwd: bare }).toString().trim()).toBe(before);
  });

  it("still pushes the session's own branch", async () => {
    const bare = seedRemote();
    fs.writeFileSync(path.join(workspaceDir, "a.txt"), "a\n");
    execSync("git add -A && git commit -m a --no-gpg-sign", { cwd: workspaceDir, stdio: "ignore", shell: "/bin/bash" });

    const result = await gitPush(new GitManager(workspaceDir), auth, "origin", "shipit/work");

    expect(result.success).toBe(true);
    expect(execSync("git rev-parse refs/heads/shipit/work", { cwd: bare }).toString().trim())
      .toBe(execSync("git rev-parse HEAD", { cwd: workspaceDir }).toString().trim());
  });
});

describe("setGitRemote does not persist a credential (docs/262 req 19)", () => {
  const cases: [name: string, typed: string, stored: string][] = [
    [
      "http(s) userinfo",
      "https://x-access-token:pw@github.com/o/r.git",
      "https://github.com/o/r.git",
    ],
    [
      "a token in the query string",
      "https://github.com/o/r.git?access_token=pw",
      "https://github.com/o/r.git",
    ],
    [
      "an ssh password, keeping the ssh user",
      "ssh://git:pw@example.com/o/r.git",
      "ssh://git@example.com/o/r.git",
    ],
  ];

  for (const [name, typed, stored] of cases) {
    it(`strips ${name} from the config and the session row`, async () => {
      const result = await setGitRemote(new GitManager(workspaceDir), sessionManager, "s1", "origin", typed);

      expect(result.remotes.find((r) => r.name === "origin")?.url).toBe(stored);
      expect(sessionManager.get("s1")?.remoteUrl).toBe(stored);
      const config = fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8");
      expect(config).not.toContain("pw@");
      expect(config).not.toContain("access_token");
    });
  }

  it("leaves an ordinary remote exactly as typed", async () => {
    const url = "https://github.com/o/r.git";
    await setGitRemote(new GitManager(workspaceDir), sessionManager, "s1", "origin", url);
    expect(sessionManager.get("s1")?.remoteUrl).toBe(url);
  });

  it("does not touch the session row for a non-origin remote", async () => {
    await setGitRemote(new GitManager(workspaceDir), sessionManager, "s1", "upstream", "https://u:pw@github.com/o/r.git");
    expect(sessionManager.get("s1")?.remoteUrl).toBe("");
    expect(fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8")).not.toContain("pw@");
  });
});
