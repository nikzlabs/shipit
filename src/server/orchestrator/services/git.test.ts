// Short fixture passwords avoid matching the secret scanner's eight-character threshold.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { setGitRemote, gitPush, summarizeGitError, untrackedOverwritePaths } from "./git.js";
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

// simple-git's message for a real sync failure: dropped-uid warnings first, and
// the progress line ending in \r rather than \n before git's actual error.
const UNTRACKED_OVERWRITE_STDERR = [
  "warning: unable to access '/root/.config/git/attributes': Permission denied",
  "warning: unable to access '/root/.config/git/attributes': Permission denied",
  "Rebasing (1/8)\rerror: The following untracked working tree files would be overwritten by merge:",
  "\tapp/.vite/deps/a.js",
  "\tapp/.vite/deps/a.js.map",
  "\tapp/.vite/deps/_metadata.json",
  "\tapp/.vite/vitest/results.json",
  "\tapp/.vite/deps/b.js",
  "Please move or remove them before you merge.",
  "Aborting",
  "hint: Could not execute the todo command",
  "hint: ",
  "hint:     pick 0123456789abcdef0123456789abcdef01234567 add build output",
  "hint: ",
  "hint: It has been rescheduled; To edit the command before continuing, please",
  "Could not apply 0123456... add build output",
  "",
].join("\n");

describe("summarizeGitError", () => {
  it("leads with git's error line, drops warnings, hints and progress, and caps the path list", () => {
    expect(summarizeGitError(UNTRACKED_OVERWRITE_STDERR)).toBe(
      "error: The following untracked working tree files would be overwritten by merge: "
      + "`app/.vite/deps/a.js`, `app/.vite/deps/a.js.map`, `app/.vite/deps/_metadata.json` and 2 more",
    );
  });

  it("keeps every error and fatal line, in order", () => {
    expect(summarizeGitError("warning: x\nerror: first\nhint: y\nfatal: second\n"))
      .toBe("error: first fatal: second");
  });

  it("lists a short path list in full", () => {
    expect(summarizeGitError("error: would be overwritten:\n\ta\n\tb\nAborting\n"))
      .toBe("error: would be overwritten: `a`, `b`");
  });

  it("falls back to the message without noise when git printed no error line", () => {
    expect(summarizeGitError("Too many conflict iterations (>10) — rebase aborted"))
      .toBe("Too many conflict iterations (>10) — rebase aborted");
    expect(summarizeGitError("warning: noise\nRebasing (2/3)\rsomething odd\nhint: try again\n"))
      .toBe("something odd");
  });
});

describe("untrackedOverwritePaths", () => {
  it("returns every path git refused to overwrite", () => {
    expect(untrackedOverwritePaths(UNTRACKED_OVERWRITE_STDERR)).toEqual([
      "app/.vite/deps/a.js",
      "app/.vite/deps/a.js.map",
      "app/.vite/deps/_metadata.json",
      "app/.vite/vitest/results.json",
      "app/.vite/deps/b.js",
    ]);
  });

  it("returns null for any other failure", () => {
    expect(untrackedOverwritePaths("error: could not apply 0123456... subject\n")).toBeNull();
    expect(untrackedOverwritePaths("fatal: invalid upstream 'origin/nope'\n")).toBeNull();
    expect(untrackedOverwritePaths(
      "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
    )).toBeNull();
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
