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
import { parseGitHubRemote } from "../git-utils.js";
import { gitArgsWithHooksDisabled } from "../../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../../shared/git-tree-uid.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

// The host's systemd path units watch these files.
const TRIGGER_FILE = `${HOST_REPO_DIR}/.update-requested`;

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

export interface UpdateFailureRecord {
  failedAt?: string;
  runningSha?: string;
  attemptedRef?: string;
  attemptedSha?: string;
  exitCode?: number;
}

export interface UpdateStatus {
  available: boolean;
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  commitMessages: string[];
  channel: ReleaseChannel;
  currentVersion: string;
  latestVersion: string;
  isDowngrade: boolean;
  releaseUrl?: string;
  updateMode: UpdateMode;
  lastUpdateError?: UpdateFailureRecord;
}

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

async function resolveReleaseUrl(
  version: string,
  channel: ReleaseChannel,
  gitOpts: { cwd: string; timeout: number },
): Promise<string | undefined> {
  if (channel !== "stable" || !/^v\d+\.\d+\.\d+/.test(version)) return undefined;
  try {
    const { stdout } = await execFileAsync(
      "git", gitArgsWithHooksDisabled(["remote", "get-url", "origin"]), gitOpts,
    );
    const parsed = parseGitHubRemote(stdout.trim());
    if (!parsed) return undefined;
    return `https://github.com/${parsed.owner}/${parsed.repo}/releases/tag/${version}`;
  } catch {
    return undefined;
  }
}

async function describeRef(
  ref: string,
  channel: ReleaseChannel,
  gitOpts: { cwd: string; timeout: number },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git", gitArgsWithHooksDisabled(["describe", "--tags", "--exact-match", ref]), gitOpts,
    );
    const tag = stdout.trim();
    if (tag && channel === "stable") return tag;
  } catch {
    // Fall back to the commit label.
  }
  try {
    const { stdout } = await execFileAsync("git", gitArgsWithHooksDisabled(["rev-parse", "--short", ref]), gitOpts);
    return `main @ ${stdout.trim()}`;
  } catch {
    return ref;
  }
}

// The branch tip can precede publication; offer only the highest reachable final tag.
async function resolveLatestStableTag(
  gitOpts: { cwd: string; timeout: number },
): Promise<{ tag: string; commit: string } | null> {
  let tags: string[];
  try {
    const { stdout } = await execFileAsync("git", gitArgsWithHooksDisabled(["tag", "--merged", "origin/stable"]), gitOpts);
    tags = stdout.split("\n").map((t) => t.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const tag = pickLatestFinalTag(tags);
  if (!tag) return null;
  try {
    const { stdout } = await execFileAsync("git", gitArgsWithHooksDisabled(["rev-parse", `${tag}^{commit}`]), gitOpts);
    return { tag, commit: stdout.trim() };
  } catch {
    return null;
  }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  const gitOpts = {
    cwd: HOST_REPO_DIR,
    timeout: GIT_TIMEOUT_MS,
    ...gitSpawnOverridesForTree(HOST_REPO_DIR),
  };

  try {
    await access(HOST_REPO_DIR);
  } catch {
    throw new ServiceError(503, `Host repo not available at ${HOST_REPO_DIR}`);
  }

  const channel = await readChannel();
  const branch = channelBranch(channel);

  try {
    await execFileAsync("git", gitArgsWithHooksDisabled(["fetch", "origin", branch, "--tags"]), gitOpts);
  } catch (err) {
    throw new ServiceError(503, `Failed to fetch updates: ${(err as Error).message}`);
  }

  try {
    const { stdout: currentCommit } = await execFileAsync(
      "git", gitArgsWithHooksDisabled(["rev-parse", "HEAD"]), gitOpts,
    );
    const current = currentCommit.trim();
    const currentVersion = await describeRef("HEAD", channel, gitOpts);
    const lastUpdateError = await readLastUpdateError();

    let targetRef: string;
    let latestVersion: string;
    if (channel === "stable") {
      const resolved = await resolveLatestStableTag(gitOpts);
      if (!resolved) {
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
      targetRef = channelRef(channel);
      latestVersion = await describeRef(targetRef, channel, gitOpts);
    }

    const { stdout: latestCommit } = await execFileAsync(
      "git", gitArgsWithHooksDisabled(["rev-parse", targetRef]), gitOpts,
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

    const { stdout: countStr } = await execFileAsync(
      "git", gitArgsWithHooksDisabled(["rev-list", "--count", `HEAD..${targetRef}`]), gitOpts,
    );
    const behindBy = parseInt(countStr.trim(), 10) || 0;

    const isDowngrade = behindBy === 0;

    const { stdout: logOutput } = await execFileAsync(
      "git",
      gitArgsWithHooksDisabled(["log", "--oneline", "--no-decorate", isDowngrade ? `${targetRef}..HEAD` : `HEAD..${targetRef}`]),
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

export async function requestUpdate(): Promise<void> {
  requireManagedUpdates();
  try {
    await writeFile(TRIGGER_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    throw new ServiceError(500, `Failed to request update: ${(err as Error).message}`);
  }
}

export async function requestRestart(): Promise<void> {
  requireManagedUpdates();
  try {
    await writeFile(RESTART_TRIGGER_FILE, new Date().toISOString(), "utf-8");
  } catch (err) {
    throw new ServiceError(500, `Failed to request restart: ${(err as Error).message}`);
  }
}
