import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

// Pattern-shaped fixtures (not real credentials). This test file is allowlisted
// by path in secret-scan.ts, so committing it never trips the guard.
const FAKE_PAT = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

describe("GitManager.autoCommit — docs/213 secret-scan guard", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-secret-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses the commit when a staged file contains a secret, leaving the tree intact", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    const headBefore = await git.getHeadHash();

    const file = path.join(tmpDir, "config.ts");
    fs.writeFileSync(file, `export const TOKEN = "${FAKE_PAT}";\n`);

    const result = await git.autoCommit("add config");

    expect(result.commitHash).toBeNull();
    expect(result.secretFindings).toHaveLength(1);
    expect(result.secretFindings[0].rule).toBe("github-pat");
    expect(result.secretFindings[0].file).toBe("config.ts");
    // HEAD must not have advanced — nothing was committed.
    expect(await git.getHeadHash()).toBe(headBefore);
    // The working-tree change is preserved and left unstaged for the next turn.
    expect(fs.readFileSync(file, "utf-8")).toContain(FAKE_PAT);
    const staged = await simpleGit(tmpDir).diff(["--cached"]);
    expect(staged.trim()).toBe("");
  });

  it("commits normally once the secret is removed", async () => {
    const git = new GitManager(tmpDir);
    await git.init();

    const file = path.join(tmpDir, "config.ts");
    fs.writeFileSync(file, `export const TOKEN = "${FAKE_PAT}";\n`);
    const blocked = await git.autoCommit("add config");
    expect(blocked.commitHash).toBeNull();

    // Agent fixes it next turn.
    fs.writeFileSync(file, `export const TOKEN = process.env.TOKEN;\n`);
    const ok = await git.autoCommit("use env var");
    expect(ok.commitHash).toBeTruthy();
    expect(ok.secretFindings).toEqual([]);
  });

  it("does not block when no secret is present", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(path.join(tmpDir, "ok.ts"), "export const x = 1;\n");

    const result = await git.autoCommit("normal change");
    expect(result.commitHash).toBeTruthy();
    expect(result.secretFindings).toEqual([]);
  });

  it("blocks a secret in a brand-new untracked file (caught via git add -A)", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    // A leaked credential file the agent created from scratch.
    fs.writeFileSync(path.join(tmpDir, "creds.env"), `GH_TOKEN=${FAKE_PAT}\n`);

    const result = await git.autoCommit("add creds");
    expect(result.commitHash).toBeNull();
    expect(result.secretFindings.map((f) => f.file)).toContain("creds.env");
  });

  it("honors an inline gitleaks:allow override", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    fs.writeFileSync(
      path.join(tmpDir, "sample.ts"),
      `const example = "${FAKE_PAT}"; // gitleaks:allow\n`,
    );

    const result = await git.autoCommit("documented sample");
    expect(result.commitHash).toBeTruthy();
    expect(result.secretFindings).toEqual([]);
  });
});
