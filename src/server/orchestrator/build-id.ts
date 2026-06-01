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
 * Unlike {@link resolveBuildId} (which reads the baked `SHIPIT_BUILD_ID` env
 * var — the cache-busting identity the client reload logic depends on), this
 * shells out against the bind-mounted host repo (`/opt/shipit`) exactly like
 * `checkForUpdates()`. The production image has no `.git`, so a `git describe`
 * in the container's own cwd would see no repo — it must run against the mount.
 *
 * On `stable`, `version` is the exact release tag (`vX.Y.Z`) when HEAD sits on
 * one; otherwise it reports `main @ <short-sha>`. When the host repo is absent
 * (local/dogfood mode) we fall back to the `SHIPIT_BUILD_ID` short SHA with the
 * channel reported as `edge` — the same graceful degradation as the channel
 * selector.
 */
export function resolveVersion(
  channel: ReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
): VersionInfo {
  const headSha = gitInHostRepo(["rev-parse", "HEAD"]);

  if (!headSha) {
    // No host repo (local/dogfood) — degrade to the baked build id, edge channel.
    const sha = resolveBuildId(env);
    const short = sha?.slice(0, 7);
    return {
      channel: "edge",
      version: short ? `main @ ${short}` : "unknown",
      commit: sha,
    };
  }

  const exactTag = gitInHostRepo(["describe", "--tags", "--exact-match", "HEAD"]);
  const short = headSha.slice(0, 7);

  return {
    channel,
    version: channel === "stable" && exactTag ? exactTag : `main @ ${short}`,
    commit: headSha,
  };
}
