import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveReleaseNotes } from "./updates.js";

let dir: string;
let gitOpts: { cwd: string; timeout: number };

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "updates-notes-"));
  gitOpts = { cwd: dir, timeout: 10_000 };
  git("init", "-q", "-b", "main");

  fs.writeFileSync(path.join(dir, "seed"), "1");
  git("add", "-A");
  git("commit", "-qm", "seed");
  git("tag", "v1.0.0");

  fs.mkdirSync(path.join(dir, ".release-notes"));
  fs.writeFileSync(path.join(dir, ".release-notes", "v1.2.0.md"), "## Highlights\n\nPreviews reconnect.\n");
  git("add", "-A");
  git("commit", "-qm", "Release v1.2.0");
  git("tag", "v1.2.0");

  // Resolvable as a ref and readable as a file, so the version-format guard is
  // the only thing that can keep a branch label out of the lookup.
  fs.writeFileSync(path.join(dir, ".release-notes", "main.md"), "branch tip, not a release\n");
  git("add", "-A");
  git("commit", "-qm", "post-release work");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveReleaseNotes (docs/309)", () => {
  it("reads the notes a tag shipped with", async () => {
    await expect(resolveReleaseNotes("v1.2.0", "stable", gitOpts)).resolves.toBe(
      "## Highlights\n\nPreviews reconnect.",
    );
  });

  it("returns undefined for a tag that carries no notes file", async () => {
    await expect(resolveReleaseNotes("v1.0.0", "stable", gitOpts)).resolves.toBeUndefined();
  });

  it("returns undefined on the edge channel, which tracks a branch and has no tag", async () => {
    await expect(resolveReleaseNotes("v1.2.0", "edge", gitOpts)).resolves.toBeUndefined();
  });

  it("returns undefined for a branch label, even when that ref has a readable notes file", async () => {
    await expect(resolveReleaseNotes("main", "stable", gitOpts)).resolves.toBeUndefined();
  });

  it("reads the notes of the named tag, not the checked-out tree", async () => {
    fs.writeFileSync(path.join(dir, ".release-notes", "v1.2.0.md"), "edited after release\n");
    await expect(resolveReleaseNotes("v1.2.0", "stable", gitOpts)).resolves.toBe(
      "## Highlights\n\nPreviews reconnect.",
    );
  });
});
