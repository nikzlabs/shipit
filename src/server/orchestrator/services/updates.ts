/**
 * Self-update services — check for upstream updates and trigger host-side update.
 *
 * Channel-aware: a `stable` instance tracks `origin/stable` (vetted tagged
 * releases), an `edge` instance tracks `origin/main` (every merge). See
 * docs/162-release-channels/plan.md.
 */

import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ServiceError } from "./types.js";
import {
  HOST_REPO_DIR,
  NO_STABLE_RELEASE,
  UPDATE_FAILED_FILE,
  channelBranch,
  channelRef,
  pickLatestFinalTag,
  readChannel,
  writeChannel,
} from "../release-channel.js";
import type { ReleaseChannel } from "../release-channel.js";
import { resolveVersion } from "../build-id.js";
import { parseGitHubRemote } from "../git-utils.js";

const execFileAsync = promisify(execFile);

/** Timeout for git operations (30 seconds). */
const GIT_TIMEOUT_MS = 30_000;

/** Trigger file that the systemd path unit watches. */
const TRIGGER_FILE = `${HOST_REPO_DIR}/.update-requested`;

/** Trigger file for restart-only (no git pull). */
const RESTART_TRIGGER_FILE = `${HOST_REPO_DIR}/.restart-requested`;

export type UpdateMode = "managed" | "manual";

export function getUpdateMode(env: NodeJS.ProcessEnv = process.env): UpdateMode {
  return env.SHIPIT_MANAGED_UPDATES === "true" ? "managed" : "manual";
}

function requireManagedUpdates(): void {
  if (getUpdateMode() !== "managed") {
    throw new ServiceError(503, "Updates are applied manually for this install. Run deployment/local/update.sh in your ShipIt checkout (e.g. ~/.shipit) to update, or deployment/local/stop.sh to shut down.");
  }
}

/**
 * Record of the most recent failed in-place update, parsed from the
 * `.update-failed` breadcrumb that `update.sh` writes (and clears on the next
 * attempt / on success). Present in {@link UpdateStatus.lastUpdateError} only
 * while a failure is outstanding.
 */
export interface UpdateFailureRecord {
  /** ISO timestamp of the failure. */
  failedAt?: string;
  /** Commit the still-running image was built from (the rolled-back checkout). */
  runningSha?: string;
  /** Channel ref the failed attempt targeted (e.g. `origin/main`). */
  attemptedRef?: string;
  /** Commit the failed attempt tried to build. */
  attemptedSha?: string;
  /** Exit code of the failed update run. */
  exitCode?: number;
}

export interface UpdateStatus {
  available: boolean;
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  commitMessages: string[];
  /** Channel this check ran against. */
  channel: ReleaseChannel;
  /** Human-facing version of the running instance (`vX.Y.Z` or `main @ sha`). */
  currentVersion: string;
  /** Human-facing version available on the channel's target ref. */
  latestVersion: string;
  /**
   * True when the target ref is NOT strictly ahead of HEAD but differs from it
   * — i.e. switching to it would move the instance to older/divergent code (a
   * potential downgrade). The UI warns before applying. See Risks in the plan.
   */
  isDowngrade: boolean;
  /**
   * URL of the GitHub Release for the channel's target version, when it is a
   * stable release tag (`vX.Y.Z`) on a GitHub origin. The inline changelog is
   * the primary affordance; this is an overflow-only "View release on GitHub"
   * escape hatch (CLAUDE.md §2). Absent on edge (no release object) or when the
   * origin isn't a GitHub remote.
   */
  releaseUrl?: string;
  /** Whether Update Now / Just Restart can be handled by a host-side watcher. */
  updateMode: UpdateMode;
  /**
   * Set when the previous in-place update failed and has not yet been retried
   * successfully. The UI renders an "Update failed — still running <sha>" banner
   * so a failed update is explicit rather than inferred from version strings.
   */
  lastUpdateError?: UpdateFailureRecord;
}

/**
 * Read and parse the `.update-failed` breadcrumb, if present. Returns undefined
 * when there's no outstanding failure or the file is unreadable/malformed — a
 * missing or junk marker must never break a normal update check.
 */
