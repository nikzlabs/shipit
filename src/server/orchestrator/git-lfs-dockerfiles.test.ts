/**
 * Build-time guard for the docs/231 Git LFS install (nikzlabs/shipit#1729).
 *
 * The orchestrator and the session worker install LFS *differently*, and getting
 * that backwards is not a cosmetic slip:
 *
 *  - Orchestrator, `--skip-smudge`: the clean filter must stay on, because
 *    `postTurnCommit` runs orchestrator-side and would otherwise commit raw
 *    binaries into an LFS repo. Smudge must stay OFF, because
 *    `RepoGit.cloneFromCache` clones from a bare cache whose `origin` is a local
 *    filesystem path — an active smudge filter resolves a bogus LFS endpoint
 *    from it and, with `filter.lfs.required = true`, fails the whole checkout.
 *    A smudge-enabled orchestrator would break cloning for every LFS repo, which
 *    is worse than the pointer stubs this feature fixes.
 *  - Session worker, full install: inside the container the agent and the user
 *    expect ordinary LFS behaviour from `git checkout` and `git commit`.
 *
 * We can't `docker build` in-session, so guard the Dockerfile source the way
 * `session-worker-docker-journal-group.test.ts` does. Comments are stripped
 * before matching — they discuss `--skip-smudge` at length and would otherwise
 * satisfy the assertions on their own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function instructions(dockerfile: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../docker/${dockerfile}`, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Images that run orchestrator code (clone-from-cache + post-turn auto-commit). */
const ORCHESTRATOR_IMAGES = ["Dockerfile.prod", "Dockerfile.dev", "Dockerfile.dogfood"];
/** Images that back a session container (the agent's own git). */
const WORKER_IMAGES = ["Dockerfile.session-worker.prod", "Dockerfile.session-worker.dev"];
const ALL_IMAGES = [...ORCHESTRATOR_IMAGES, ...WORKER_IMAGES];

describe("git-lfs is installed in every image that runs git", () => {
  it.each(ALL_IMAGES)("%s installs the git-lfs package", (dockerfile) => {
    const src = instructions(dockerfile);
    expect(src).toMatch(/apt-get install[^\n]*\bgit-lfs\b/);
  });

  it.each(ALL_IMAGES)("%s registers the LFS filters in system git config", (dockerfile) => {
    // `--system` is the only writable target: GIT_CONFIG_GLOBAL points at
    // /credentials/.gitconfig, which is mounted read-only in session containers,
    // so a runtime `git lfs install` would fail.
    expect(instructions(dockerfile)).toMatch(/git lfs install[^\n]*--system/);
  });
});

describe("smudge configuration differs by image role", () => {
  it.each(ORCHESTRATOR_IMAGES)("%s disables the smudge filter", (dockerfile) => {
    expect(instructions(dockerfile)).toMatch(/git lfs install[^\n]*--skip-smudge/);
  });

  it.each(WORKER_IMAGES)("%s keeps the smudge filter enabled", (dockerfile) => {
    const src = instructions(dockerfile);
    expect(src).toMatch(/git lfs install[^\n]*--system/);
    expect(src).not.toMatch(/git lfs install[^\n]*--skip-smudge/);
  });
});
