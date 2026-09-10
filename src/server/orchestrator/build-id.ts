import { execFileSync } from "node:child_process";
import { HOST_REPO_DIR } from "./release-channel.js";
import type { ReleaseChannel } from "./release-channel.js";
import type { VersionInfo } from "../shared/types.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";

export function resolveBuildId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = normalizeBuildId(env.SHIPIT_BUILD_ID);
  if (explicit) return explicit;

  try {
    return normalizeBuildId(execFileSync("git", gitArgsWithHooksDisabled(["rev-parse", "HEAD"]), {
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
    return execFileSync("git", gitArgsWithHooksDisabled(args), {
      cwd: HOST_REPO_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...gitSpawnOverridesForTree(HOST_REPO_DIR),
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveVersion(
  channel: ReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
): VersionInfo {
  // Updates can move the checkout ahead of the running image.
  const runningSha = resolveBuildId(env);
  const headSha = gitInHostRepo(["rev-parse", "HEAD"]);
  return composeVersion(channel, runningSha, headSha, (commit) =>
    gitInHostRepo(["describe", "--tags", "--exact-match", commit]),
  );
}

export function composeVersion(
  channel: ReleaseChannel,
  runningSha: string | undefined,
  headSha: string | undefined,
  describeCommit: (commit: string) => string | undefined,
): VersionInfo {
  const commit = runningSha ?? headSha;

  if (!commit) {
    return { channel: "edge", version: "unknown" };
  }

  const mismatch = Boolean(runningSha && headSha && runningSha !== headSha);

  if (!headSha) {
    return {
      channel: "edge",
      version: `main @ ${commit.slice(0, 7)}`,
      commit,
    };
  }

  const exactTag = describeCommit(commit);

  return {
    channel,
    version: channel === "stable" && exactTag ? exactTag : `main @ ${commit.slice(0, 7)}`,
    commit,
    ...(mismatch ? { mismatch: true } : {}),
  };
}
