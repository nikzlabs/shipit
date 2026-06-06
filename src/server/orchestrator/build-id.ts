import { execFileSync } from "node:child_process";
import { HOST_REPO_DIR } from "./release-channel.js";
import type { ReleaseChannel } from "./release-channel.js";
import type { VersionInfo } from "../shared/types.js";

export function resolveBuildId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = normalizeBuildId(env.SHIPIT_BUILD_ID);
  if (explicit) return explicit;

  try {
    return normalizeBuildId(execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return undefined;
  }
}

export function normalizeBuildId(buildId: string | undefined): string | undefined {
  const trimmed = buildId?.trim();
  return trimmed ? trimmed : undefined;
}

function gitInHostRepo(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: HOST_REPO_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Human-facing version identity, channel-aware.
 *
 * The identity reported here is the **running image's** commit, taken from the
 * baked `SHIPIT_BUILD_ID` (the SHA passed as a build-arg in `deploy.sh` and
 * frozen into the image) — NOT the live checkout HEAD. This matters after a
 * failed in-place update (issue #1047): `update.sh` advances the checkout to
 * the new tip before building, so for the duration of the build the on-disk
 * HEAD is ahead of what's actually running. Reading HEAD here would then make
 * the "Current version" badge report a build that may never have completed, and
 * a plain "Just Restart" would lock that wrong version in. Anchoring on the
 * baked SHA keeps the badge honest about what is executing. (`update.sh` now
 * also rolls the checkout back on failure, so the two normally agree; this is
 * the in-process backstop for any window or legacy script where they don't.)
 *
 * We still shell out against the bind-mounted host repo (`/opt/shipit`) to
 * *name* that commit — `git describe --tags` for a stable release tag — because
 * the production image has no `.git` of its own. On `stable`, `version` is the
 * exact tag (`vX.Y.Z`) when the running commit sits on one; otherwise it reports
 * `main @ <short-sha>`. When the host repo is absent (local/dogfood mode) we
 * degrade to the baked short SHA with the channel reported as `edge`.
 *
 * `mismatch` is set when the checkout HEAD differs from the running commit —
 * the tell-tale of an interrupted/failed update — so the UI can flag it.
 */
export function resolveVersion(
  channel: ReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
): VersionInfo {
  // The commit the running image was built from — the source of truth for
  // "what is executing", independent of the on-disk checkout.
  const runningSha = resolveBuildId(env);
  const headSha = gitInHostRepo(["rev-parse", "HEAD"]);
  // Name the running commit via the host repo; absent in local/dogfood mode.
  return composeVersion(channel, runningSha, headSha, (commit) =>
    gitInHostRepo(["describe", "--tags", "--exact-match", commit]),
  );
}

/**
 * Pure version-composition logic, factored out of {@link resolveVersion} so the
 * baked-id-vs-checkout precedence and the `mismatch` flag are testable without a
 * `/opt/shipit` mount. `describeCommit` resolves a stable release tag for a
 * commit (host-repo `git describe`), returning undefined when untagged/absent.
 */
export function composeVersion(
  channel: ReleaseChannel,
  runningSha: string | undefined,
  headSha: string | undefined,
  describeCommit: (commit: string) => string | undefined,
): VersionInfo {
  // Prefer the running image's baked SHA; fall back to the checkout HEAD only
  // when there is no baked id (shouldn't happen in prod).
  const commit = runningSha ?? headSha;

  if (!commit) {
    return { channel: "edge", version: "unknown" };
  }

  const mismatch = Boolean(runningSha && headSha && runningSha !== headSha);

  if (!headSha) {
    // No host repo (local/dogfood) — can't `git describe`; degrade to the short
    // SHA on the edge channel, the same graceful path as the channel selector.
    return {
      channel: "edge",
      version: `main @ ${commit.slice(0, 7)}`,
      commit,
    };
  }

  // Name the RUNNING commit (not necessarily HEAD) so the label matches the
  // image. `describeCommit` is silent when the commit isn't tagged.
  const exactTag = describeCommit(commit);

  return {
    channel,
    version: channel === "stable" && exactTag ? exactTag : `main @ ${commit.slice(0, 7)}`,
    commit,
    ...(mismatch ? { mismatch: true } : {}),
  };
}
