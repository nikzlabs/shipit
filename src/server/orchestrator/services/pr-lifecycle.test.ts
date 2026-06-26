import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { GitManager } from "../../shared/git.js";
import type { WsServerMessage } from "../../shared/types.js";
import { emitPrLifecycleAfterCommit, type PrLifecycleDeps } from "./pr-lifecycle.js";

/**
 * Regression guard for docs/210: the PR card's changed-docs strip must refresh
 * on EVERY post-turn commit, decoupled from the PR-lifecycle branching. The
 * recompute used to live inside the `if (prStatus)` branch, so a turn that took
 * the no-status / recovery / ready path committed new docs without re-emitting
 * the strip — it stayed frozen until a session-switch re-seed. These tests pin
 * `pr_notable_files` firing in both the tracked-PR and the no-status case.
 */

let tmpDir: string;

function git(args: string): void {
  execSync(`git ${args}`, {
    cwd: tmpDir,
    env: { ...process.env, HOME: tmpDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/** A feature branch off `main` with a new design doc committed. */
function seedRepoWithChangedDoc(): void {
  git("init -q -b main");
  git("config user.email test@test.com");
  git("config user.name Test");
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Repo\n");
  git("add -A");
  git("commit -qm initial");

  git("checkout -q -b feature");
  fs.mkdirSync(path.join(tmpDir, "docs/210-thing"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "docs/210-thing/plan.md"), "---\ntitle: A Thing\n---\n");
  git("add -A");
  git("commit -qm 'add doc'");
}

/**
 * Minimal deps. `prStatus` toggles whether the poller has a status cached for
 * the session; `authenticated` is left false so the no-status case lands in the
 * ready path (no `quickCreatePr` network call).
 */
function makeDeps(opts: { prStatus: { baseBranch: string } | undefined }): PrLifecycleDeps {
  return {
    sessionManager: {
      get: () => ({ remoteUrl: "https://github.com/o/r.git", branch: "feature", title: "t" }),
    },
    prStatusPoller: {
      getStatus: () => opts.prStatus,
      getAutoMergeState: () => undefined,
    },
    githubAuthManager: { authenticated: false },
    credentialStore: { getAutoCreatePr: () => false },
    chatHistoryManager: {},
    generateText: async () => "",
    createGitManager: (dir: string) => new GitManager(dir),
  } as unknown as PrLifecycleDeps;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync("/tmp/shipit-pr-lifecycle-test-");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("emitPrLifecycleAfterCommit — changed-docs strip refresh", () => {
  it("emits pr_notable_files when a PR is tracked (poller has status)", async () => {
    seedRepoWithChangedDoc();
    const emitted: WsServerMessage[] = [];

    await emitPrLifecycleAfterCommit({
      deps: makeDeps({ prStatus: { baseBranch: "main" } }),
      sessionId: "s1",
      sessionDir: tmpDir,
      commitHash: "deadbeef",
      emit: (m) => emitted.push(m),
    });

    const notable = emitted.filter((m) => m.type === "pr_notable_files");
    expect(notable).toHaveLength(1);
    expect(notable[0]).toMatchObject({
      sessionId: "s1",
      cardId: "pr-card-s1",
      notableFiles: [{ path: "docs/210-thing/plan.md", kind: "doc", title: "A Thing", status: "A" }],
    });
    // Poller owns phase/status for a tracked PR, so no lifecycle card is emitted.
    expect(emitted.some((m) => m.type === "pr_lifecycle_update")).toBe(false);
  });

  it("STILL emits pr_notable_files when the poller has no status (the previously-frozen path)", async () => {
    seedRepoWithChangedDoc();
    const emitted: WsServerMessage[] = [];

    await emitPrLifecycleAfterCommit({
      deps: makeDeps({ prStatus: undefined }),
      sessionId: "s1",
      sessionDir: tmpDir,
      commitHash: "deadbeef",
      emit: (m) => emitted.push(m),
    });

    // The strip refresh fires regardless of which lifecycle path runs.
    const notable = emitted.filter((m) => m.type === "pr_notable_files");
    expect(notable).toHaveLength(1);
    expect(notable[0]).toMatchObject({
      notableFiles: [{ path: "docs/210-thing/plan.md", kind: "doc", title: "A Thing", status: "A" }],
    });
    // No tracked PR + unauthenticated → the ready card is also emitted.
    expect(emitted.some((m) => m.type === "pr_lifecycle_update")).toBe(true);
  });
});
