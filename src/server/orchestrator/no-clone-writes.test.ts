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
 * that is actually forbidden: one of the four GENERATED ARTIFACT names composed
 * with an in-clone `.shipit` path.
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
 */
const IN_CLONE_SHIPIT_PATH = String.raw`(workspaceDir|sessionDir|clone|repoDir|cwd)\s*,\s*"\.shipit"|"\.shipit/`;

/**
 * Sites still permitted to name an in-clone artifact path.
 *
 * SHI-286 emptied the "back-compat fallback" category: the legacy flat layout
 * (`sessionDir === workspaceDir`) is gone, so nothing falls back to writing a
 * docs/246 artifact into a clone. What is left either isn't a clone at all
 * (app-scope) or REMOVES a pre-246 copy.
 *
 * One writer does survive, and it is NOT a docs/246 artifact:
 * `secret-resolver.ts`'s `writePerServiceEnvFiles` still writes
 * `.shipit/.env.<svc>` into the clone when neither Docker-secrets mode nor
 * docs/183's `serviceEnvDir` is configured. That is a docs/183 leftover with its
 * own migration story (`writeServiceEnvFilesToRoot` sweeps it), reachable only
 * in tests / non-container setups — tracked separately, not allowlisted away
 * here on purpose.
 */
const ALLOWED: Record<string, string> = {
  // --- Not a clone at all: the APP-SCOPE workspaceDir (the orchestrator's own
  // workspace root), where the GLOBAL system-prompt.md lives, one level above
  // every session. Nothing here touches a user's repository. ---
  "src/server/orchestrator/bootstrap-managers.ts": "app-scope system-prompt.md",
  "src/server/orchestrator/route-registry.ts": "app-scope system-prompt.md",
  "src/server/orchestrator/services/settings.ts": "app-scope system-prompt.md",

  // --- Removes a pre-246 copy, never creates one. ---
  "src/server/orchestrator/session-state-dir.ts": "owns the sweep",
  "src/server/orchestrator/services/claim-session.ts": "unlinks a pre-246 marker",
  "src/server/session/install-controller.ts": "unlinks a pre-246 marker",

  // --- Unlinks a pre-246 `.env.agent`; ALSO still owns docs/183's in-clone
  // per-service env fallback (`writePerServiceEnvFiles`), which is out of scope
  // for docs/246 and tracked on its own. See the note above. ---
  "src/server/orchestrator/secret-resolver.ts":
    "unlinks a pre-246 .env.agent; docs/183 per-service env fallback",
};

/** Source files (excluding tests) that compose an in-clone artifact path. */
function filesComposingInCloneArtifacts(): string[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "-E", IN_CLONE_SHIPIT_PATH, "--", "src/**/*.ts", ":!src/**/*.test.ts"],
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
  it("only sweep / back-compat sites compose an in-clone artifact path", () => {
    const offenders = filesComposingInCloneArtifacts().filter((f) => !(f in ALLOWED));
    expect(
      offenders,
      "These files put a ShipIt-generated artifact inside the user's git clone, where the "
        + "post-turn `git add -A` will commit it into their repository. Write to the session "
        + "state dir instead (see session-state-dir.ts). Add to ALLOWED only when the path is "
        + "being REMOVED — SHI-286 retired the back-compat-default category.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const composing = new Set(filesComposingInCloneArtifacts());
    const stale = Object.keys(ALLOWED).filter((f) => !composing.has(f));
    expect(stale, "allowlisted files that no longer compose an in-clone path").toEqual([]);
  });
});
