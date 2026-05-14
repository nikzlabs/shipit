/**
 * Unit tests for `fetchAndResolveDefaultBranch` (W2).
 *
 * The warm pool and the claim slow-path build session clones with
 * `git clone --local` from the bare cache — a snapshot that can be far
 * behind the real remote. This helper fetches the *real* remote in the
 * workspace clone so the branch is cut from the genuine latest commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fetchAndResolveDefaultBranch } from "./git-utils.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function commitFile(repoDir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(repoDir, name), content);
  git(repoDir, "add -A");
  git(repoDir, `commit -m "${message}" --no-gpg-sign`);
  return git(repoDir, "rev-parse HEAD");
}

describe("fetchAndResolveDefaultBranch", () => {
  let tmpDir: string;
  let remoteDir: string;
  let cloneDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-fetch-resolve-"));
    remoteDir = path.join(tmpDir, "remote");
    cloneDir = path.join(tmpDir, "clone");

    // "Real remote" repo with one commit on `main`.
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, "init");
    git(remoteDir, "checkout -b main");
    git(remoteDir, "config user.email test@test");
    git(remoteDir, "config user.name test");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  it("resolves to the remote's latest commit after fetching — not the stale clone's HEAD", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");

    // Stale clone — snapshot of the remote at c1.
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);
    expect(git(cloneDir, "rev-parse HEAD")).toBe(c1);

    // Remote advances — the clone has NOT seen this commit.
    const c2 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 3072\n", "c2");
    expect(c2).not.toBe(c1);

    const { resetTarget, fetched } = await fetchAndResolveDefaultBranch(cloneDir);

    expect(fetched).toBe(true);
    // resetTarget is `rev-parse origin/HEAD` — must be the NEW commit.
    expect(resetTarget).toBe(c2);
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c2);
  });

  it("falls back to local origin refs when the remote is unreachable (fetched: false)", async () => {
    const c1 = commitFile(remoteDir, "shipit.yaml", "agent:\n  memory: 1024\n", "c1");
    git(tmpDir, `clone "${remoteDir}" "${cloneDir}"`);

    // Break origin so the fetch fails — the helper must degrade to
    // resolving from whatever `origin/*` refs the clone already has,
    // never throw.
    git(cloneDir, `remote set-url origin "${path.join(tmpDir, "does-not-exist")}"`);

    const { resetTarget, fetched } = await fetchAndResolveDefaultBranch(cloneDir);

    expect(fetched).toBe(false);
    // Still resolves — to the snapshot's commit (c1), the pre-W2 behavior.
    expect(resetTarget).toBeDefined();
    expect(git(cloneDir, `rev-parse ${resetTarget}`)).toBe(c1);
  });
});
