/**
 * Self-update services — check for upstream updates and trigger host-side update.
 *
 * Channel-aware: a `stable` instance tracks `origin/stable` (vetted tagged
 * releases), an `edge` instance tracks `origin/main` (every merge). See
 * docs/162-release-channels/plan.md.
 */

import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ServiceError } from "./types.js";
import {
  HOST_REPO_DIR,
  channelBranch,
  channelRef,
  readChannel,
  writeChannel,
} from "../release-channel.js";
import type { ReleaseChannel } from "../release-channel.js";
import { resolveVersion } from "../build-id.js";

const execFileAsync = promisify(execFile);

/** Timeout for git operations (30 seconds). */
const GIT_TIMEOUT_MS = 30_000;

/** Trigger file that the systemd path unit watches. */
const TRIGGER_FILE = `${HOST_REPO_DIR}/.update-requested`;

/** Trigger file for restart-only (no git pull). */
const RESTART_TRIGGER_FILE = `${HOST_REPO_DIR}/.restart-requested`;

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
 * Fetch from upstream and compare HEAD to the channel's target ref.
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
  const targetRef = channelRef(channel);

  // Fetch the channel's branch plus tags (needed to name the stable version).
  try {
    await execFileAsync("git", ["fetch", "origin", branch, "--tags"], gitOpts);
  } catch (err) {
    throw new ServiceError(503, `Failed to fetch updates: ${(err as Error).message}`);
  }

  try {
    const { stdout: currentCommit } = await execFileAsync(
      "git", ["rev-parse", "HEAD"], gitOpts,
    );
    const { stdout: latestCommit } = await execFileAsync(
      "git", ["rev-parse", targetRef], gitOpts,
    );

    const current = currentCommit.trim();
    const latest = latestCommit.trim();

    const currentVersion = await describeRef("HEAD", channel, gitOpts);
    const latestVersion = await describeRef(targetRef, channel, gitOpts);

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
  try {
    await writeFile(RESTART_TRIGGER_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    throw new ServiceError(500, `Failed to request restart: ${(err as Error).message}`);
  }
}
