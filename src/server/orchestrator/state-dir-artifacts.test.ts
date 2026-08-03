/**
 * Repo-hygiene guard: nothing the orchestrator writes under `<stateDir>` may be
 * committable from the repo root.
 *
 * `stateDir` falls back to `workspaceDir` (default `/workspace`) when
 * `SHIPIT_STATE_DIR` is unset — see `app-di.ts` (`const stateDir = deps.stateDir
 * ?? envStateDir ?? workspaceDir`). Deployments set neither: prod and the local
 * dev stack mount a NAMED VOLUME at `/workspace` and keep the source at `/app`,
 * so state and source never share a directory there. But an orchestrator started
 * by hand from a checkout that IS mounted at `/workspace` — `npm run dev` inside
 * a dogfood session container, where `RUNTIME_MODE` is unset and so resolves to
 * `containerized` — writes its state straight into the source tree, and the
 * post-turn `git add -A` commits it. That is how `.shipit-worker-uid` (the
 * docs/150 worker-UID boot marker) landed in 18df8025.
 *
 * A committed marker is not inert: `readMarker` cannot tell a git-restored value
 * from a previous boot's, so in that same hand-started mode a checkout would
 * feed `assertWorkerUidConsistency` a value from the branch rather than from the
 * last run.
 *
 * The durable fix for the leak itself is `.gitignore`; this test keeps the list
 * honest, so a new `<stateDir>/<something>` doesn't reopen the same vector.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_UID_MARKER_FILE } from "./worker-uid-guard.js";
import { OVERLAY_BASE_SUBDIR } from "./overlay-volume.js";
import { OVERLAY_POINTER_SUBDIR } from "./overlay-base.js";
import { PNPM_STORE_SUBDIR } from "./overlay-session.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * Every top-level name the orchestrator creates directly under `<stateDir>`.
 * Constants are imported where the writer exports one; the rest are literals at
 * their single write site (cited) because the writer inlines them. The trailing
 * `/` is load-bearing: `git check-ignore` matches a bare name as a FILE, so a
 * `foo/` pattern wouldn't match a probe of `foo`.
 */
const STATE_DIR_ARTIFACTS: string[] = [
  WORKER_UID_MARKER_FILE, // worker-uid-guard.ts
  ".shipit.db", // app-di.ts (+ -wal / -shm)
  ".voice-cache/", // api-routes-voice.ts
  "repo-cache/", // session-dir-factory.ts
  "dep-cache/", // session-dir-factory.ts
  "marketplace-cache/", // services/marketplace.ts
  "service-env/", // bootstrap-managers.ts
  "sessions/", // app-di.ts (sessionsRoot — under workspaceDir, not stateDir)
  `${OVERLAY_BASE_SUBDIR}/`, // overlay-volume.ts
  `${OVERLAY_POINTER_SUBDIR}/`, // overlay-base.ts
  `${PNPM_STORE_SUBDIR}/`, // overlay-session.ts
];

/** True when git would ignore `<repo root>/<name>`. */
function isIgnored(name: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", name], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false; // exit 1 = not ignored (exit 128 = not a work tree, also a fail)
  }
}

describe("stateDir artifacts are gitignored at the repo root", () => {
  it.each(STATE_DIR_ARTIFACTS)("%s", (name) => {
    expect(isIgnored(name)).toBe(true);
  });

  it("the docs/150 worker-uid marker is not a tracked file", () => {
    const tracked = execFileSync("git", ["ls-files", "--", WORKER_UID_MARKER_FILE], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    expect(tracked).toBe("");
  });
});
