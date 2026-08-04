import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

/**
 * Regression tests for the diff-stat scaling bug: simple-git's default
 * `--stat` parsing derives per-file insertions/deletions from git's
 * width-scaled histogram bar, so large diffs reported per-file counts that
 * were orders of magnitude too small (the "Changes vs master" dialog summed
 * them into a wrong total while the PR card showed the exact summary-line
 * total). All diff-stat reads now go through `--numstat`, whose columns are
 * exact — these tests pin that with a diff big enough to trigger scaling.
 */
describe("GitManager diff stats (--numstat exactness)", () => {
  let tmpDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string): string =>
    execSync(cmd, { cwd: tmpDir, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-git-diffstat-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports exact per-file counts for diffs large enough to scale the --stat bar", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    run("git branch base");

    // Far beyond the --stat graph width, so the histogram bar is scaled and
    // the old +/- character counting would undercount massively.
    const bigLines = 10_000;
    fs.writeFileSync(path.join(tmpDir, "big.json"), `${Array(bigLines).fill('{"x":1},').join("\n")}\n`);
    fs.writeFileSync(path.join(tmpDir, "small.txt"), "one\ntwo\nthree\n");
    await git.autoCommit("big change");

    const perFile = await git.diffSummary("base...HEAD");
    const big = perFile.find((f) => f.file === "big.json");
    const small = perFile.find((f) => f.file === "small.txt");
    expect(big).toMatchObject({ insertions: bigLines, deletions: 0, binary: false });
    expect(small).toMatchObject({ insertions: 3, deletions: 0, binary: false });

    // The dialog sums per-file numbers; the PR card uses diffStatVsBranch
    // totals. Both must agree exactly.
    const summed = perFile.reduce(
      (acc, f) => ({ ins: acc.ins + f.insertions, del: acc.del + f.deletions }),
      { ins: 0, del: 0 },
    );
    const totals = await git.diffStatVsBranch("base");
    expect(totals).toEqual({ insertions: summed.ins, deletions: summed.del });
    expect(totals.insertions).toBe(bigLines + 3);

    const twoDot = await git.diffStatTwoDot("base");
    expect(twoDot).toEqual({ insertions: bigLines + 3, deletions: 0, files: 2 });
  });

  it("flags binary files without counting them toward line totals", async () => {
    const git = new GitManager(tmpDir);
    await git.init();
    run("git branch base");

    fs.writeFileSync(path.join(tmpDir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    fs.writeFileSync(path.join(tmpDir, "note.txt"), "hello\n");
    await git.autoCommit("binary + text");

    const perFile = await git.diffSummary("base...HEAD");
    expect(perFile.find((f) => f.file === "blob.bin")).toMatchObject({
      insertions: 0,
      deletions: 0,
      binary: true,
    });
    expect(perFile.find((f) => f.file === "note.txt")).toMatchObject({ insertions: 1, binary: false });

    const totals = await git.diffStatVsBranch("base");
    expect(totals).toEqual({ insertions: 1, deletions: 0 });
  });
});
