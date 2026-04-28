/**
 * Self-update services — check for upstream updates and trigger host-side update.
 */

import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ServiceError } from "./types.js";

const execFileAsync = promisify(execFile);

/** Timeout for git operations (30 seconds). */
const GIT_TIMEOUT_MS = 30_000;

/** Path to the host repo, bind-mounted into the container. */
const HOST_REPO_DIR = "/opt/shipit";

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
}

/**
 * Fetch from upstream and compare HEAD to origin/main.
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

  try {
    await execFileAsync("git", ["fetch", "origin", "main"], gitOpts);
  } catch (err) {
    throw new ServiceError(503, `Failed to fetch updates: ${(err as Error).message}`);
  }

  try {
    const { stdout: currentCommit } = await execFileAsync(
      "git", ["rev-parse", "HEAD"], gitOpts,
    );
    const { stdout: latestCommit } = await execFileAsync(
      "git", ["rev-parse", "origin/main"], gitOpts,
    );

    const current = currentCommit.trim();
    const latest = latestCommit.trim();

    if (current === latest) {
      return { available: false, currentCommit: current, latestCommit: latest, behindBy: 0, commitMessages: [] };
    }

    const { stdout: countStr } = await execFileAsync(
      "git", ["rev-list", "--count", `HEAD..origin/main`], gitOpts,
    );
    const behindBy = parseInt(countStr.trim(), 10) || 0;

    const { stdout: logOutput } = await execFileAsync(
      "git", ["log", "--oneline", "--no-decorate", `HEAD..origin/main`], gitOpts,
    );
    const commitMessages = logOutput.trim().split("\n").filter(Boolean);

    return { available: true, currentCommit: current, latestCommit: latest, behindBy, commitMessages };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(500, `Failed to check updates: ${(err as Error).message}`);
  }
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
