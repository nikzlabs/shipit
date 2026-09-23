/**
 * A refspec reaching `git push` is a force with no flag to find.
 * `POST /api/sessions/:id/git/push` forwards a caller-supplied `branch`
 * straight through to `GitManager.push`, so `+main:main` would have executed a
 * forced push through the ORDINARY push method — past every guard that
 * inspects only the force-pushing path.
 */
import { describe, it, expect } from "vitest";
import { assertPlainBranchName } from "./git.js";

describe("assertPlainBranchName", () => {
  const refused = [
    "+main:main",
    "+main",
    "main:main",
    "HEAD:refs/heads/main",
    ":main",
    "refs/heads/*:refs/heads/*",
    "-D",
    "--force",
    " main",
    "main ",
    "main branch",
    "",
    "feature/..",
    "feature/",
    "main.lock",
    "main^",
    "main~1",
    "main?",
  ];
  for (const branch of refused) {
    it(`refuses ${JSON.stringify(branch)}`, () => {
      expect(() => assertPlainBranchName(branch)).toThrow(/plain branch name/);
    });
  }

  const allowed = [
    "main",
    "master",
    "stable",
    "shipit/ab12cd",
    "release/0.3.0",
    "feature/SHI-304_fix",
    "dependabot/npm_and_yarn/vite-7.1.14",
    "v2.x",
  ];
  for (const branch of allowed) {
    it(`allows ${branch}`, () => {
      expect(() => assertPlainBranchName(branch)).not.toThrow();
    });
  }
});
