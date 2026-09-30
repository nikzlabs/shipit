import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { runGit } from "./run-git.js";

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-run-git-"));
  git(dir, "init --initial-branch=main");
  return dir;
}

// A `!`-alias stands in for `git lfs`: git resolves an external `git-lfs` binary
// BEFORE any alias of that name, so `lfs` itself cannot be shadowed here. The shape
// that matters is identical — a `git` wrapper whose child outlives it on the pipes.
describe.skipIf(!fs.existsSync("/proc/1/stat"))("runGit timeout (planning#615)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("settles and leaves no descendant when the timed-out git has a child on the pipes", async () => {
    const dir = makeRepo();
    dirs.push(dir);
    // `!` aliases run from the repo root, so the markers land beside .git. `started`
    // proves the descendant existed to be killed, so a slow spawn fails rather than
    // passing vacuously; `leaked` appears only if it outlived the timeout.
    git(dir, "config alias.lingering "
      + "'!touch started.txt; { sleep 5 && touch leaked.txt; } & exec sleep 60'");

    const startedAt = Date.now();
    const res = await runGit(["lingering"], dir, 1_500);

    expect(res.timedOut).toBe(true);
    // Unfixed, `close` waits on the surviving child and this runs ~60s, not ~1.5s.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(fs.existsSync(path.join(dir, "started.txt"))).toBe(true);

    await new Promise((r) => setTimeout(r, 6_000));
    expect(fs.existsSync(path.join(dir, "leaked.txt"))).toBe(false);
  }, 40_000);
});
