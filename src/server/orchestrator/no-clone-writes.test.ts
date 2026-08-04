/**
 * docs/246 req 7 — nothing ShipIt generates may be written into a session's git
 * clone. This is the mechanical half of that requirement: a future artifact
 * placed under `<clone>/.shipit/` fails here instead of being caught (or
 * missed) in review.
 *
 * The check is deliberately narrow. `.shipit` appears in ~18 source files for
 * unrelated and legitimate reasons (`.shipit.db`, `.shipit-worker-uid`, the
 * app-scope `system-prompt.md`, file-watcher skip lists), so an allowlist of
 * every mention would be noise nobody reads. Instead it matches only the thing
 * that is actually forbidden: an in-clone `.shipit` DIRECTORY path composed from
 * a clone/workspace variable. What gets written into it is irrelevant — see
 * {@link IN_CLONE_SHIPIT_PATH} for why matching the directory join, rather than
 * the artifact names, is the invariant.
 *
 * **There is no allowlist, and that is the point (SHI-290).** The check used to
 * carry an exemption map, which meant it asserted "only these files may" rather
 * than "no file does" — and because the granularity was per FILE, a new
 * forbidden writer added to an already-exempt file passed silently. The map is
 * gone because its last four rows were resolved rather than tolerated: three
 * were false positives that composed the APP-scope
 * `<appWorkspaceDir>/.shipit/system-prompt.md` and now go through
 * `global-system-prompt.ts` (one helper, one parameter named for the
 * orchestrator's own root), and the fourth was docs/183's in-workspace
 * `.shipit/.env.<svc>` fallback, deleted along with the `writePerServiceEnvFiles`
 * writer it called. With nothing exempt there is nowhere for a new writer to
 * hide, so per-line allowlisting — recorded as a follow-up when the map still
 * existed — is not needed either.
 *
 * The invariant has no carve-outs, which is what makes it checkable: nothing
 * user-authored lives in a clone's `.shipit/`. The per-repo config a human
 * writes is `shipit.yaml` at the repo root, and `.shipit/system-prompt.md` is a
 * *global* setting read from the orchestrator's own workspace root, one level
 * above every clone.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");


/**
 * Any source expression that composes a `.shipit` path under a workspace/clone
 * path — regardless of which artifact goes in it.
 *
 * The earlier version enumerated the four current artifact names AND required
 * them in the same expression as `.shipit`. Codex defeated it twice over: a
 * future `runtime.json` was invisible, and `service-manager.ts` already computed
 * `path.join(opts.workspaceDir, ".shipit")` on one line and passed that
 * directory to the writer on another, so no single expression matched. Matching
 * the DIRECTORY join is the invariant — what gets written into it is irrelevant.
 *
 * SHI-286 closed a third bypass, and it was not hypothetical: the version that
 * recognised only a DOUBLE-quoted `.shipit` never saw `buildEnv`'s
 * `` `${workspaceDir}/.shipit` `` — a live in-clone path that sat green in CI
 * for the whole of docs/246. So `\}/\.shipit` now catches a template
 * interpolation followed by the directory, and the quote class accepts `'` as
 * well as `"`.
 *
 * **Backticks are deliberately NOT in that class.** In this codebase a
 * backticked `.shipit/...` is nearly always a markdown code span in a JSDoc
 * comment — adding it matches ~20 files of pure prose, and a guard whose output
 * is mostly noise is one nobody reads. The dangerous shape is a path composed
 * from a clone variable, and that always shows up as one of the three forms
 * covered here: the `path.join` argument pair, the `${…}/` interpolation, or
 * string concatenation (`workspaceDir + "/.shipit/…"`).
 *
 * **What it still cannot see, stated rather than implied:** a path composed
 * through an *alias* (`const root = workspaceDir; path.join(root, ".shipit")`)
 * or assembled from fragments. No grep can follow that, and the answer is not a
 * cleverer regex — it is that a reviewer reading such code has to notice. The
 * guard's job is to make the obvious shapes impossible to land by accident, and
 * to remove the "someone will catch it in review" excuse for the common cases.
 */
const IN_CLONE_SHIPIT_PATH = String.raw`(workspaceDir|sessionDir|clone|repoDir|cwd)\s*,\s*['"]\.shipit['"]|"\.shipit/|\}/\.shipit|\+\s*['"]/?\.shipit`;

/**
 * Source files (excluding tests) that compose an in-clone artifact path.
 *
 * `--untracked` matters more than it looks: without it `git grep` searches only
 * files already in the index, so a brand-new writer in a file the author hasn't
 * staged yet is invisible locally — green on the machine where it was written,
 * red only after someone else pulls it. That is exactly backwards for a guard
 * whose value is catching the mistake at the moment it is made.
 */
function filesComposingInCloneArtifacts(): string[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "--untracked", "-E", IN_CLONE_SHIPIT_PATH, "--", "src/**/*.ts", ":!src/**/*.test.ts"],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
  } catch (err: unknown) {
    // git grep exits 1 with no output when nothing matches — the ideal state.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("no ShipIt-generated writes inside a session clone (docs/246 req 7)", () => {
  it("no source file composes an in-clone artifact path", () => {
    expect(
      filesComposingInCloneArtifacts(),
      "These files put a ShipIt-generated artifact inside the user's git clone, where the "
        + "post-turn `git add -A` will commit it into their repository. Write to the session "
        + "state dir instead (see session-state-dir.ts). This check has no allowlist by design "
        + "(SHI-290) — if the path you are adding is the orchestrator's OWN workspace root "
        + "rather than a session clone, route it through global-system-prompt.ts or give the "
        + "variable a name that says so, rather than re-introducing an exemption.",
    ).toEqual([]);
  });
});
