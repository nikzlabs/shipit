import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { ServiceError } from "./services/types.js";
import { sessionScratchDirForWorkspace } from "./session-state-dir.js";
import { CONTAINER_PERSIST_DIR } from "../shared/fs-constants.js";

const PERSIST_PATH_PREFIX = `${CONTAINER_PERSIST_DIR}/`;

/**
 * Maps a `/persist/…` path to the session's scratch dir, or returns null for
 * any other path. Workspace paths never start with "/", so the two cannot collide.
 */
export function resolvePersistPath(
  workspaceDir: string,
  filePath: string,
): { dir: string; relPath: string } | null {
  if (!filePath.startsWith(PERSIST_PATH_PREFIX)) return null;
  return {
    dir: sessionScratchDirForWorkspace(workspaceDir),
    relPath: filePath.slice(PERSIST_PATH_PREFIX.length),
  };
}

function isWithin(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/**
 * Opens `relPath` under `root`, and returns the handle only if the file it
 * actually opened lies inside `root`; otherwise throws `ServiceError(400)`.
 *
 * The agent writes the session's directories, so a symlink there can name any
 * file the orchestrator can reach. Checking a path and then opening it resolves
 * the path twice, leaving a window to swap a symlink in; checking the opened
 * descriptor leaves none. `O_NONBLOCK` keeps a FIFO from wedging the open
 * (planning#575), so callers must still check `isFile()` on the handle.
 */
export async function openWithinRoot(
  root: string,
  relPath: string,
  flags: number = constants.O_RDONLY,
): Promise<FileHandle> {
  if (!isWithin(root, path.resolve(root, relPath))) {
    throw new ServiceError(400, "Invalid path");
  }
  const handle = await fs.open(path.resolve(root, relPath), flags | constants.O_NONBLOCK);
  try {
    const [opened, realRoot] = await Promise.all([
      fs.readlink(`/proc/self/fd/${handle.fd}`),
      fs.realpath(root),
    ]);
    if (!isWithin(realRoot, opened)) throw new ServiceError(400, "Invalid path");
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export async function readFileWithinRoot(root: string, relPath: string): Promise<Buffer> {
  const handle = await openWithinRoot(root, relPath);
  try {
    if (!(await handle.stat()).isFile()) throw new ServiceError(400, "Path is not a file");
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}
