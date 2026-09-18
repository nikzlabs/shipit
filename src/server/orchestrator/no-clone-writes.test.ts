import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

// Detects direct path construction, not aliases or assembled fragments.
const IN_CLONE_SHIPIT_PATH = String.raw`(workspaceDir|sessionDir|clone|repoDir|cwd)\s*,\s*['"]\.shipit['"]|"\.shipit/|\}/\.shipit|\+\s*['"]/?\.shipit`;

function filesComposingInCloneArtifacts(): string[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "--untracked", "-E", IN_CLONE_SHIPIT_PATH, "--", "src/**/*.ts", ":!src/**/*.test.ts"],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
  } catch (err: unknown) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("no ShipIt-generated writes inside a session clone (docs/246-shipit-state-out-of-clone req 7)", () => {
  it("no source file composes an in-clone artifact path", () => {
    expect(
      filesComposingInCloneArtifacts(),
      "These files put a ShipIt-generated artifact inside the user's git clone, where the "
        + "post-turn `git add -A` will commit it into their repository. Write to the session "
        + "state dir instead (see session-state-dir.ts). This check has no allowlist by design "
        + "(planning#292) — if the path you are adding is the orchestrator's OWN workspace root "
        + "rather than a session clone, route it through global-system-prompt.ts or give the "
        + "variable a name that says so, rather than re-introducing an exemption.",
    ).toEqual([]);
  });
});
