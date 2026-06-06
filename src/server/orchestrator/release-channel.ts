/**
 * Release channel support — stable vs edge.
 *
 * The channel preference lives in an untracked file on the bind-mounted host
 * repo (`/opt/shipit/.release-channel`) so it survives `git reset --hard` and
 * image rebuilds. This mirrors the existing `.update-requested` /
 * `.restart-requested` trigger-file pattern — no new mount or IPC channel.
 *
 * See docs/162-release-channels/plan.md.
 */

import { readFile, writeFile } from "node:fs/promises";

/** Path to the host repo, bind-mounted into the orchestrator container. */
export const HOST_REPO_DIR = "/opt/shipit";

/** Untracked file holding the one-word channel preference. */
export const CHANNEL_FILE = `${HOST_REPO_DIR}/.release-channel`;

/**
 * Untracked breadcrumb written by `update.sh` when an in-place update fails
 * (the build errored and the checkout was rolled back to the running image).
 * `checkForUpdates()` reads it to surface "Update failed — still running <sha>"
 * instead of leaving the user to infer a failure from mismatched version
 * strings. Removed by `update.sh` at the start of the next attempt and on
 * success. Keep this path in sync with FAILURE_FILE in deployment/vps/update.sh.
 */
export const UPDATE_FAILED_FILE = `${HOST_REPO_DIR}/.update-failed`;

export type ReleaseChannel = "stable" | "edge";

/**
 * Default channel when the preference file is absent. We default to `edge`
 * everywhere so existing installs (upgrading into this feature with no file)
 * keep tracking `main` exactly as before — no surprise downgrade. New installs
 * get `stable` written explicitly by `setup.sh`.
 */
export const DEFAULT_CHANNEL: ReleaseChannel = "edge";

/** The git ref each channel tracks. */
export function channelRef(channel: ReleaseChannel): string {
  return channel === "stable" ? "origin/stable" : "origin/main";
}

/** The short remote branch name (without the `origin/` prefix). */
export function channelBranch(channel: ReleaseChannel): string {
  return channel === "stable" ? "stable" : "main";
}

function normalizeChannel(raw: string | undefined): ReleaseChannel {
  return raw?.trim() === "stable" ? "stable" : DEFAULT_CHANNEL;
}

/**
 * Read the persisted channel preference. Returns {@link DEFAULT_CHANNEL} when
 * the file is missing or unreadable (e.g. local/dogfood mode with no host
 * mount), so callers degrade gracefully.
 */
export async function readChannel(file: string = CHANNEL_FILE): Promise<ReleaseChannel> {
  try {
    return normalizeChannel(await readFile(file, "utf-8"));
  } catch {
    return DEFAULT_CHANNEL;
  }
}

/** Persist the channel preference to the host repo. */
export async function writeChannel(channel: ReleaseChannel, file: string = CHANNEL_FILE): Promise<void> {
  await writeFile(file, `${channel}\n`, "utf-8");
}