async function readLastUpdateError(): Promise<UpdateFailureRecord | undefined> {
  try {
    const raw = await readFile(UPDATE_FAILED_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      failedAt: typeof parsed.failedAt === "string" ? parsed.failedAt : undefined,
      runningSha: typeof parsed.runningSha === "string" ? parsed.runningSha : undefined,
      attemptedRef: typeof parsed.attemptedRef === "string" ? parsed.attemptedRef : undefined,
      attemptedSha: typeof parsed.attemptedSha === "string" ? parsed.attemptedSha : undefined,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build the GitHub Release URL for a release tag, from the host repo's origin
 * remote. Returns undefined when the version isn't a release tag, the origin
 * isn't resolvable, or it isn't a GitHub remote — callers simply omit the
 * escape-hatch link in those cases.
 */
async function resolveReleaseUrl(
  version: string,
  channel: ReleaseChannel,
  gitOpts: { cwd: string; timeout: number },
): Promise<string | undefined> {
  // Only stable releases have a tag/Release object; edge is `main @ <sha>`.
  if (channel !== "stable" || !/^v\d+\.\d+\.\d+/.test(version)) return undefined;
  try {
    const { stdout } = await execFileAsync(
      "git", ["remote", "get-url", "origin"], gitOpts,
    );
    const parsed = parseGitHubRemote(stdout.trim());
    if (!parsed) return undefined;
    return `https://github.com/${parsed.owner}/${parsed.repo}/releases/tag/${version}`;
  } catch {
    return undefined;
  }
}

/** Resolve the version label for a commit-ish in the host repo. */
async function describeRef(
  ref: string,
  channel: ReleaseChannel,
  gitOpts: { cwd: string; timeout: number },
): Promise<string> {
  // Tag name when the ref points exactly at a release tag, else main @ <sha>.
  try {
    const { stdout } = await execFileAsync(
      "git", ["describe", "--tags", "--exact-match", ref], gitOpts,
    );
    const tag = stdout.trim();
    if (tag && channel === "stable") return tag;
  } catch {
    // not on a tag — fall through to sha form
  }
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", ref], gitOpts);
    return `main @ ${stdout.trim()}`;
  } catch {
    return ref;
  }
}

/**
 * Resolve the stable channel's target — the latest **final** (non-prerelease)
 * release tag reachable from `origin/stable`, and its commit (docs/214 Option A).
 *
 * We use `git tag --merged origin/stable` (reachability) + a strict-SemVer
 * highest-version pick, NOT `git describe` (nearest tag by commit distance) and
 * NOT the branch tip (which is transiently an un-published merge commit after a
 * release PR merges, before CI tags + publishes). Returns null when no final tag
 * is reachable, so the caller fails closed instead of offering an un-released
 * commit.
 */
async function resolveLatestStableTag(
  gitOpts: { cwd: string; timeout: number },
): Promise<{ tag: string; commit: string } | null> {
  let tags: string[];
  try {
    const { stdout } = await execFileAsync("git", ["tag", "--merged", "origin/stable"], gitOpts);
    tags = stdout.split("\n").map((t) => t.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const tag = pickLatestFinalTag(tags);
  if (!tag) return null;
  try {
    // Resolve the (annotated) tag to its commit SHA.
    const { stdout } = await execFileAsync("git", ["rev-parse", `${tag}^{commit}`], gitOpts);
    return { tag, commit: stdout.trim() };
  } catch {
    return null;
  }
}

/**
 * Fetch from upstream and compare HEAD to the channel's target.
 *
 * - **edge** tracks the `origin/main` branch tip (every merge).
 * - **stable** tracks the latest final tag reachable from `origin/stable`
 *   (docs/214 Option A), NOT the branch tip — so the merge-before-publish window
 *   is invisible and a failed publish strands nothing. Fails closed ("no stable
 *   release yet") when no final tag exists.
 *
 * Requires /opt/shipit to be bind-mounted into the container.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  const gitOpts = { cwd: HOST_REPO_DIR, timeout: GIT_TIMEOUT_MS };

  // Verify the host repo is mounted
  try {
    await access(HOST_REPO_DIR);
  } catch {
    throw new ServiceError(503, `Host repo not available at ${HOST_REPO_DIR}`);
  }

  const channel = await readChannel();
  const branch = channelBranch(channel);

  // Fetch the channel's branch plus tags (needed to resolve/name the version).
  try {
    await execFileAsync("git", ["fetch", "origin", branch, "--tags"], gitOpts);
  } catch (err) {
    throw new ServiceError(503, `Failed to fetch updates: ${(err as Error).message}`);
  }

  try {
    const { stdout: currentCommit } = await execFileAsync(
      "git", ["rev-parse", "HEAD"], gitOpts,
    );
    const current = currentCommit.trim();
    const currentVersion = await describeRef("HEAD", channel, gitOpts);
    const lastUpdateError = await readLastUpdateError();

    // Resolve the channel's target commit + human version label.
    let targetRef: string;
    let latestVersion: string;
    if (channel === "stable") {
      // Option A: advance only to the latest final tag reachable from
      // origin/stable — never the (possibly un-published) branch tip.
      const resolved = await resolveLatestStableTag(gitOpts);
      if (!resolved) {
        // Fail closed — no final release tag yet; do not offer the branch tip.
        return {
          available: false,
          currentCommit: current,
          latestCommit: current,
          behindBy: 0,
          commitMessages: [],
          channel,
          currentVersion,
          latestVersion: NO_STABLE_RELEASE,
          isDowngrade: false,
          updateMode: getUpdateMode(),
          lastUpdateError,
        };
      }
      targetRef = resolved.commit;
      latestVersion = resolved.tag;
    } else {
      targetRef = channelRef(channel); // origin/main
      latestVersion = await describeRef(targetRef, channel, gitOpts);
    }

    const { stdout: latestCommit } = await execFileAsync(
      "git", ["rev-parse", targetRef], gitOpts,
    );
    const latest = latestCommit.trim();

    const releaseUrl = await resolveReleaseUrl(latestVersion, channel, gitOpts);

    if (current === latest) {
      return {
        available: false,
        currentCommit: current,
        latestCommit: latest,
        behindBy: 0,
        commitMessages: [],
        channel,
        currentVersion,
        latestVersion,
        isDowngrade: false,
        releaseUrl,
        updateMode: getUpdateMode(),
        lastUpdateError,
      };
    }

    // How many commits the target ref is ahead of HEAD.
    const { stdout: countStr } = await execFileAsync(
      "git", ["rev-list", "--count", `HEAD..${targetRef}`], gitOpts,
    );
    const behindBy = parseInt(countStr.trim(), 10) || 0;

    // When the refs differ but the target is not ahead of HEAD (behindBy === 0),
    // applying it would move to divergent/older code — a potential downgrade.
    // This is the edge→stable case where HEAD (a recent main commit) is ahead
    // of origin/stable.
    const isDowngrade = behindBy === 0;

    const { stdout: logOutput } = await execFileAsync(
      "git",
      ["log", "--oneline", "--no-decorate", isDowngrade ? `${targetRef}..HEAD` : `HEAD..${targetRef}`],
      gitOpts,
    );
    const commitMessages = logOutput.trim().split("\n").filter(Boolean);

    return {
      available: true,
      currentCommit: current,
      latestCommit: latest,
      behindBy,
      commitMessages,
      channel,
      currentVersion,
      latestVersion,
      isDowngrade,
      releaseUrl,
      updateMode: getUpdateMode(),
      lastUpdateError,
    };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(500, `Failed to check updates: ${(err as Error).message}`);
  }
}

/**
 * Persist the release-channel preference, then return a fresh
 * {@link checkForUpdates} result so the UI can immediately show what switching
 * implies (e.g. a downgrade warning).
 */
export async function setChannel(channel: ReleaseChannel): Promise<UpdateStatus> {
  if (channel !== "stable" && channel !== "edge") {
    throw new ServiceError(400, `Invalid channel: ${String(channel)}`);
  }
  try {
    await access(HOST_REPO_DIR);
  } catch {
    throw new ServiceError(503, `Host repo not available at ${HOST_REPO_DIR}`);
  }
  try {
    await writeChannel(channel);
  } catch (err) {
    throw new ServiceError(500, `Failed to set channel: ${(err as Error).message}`);
  }
  return checkForUpdates();
}

/** The current channel + version of the running instance (no fetch). */
export async function getVersion() {
  const channel = await readChannel();
  return resolveVersion(channel);
}

/**
 * Write the trigger file that the host-side systemd path unit watches.
 * The update happens asynchronously — the container will be restarted.
 */
export async function requestUpdate(): Promise<void> {
  requireManagedUpdates();
  try {
    await writeFile(TRIGGER_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    throw new ServiceError(500, `Failed to request update: ${(err as Error).message}`);
  }
}

/**
 * Write the restart trigger file. The host-side systemd path unit watches for
 * this file and restarts ShipIt without pulling code updates.
 */
export async function requestRestart(): Promise<void> {
  requireManagedUpdates();
  try {
    await writeFile(RESTART_TRIGGER_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    throw new ServiceError(500, `Failed to request restart: ${(err as Error).message}`);
  }
}
