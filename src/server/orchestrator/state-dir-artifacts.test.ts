import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_UID_MARKER_FILE } from "./worker-uid-guard.js";
import { OVERLAY_BASE_SUBDIR } from "./overlay-volume.js";
import { OVERLAY_POINTER_SUBDIR } from "./overlay-base.js";
import { PNPM_STORE_SUBDIR } from "./overlay-session.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

// Include trailing slashes so check-ignore tests directories, not files.
const STATE_DIR_ARTIFACTS: string[] = [
  WORKER_UID_MARKER_FILE,
  ".shipit.db",
  ".voice-cache/",
  "repo-cache/",
  "dep-cache/",
  "marketplace-cache/",
  "service-env/",
  "sessions/",
  `${OVERLAY_BASE_SUBDIR}/`,
  `${OVERLAY_POINTER_SUBDIR}/`,
  `${PNPM_STORE_SUBDIR}/`,
];

function isIgnored(name: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", name], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
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
