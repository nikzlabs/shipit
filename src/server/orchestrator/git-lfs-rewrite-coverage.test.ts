/**
 * nikzlabs/shipit#2349 — the restore has to hold for worktree rewrites nobody has
 * written yet.
 *
 * `git-lfs.test.ts` proves the mechanism: a rewrite through the orchestrator's
 * smudge-disabled git leaves LFS-tracked paths as ~130-byte pointer stubs in a
 * tree `git status` calls clean, and `restoreLfsAfterTreeRewrite` puts the
 * content back. This proves the mechanism is *applied everywhere*, by scanning
 * the orchestrator's own source for calls that re-materialize a session worktree
 * and failing when the file holding one never restores.
 *
 * A scan rather than a list, for the reason `git-tree-uid.ts` states about its
 * own problem: "a hand-converted list is stale the moment someone adds one more,
 * and the failure is silent." That is not hypothetical here — the first cut of
 * this fix hand-enumerated the rewrite paths and an independent review found
 * five more (rewind/rollback, `shipit release prepare`, `POST /git/pull`, a
 * direct `POST /git/rebase/abort`, and a fork that never materialized LFS at
 * all). Every one of those is the reported bug verbatim, and every one would have
 * shipped silently.
 *
 * ## What it can and cannot see
 *
 * File-level, and deliberately coarse: it asks "does this file rewrite a
 * worktree, and does it also restore?", not "is the restore on the right line".
 * Two consequences worth stating rather than implying:
 *
 *   - A file that rewrites in two places and restores in only one **passes**.
 *     Ordering and completeness within a file are the per-site tests' job
 *     (`rebase-driver.test.ts` pins restore-before-handback and
 *     restore-before-queue-release; `pre-turn-reset.test.ts` pins both reset
 *     paths).
 *   - It sees the `GitManager` methods and raw argv forms named below, not a
 *     rewrite reached through a name it cannot follow.
 *
 * What it *does* catch is the case that actually happens: a new file, or a
 * newly-rewriting one, with no restore anywhere in it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * `GitManager` methods that re-materialize worktree files, and the raw argv
 * forms of the same thing. Deliberately excludes reads and ref-only moves
 * (`fetch`, `forceUpdateBranchRef`, `getRefHash`): those touch `.git` and cannot
 * write a pointer stub over an asset.
 */
const REWRITE_CALL = new RegExp(
  String.raw`\.(?:rollback|resetHardToRemoteBase|rebase|rebaseContinue|rebaseAbort` +
    String.raw`|mergeOverride|cherryPick|createBranchFrom|checkoutLocalBranch)\s*\(`,
);
const RAW_REWRITE_ARGV = /"reset"\s*,\s*"--hard"|"checkout"\s*,\s*"-[bB]"/;

/** Either restore entry point counts — a fresh clone materializes, a rewrite restores. */
const RESTORE_CALL = /restoreLfsAfterTreeRewrite|materializeLfsWithWarning/;

/**
 * Files that rewrite a worktree and correctly do NOT restore, each with the
 * reason. An entry here is a claim someone can check, which is the point of
 * naming them rather than narrowing the pattern until they disappear.
 */
const ALLOWED: Record<string, string> = {
  "services/git.ts":
    "Pure service layer: `gitRollback` / `rebaseAbort` take a "
    + "GitManager and no workspace path, so they CANNOT restore — there is nothing to "
    + "hand `git lfs pull` a cwd. The duty sits with their callers in "
    + "api-routes-git.ts, which this scan covers.",
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "integration_tests" || entry.name === "node_modules") continue;
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("Git LFS restore coverage over worktree rewrites (nikzlabs/shipit#2349)", () => {
  const offenders: string[] = [];
  const allowedSeen = new Set<string>();

  for (const file of tsFiles(HERE)) {
    const rel = path.relative(HERE, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    if (!REWRITE_CALL.test(src) && !RAW_REWRITE_ARGV.test(src)) continue;
    if (rel in ALLOWED) {
      allowedSeen.add(rel);
      continue;
    }
    if (!RESTORE_CALL.test(src)) offenders.push(rel);
  }

  it("every orchestrator file that rewrites a session worktree also restores LFS content", () => {
    expect(offenders, offenders.length
      ? `These rewrite a session worktree through the orchestrator's smudge-disabled git `
        + `and never restore LFS content, so an LFS repo gets ~130-byte pointer stubs in a `
        + `tree that reads CLEAN and nothing says so: ${offenders.join(", ")}. `
        + `Call restoreLfsAfterTreeRewrite(dir, "<what rewrote it>") once the tree has `
        + `settled and before the ownership handback — or add the file to ALLOWED here `
        + `with the reason it genuinely owes nothing.`
      : undefined,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An allowlisted file that stopped rewriting (or gained a restore) should
    // drop off the list rather than sit there licensing a future omission.
    expect([...allowedSeen].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("the scan actually matches something — it can fail", () => {
    // The scan's own smoke test. A pattern that silently stopped matching would
    // make every assertion above pass vacuously, which for a silent bug is the
    // worst possible failure mode.
    const rewriters = tsFiles(HERE).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return REWRITE_CALL.test(src) || RAW_REWRITE_ARGV.test(src);
    });
    expect(rewriters.length).toBeGreaterThanOrEqual(8);
  });
});
