import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { OVERLAY_SESSION_SUBDIR } from "./overlay-session.js";
import {
  SESSION_STATE_SUBDIR,
  SESSION_WORKSPACE_SUBDIR,
  INSTALL_MARKER_FILE,
  sessionStateDirForWorkspace,
  sessionSharedStateDir,
} from "./session-state-dir.js";

export async function statfsFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

export async function statfsTotalBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.statfs(dir);
    return st.blocks * st.bsize;
  } catch {
    return null;
  }
}

export function resolveDiskWatermarks(inputs: {
  lowBytes?: number;
  highBytes?: number;
  lowPct?: number;
  highPct?: number;
  totalBytes: number | null;
}): { diskFreeLow?: number; diskFreeHigh?: number } {
  const resolve = (bytes: number | undefined, pct: number | undefined): number | undefined => {
    if (bytes !== undefined) return bytes;
    if (pct !== undefined && inputs.totalBytes !== null) return pct * inputs.totalBytes;
    return undefined;
  };
  return {
    diskFreeLow: resolve(inputs.lowBytes, inputs.lowPct),
    diskFreeHigh: resolve(inputs.highBytes, inputs.highPct),
  };
}

export function getMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Delete only these children; uploads and other durable siblings must survive.
export const REGENERABLE_SESSION_SUBDIRS = [
  "workspace",
  OVERLAY_SESSION_SUBDIR,
  // The install marker must not outlive the checkout it describes.
  SESSION_STATE_SUBDIR,
] as const;

export async function reclaimRegenerableSessionDirs(
  workspaceDir: string,
  opts: { paceMs?: number } = {},
): Promise<{ removed: string[]; failed: { dir: string; message: string }[] }> {
  const paceMs = opts.paceMs ?? 0;
  const sessionRoot = path.dirname(workspaceDir);
  const targets = [
    workspaceDir,
    ...REGENERABLE_SESSION_SUBDIRS
      .filter((sub) => sub !== SESSION_WORKSPACE_SUBDIR)
      .map((sub) => path.join(sessionRoot, sub)),
  ];
  const removed: string[] = [];
  const failed: { dir: string; message: string }[] = [];
  for (const dir of targets) {
    try {
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat) continue;
      await sleep(paceMs);
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      failed.push({ dir, message: getMessage(err) });
    }
  }
  return { removed, failed };
}

export async function reclaimBlockedSessionCaches(
  workspaceDir: string,
): Promise<{ removed: string[]; message?: string }> {
  const overlayDir = path.join(path.dirname(workspaceDir), OVERLAY_SESSION_SUBDIR);
  const removed: string[] = [];
  try {
    // If marker resolution fails, preserve the overlay too.
    const markerFile = path.join(
      sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)), INSTALL_MARKER_FILE,
    );
    // Remove the marker first: partial failure must trigger reinstall, not skip missing deps.
    if (await fs.stat(markerFile).catch(() => null)) {
      await fs.rm(markerFile, { force: true });
      removed.push(markerFile);
    }
    if (await fs.stat(overlayDir).catch(() => null)) {
      await fs.rm(overlayDir, { recursive: true, force: true });
      removed.push(overlayDir);
    }
    return { removed };
  } catch (err) {
    return { removed, message: getMessage(err) };
  }
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function defaultRunDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`docker ${args[0]} exited ${code}: ${output.trim()}`));
    });
    proc.on("error", reject);
  });
}
