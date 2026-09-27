import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Docker from "dockerode";
import type { SessionIdentity } from "../shared/session-identity.js";
import { resolveVolumeMountpoint } from "./overlay-volume.js";
import { applyDefaultGroupAcl, identityForTarget, sessionWorkerGid } from "./session-worker-uid.js";

export interface PersistPrepDeps {
  identity: (target: string) => SessionIdentity | null;
  mkdirAs: (dir: string, owner: SessionIdentity | null) => void;
  defaultAcl: (dirs: readonly string[]) => void;
  /** False where ShipIt runs without a session-worker identity (dev): skip the handoff. */
  handsOff: () => boolean;
}

const defaultDeps: PersistPrepDeps = {
  identity: identityForTarget,
  mkdirAs: (dir, owner) => mkdirAsSession(dir, owner),
  defaultAcl: (dirs) => applyDefaultGroupAcl(dirs),
  handsOff: () => sessionWorkerGid() !== null,
};

/**
 * Make /persist and each mounted subdirectory exist before the daemon mounts them: a volume
 * subpath must exist, and Docker would create a missing root as root-owned.
 */
export function preparePersistDir(
  scratchDir: string,
  subpaths: readonly string[],
  deps: PersistPrepDeps = defaultDeps,
): void {
  fs.mkdirSync(scratchDir, { recursive: true });
  const root = fs.lstatSync(scratchDir);
  if (!root.isDirectory()) throw new Error(`${scratchDir} is not a directory.`);
  const owner = deps.handsOff() ? deps.identity(scratchDir) : null;
  if (owner !== null) {
    // Safe to change as root: the scratch root's parent is never mounted into any container.
    try {
      fs.lchownSync(scratchDir, owner.uid, owner.gid);
      fs.chmodSync(scratchDir, (root.mode & 0o7777) | 0o2070);
      deps.defaultAcl([scratchDir]);
    } catch (err) {
      // The agent container's entrypoint also hands /persist over, so a service still gets it.
      console.warn(`[compose-persist] could not hand ${scratchDir} to the session user:`, message(err));
    }
  }
  for (const subpath of new Set(subpaths)) {
    if (subpath === "") continue;
    try {
      deps.mkdirAs(path.join(scratchDir, subpath), owner);
    } catch (err) {
      throw new Error(`Could not create /persist/${subpath} for a compose service: ${message(err)}`, { cause: err });
    }
  }
}

export type RunAs = (command: "mkdir" | "chmod" | "setfacl", args: string[], owner: SessionIdentity) => void;

export interface MkdirAsDeps {
  isRoot: () => boolean;
  run: RunAs;
}

const mkdirAsDefaults: MkdirAsDeps = {
  isRoot: () => process.getuid?.() === 0,
  run: (command, args, owner) => {
    execFileSync(command, args, { uid: owner.uid, gid: owner.gid, stdio: "pipe" });
  },
};

// Everything below the root is the session's to rearrange, so work on it with the session's own
// rights: a planted symlink then reaches nothing the session could not already write.
export function mkdirAsSession(
  dir: string,
  owner: SessionIdentity | null,
  deps: MkdirAsDeps = mkdirAsDefaults,
): void {
  if (owner === null || !deps.isRoot()) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }
  deps.run("mkdir", ["-p", "--", dir], owner);
  // A directory the agent made earlier keeps its own mode; a service with its own `user:` writes
  // through the session group, as in the root.
  try {
    deps.run("chmod", ["g+rwxs", "--", dir], owner);
    deps.run("setfacl", ["-d", "-m", "g::rwx", "--", dir], owner);
  } catch (err) {
    console.warn(`[compose-persist] could not give the session group write access to ${dir}:`, message(err));
  }
}

/**
 * Translate an orchestrator path inside the workspace volume (mounted at /workspace here) to the
 * daemon's path for it; a bind-backed volume's device is read by the daemon, not by us.
 */
export function workspaceVolumeDaemonPath(
  docker: Docker,
  workspaceVolume: string,
): (hostPath: string) => Promise<string> {
  let mountpoint: Promise<string> | null = null;
  return async (hostPath) => {
    const rel = path.posix.relative("/workspace", hostPath);
    if (rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
      throw new Error(`${hostPath} is not inside the workspace volume ${workspaceVolume}.`);
    }
    mountpoint ??= resolveVolumeMountpoint(docker, workspaceVolume).catch((err: unknown) => {
      mountpoint = null;
      throw err;
    });
    return path.posix.join(await mountpoint, rel);
  };
}

// execFileSync puts mkdir's own explanation on stderr, as a Buffer.
function message(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const { stderr } = err;
    const text = Buffer.isBuffer(stderr) || typeof stderr === "string" ? stderr.toString().trim() : "";
    if (text) return text;
  }
  return err instanceof Error ? err.message : String(err);
}
