// File-level scan only: per-site tests must check restore order and coverage.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REWRITE_CALL = new RegExp(
  String.raw`\.(?:rollback|resetHardToRemoteBase|rebase|rebaseContinue|rebaseAbort` +
    String.raw`|mergeOverride|cherryPick|createBranchFrom|checkoutLocalBranch)\s*\(`,
);
const RAW_REWRITE_ARGV = /"reset"\s*,\s*"--hard"|"checkout"\s*,\s*"-[bB]"/;

const RESTORE_CALL = /restoreLfsAfterTreeRewrite|materializeLfsWithWarning/;

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
    expect([...allowedSeen].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it("the scan actually matches something — it can fail", () => {
    const rewriters = tsFiles(HERE).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return REWRITE_CALL.test(src) || RAW_REWRITE_ARGV.test(src);
    });
    expect(rewriters.length).toBeGreaterThanOrEqual(8);
  });
});
