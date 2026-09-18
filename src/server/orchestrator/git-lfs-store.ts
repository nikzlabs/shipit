import fs from "node:fs";
import path from "node:path";
import { runGit, repoDeclaresLfs, isGitLfsAvailable, PROBE_TIMEOUT_MS } from "./git-lfs.js";
import {
  type GitRemoteCredentialResolver,
  gitCredentialSpawnOverrides,
  looksLikeAuthRejection,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
  withPreemptiveAuthFallback,
} from "../shared/git-remote-credential.js";

// Hardlinks let clones prune independently. Never chown the shared object files.
const SHARED_STORE_ENV = "SHIPIT_GIT_LFS_SHARED_STORE";
const DEFAULT_CACHE_FETCH_TIMEOUT_MS = 900_000;
const CACHE_FETCH_TIMEOUT_ENV = "SHIPIT_GIT_LFS_CACHE_FETCH_TIMEOUT_MS";

export function lfsSharedStoreEnabled(): boolean {
  const raw = (process.env[SHARED_STORE_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

function cacheFetchTimeoutMs(): number {
  const raw = Number(process.env[CACHE_FETCH_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_FETCH_TIMEOUT_MS;
}

export function lfsObjectsDir(repoDir: string, bare: boolean): string {
  return bare ? path.join(repoDir, "lfs", "objects") : path.join(repoDir, ".git", "lfs", "objects");
}

export interface LinkStats {
  linked: number;
  copied: number;
  present: number;
  failed: number;
}

// A default-branch rename can leave the bare cache's HEAD dangling.
export async function resolveCacheFetchRef(bareRepoDir: string): Promise<string | null> {
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], bareRepoDir, PROBE_TIMEOUT_MS);
  if (head.code === 0 && head.stdout.trim()) {
    const sym = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], bareRepoDir, PROBE_TIMEOUT_MS);
    const branch = sym.stdout.trim();
    if (sym.code === 0 && branch) return branch;
  }
  const refs = await runGit(
    ["for-each-ref", "--count=1", "--format=%(refname:short)", "refs/heads/"],
    bareRepoDir,
    PROBE_TIMEOUT_MS,
  );
  const first = refs.stdout.trim().split("\n")[0]?.trim();
  return first || null;
}

// Run during cache refresh, not provisioning. Ordinary git fetch omits LFS objects.
export async function fetchLfsIntoCache(
  bareRepoDir: string,
  opts?: {
    isAvailable?: () => Promise<boolean>;
    resolveCredential?: GitRemoteCredentialResolver;
  },
): Promise<boolean> {
  if (!lfsSharedStoreEnabled()) return false;
  try {
    // Detection also needs the resolved ref when HEAD dangles.
    const ref = await resolveCacheFetchRef(bareRepoDir);
    if (!ref) return false;
    if (!(await repoDeclaresLfs(bareRepoDir, ref))) return false;
    if (!(await (opts?.isAvailable ?? isGitLfsAvailable)())) {
      console.warn(`[git-lfs-store] Skipping cache fetch for ${bareRepoDir} — git-lfs binary unavailable`);
      return false;
    }
    const startedAt = Date.now();
    const credential = await resolveTreeRemoteCredential(bareRepoDir, "origin", opts?.resolveCredential);
    const res = await withPreemptiveAuthFallback(credential, "cache LFS fetch", (cred) => {
      const overrides = gitCredentialSpawnOverrides(cred);
      return runGit(
        [...overrides.args, "lfs", "fetch", "origin", ref],
        bareRepoDir,
        cacheFetchTimeoutMs(),
        cred ? { ...sanitizeGitEnv(process.env), ...overrides.env } : undefined,
      );
    }, (r) => r.code !== 0 && looksLikeAuthRejection(r.stderr || r.stdout));
    const durationMs = Date.now() - startedAt;
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200);
      console.warn(
        `[git-lfs-store] Cache LFS fetch failed for ${bareRepoDir} ` +
          `(${res.timedOut ? "timed out" : `exit ${res.code ?? "abnormal"}`})${detail ? `: ${detail}` : ""}` +
          ` — sessions will download their own objects`,
      );
      return false;
    }
    console.log(`[git-lfs-store] Fetched LFS objects into cache ${bareRepoDir} in ${durationMs}ms`);
    return true;
  } catch (err) {
    console.warn(`[git-lfs-store] Cache LFS fetch threw for ${bareRepoDir}:`, String(err));
    return false;
  }
}

// Seed before materialization; the subsequent pull downloads missing objects.
export function linkLfsObjectsIntoClone(bareRepoDir: string, sessionDir: string): LinkStats {
  const stats: LinkStats = { linked: 0, copied: 0, present: 0, failed: 0 };
  if (!lfsSharedStoreEnabled()) return stats;
  const src = lfsObjectsDir(bareRepoDir, true);
  const dst = lfsObjectsDir(sessionDir, false);
  try {
    if (!fs.existsSync(src)) return stats;
    linkTree(src, dst, stats);
    const total = stats.linked + stats.copied;
    if (total > 0 || stats.failed > 0) {
      console.log(
        `[git-lfs-store] Seeded ${sessionDir} from cache: ${stats.linked} linked, ` +
          `${stats.copied} copied, ${stats.present} already present, ${stats.failed} failed`,
      );
    }
  } catch (err) {
    console.warn(`[git-lfs-store] Seeding ${sessionDir} from ${bareRepoDir} failed:`, String(err));
  }
  return stats;
}

function linkTree(src: string, dst: string, stats: LinkStats): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  let dstReady = false;
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      linkTree(from, to, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!dstReady) {
      try {
        fs.mkdirSync(dst, { recursive: true });
        dstReady = true;
      } catch {
        stats.failed += entries.length;
        return;
      }
    }
    try {
      fs.linkSync(from, to);
      stats.linked++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        stats.present++;
        continue;
      }
      try {
        fs.copyFileSync(from, to);
        stats.copied++;
      } catch {
        stats.failed++;
      }
    }
  }
}
