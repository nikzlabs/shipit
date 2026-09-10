import { readFile, writeFile } from "node:fs/promises";
import { parseSemVer } from "./release-version.js";

export const HOST_REPO_DIR = "/opt/shipit";

// No fallback to the branch tip when stable has no final release.
export const NO_STABLE_RELEASE = "no stable release yet";

// The caller supplies tags reachable from origin/stable; commit distance is irrelevant.
export function pickLatestFinalTag(tags: readonly string[]): string | null {
  let best: { tag: string; major: number; minor: number; patch: number } | null = null;
  for (const tag of tags) {
    const v = parseSemVer(tag);
    if (!v) continue;
    if (v.prerelease.length > 0) continue;
    if (
      !best ||
      v.major > best.major ||
      (v.major === best.major && v.minor > best.minor) ||
      (v.major === best.major && v.minor === best.minor && v.patch > best.patch)
    ) {
      best = { tag, major: v.major, minor: v.minor, patch: v.patch };
    }
  }
  return best?.tag ?? null;
}

// Untracked host files survive checkout resets and image rebuilds.
export const CHANNEL_FILE = `${HOST_REPO_DIR}/.release-channel`;

// Keep in sync with FAILURE_FILE in deployment/vps/update.sh.
export const UPDATE_FAILED_FILE = `${HOST_REPO_DIR}/.update-failed`;

export type ReleaseChannel = "stable" | "edge";

// Preserve existing installs' main tracking; setup.sh writes stable for new installs.
export const DEFAULT_CHANNEL: ReleaseChannel = "edge";

export function channelRef(channel: ReleaseChannel): string {
  return channel === "stable" ? "origin/stable" : "origin/main";
}

export function channelBranch(channel: ReleaseChannel): string {
  return channel === "stable" ? "stable" : "main";
}

function normalizeChannel(raw: string | undefined): ReleaseChannel {
  return raw?.trim() === "stable" ? "stable" : DEFAULT_CHANNEL;
}

export async function readChannel(file: string = CHANNEL_FILE): Promise<ReleaseChannel> {
  try {
    return normalizeChannel(await readFile(file, "utf-8"));
  } catch {
    return DEFAULT_CHANNEL;
  }
}

export async function writeChannel(channel: ReleaseChannel, file: string = CHANNEL_FILE): Promise<void> {
  await writeFile(file, `${channel}\n`, "utf-8");
}
