/**
 * docs/262 req 19 — `setGitRemote` is the one place a user hands ShipIt an
 * arbitrary remote string, and it writes it straight into the session's own
 * `.git/config` (`/project/.git/config` in the container, readable by the agent
 * and by every plugin CLI and plugin service) as well as into the session row.
 *
 * Every shape below was reachable and unguarded; the last two were found by the
 * independent review of the first fix, which only covered http(s) userinfo.
 *
 * Fixture note: passwords are deliberately short and generic — `secret-scan.ts`
 * flags `<user>:<8+ chars>@` in a URL, so a realistic-looking PAT here would
 * trip the scanner on every commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseManager } from "../../shared/database.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { setGitRemote } from "./git.js";

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

describe("setGitRemote does not persist a credential (docs/262 req 19)", () => {
  const cases: [name: string, typed: string, stored: string][] = [
    [
      "http(s) userinfo",
      "https://x-access-token:pw@github.com/o/r.git",
      "https://github.com/o/r.git",
    ],
    [
      // A token in the query survived the http(s)-only strip.
      "a token in the query string",
      "https://github.com/o/r.git?access_token=pw",
      "https://github.com/o/r.git",
    ],
    [
      // The ssh USER is a login identity, not a secret, so it stays — only the
      // password goes. Stripping `git@` would break the remote outright.
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
    // The strip must not normalize a clean URL — a stored URL that silently
    // changes shape is a row key that stops matching itself.
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
