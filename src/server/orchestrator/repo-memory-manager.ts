/**
 * Per-repo Claude memory sharing (docs/155).
 *
 * The Claude CLI accumulates its file-based "memory" (user/feedback/project/
 * reference notes) under `~/.claude/projects/<encoded-cwd>/memory/` inside
 * the session container (docs/150 — `~` is `/home/shipit`, was `/root`). cwd is
 * always `/workspace`, so the encoded project
 * slug is `-workspace`. Per-session credential isolation (docs/138) gives each
 * session its OWN `.claude`, so memory written in one session is invisible to
 * the next — defeating memory's whole point as a long-lived store.
 *
 * We share it per-repo, NOT per-`.claude`: the source of truth lives on the
 * orchestrator host at `<credentialsRoot>/repo-memory/<repoHash>/`, keyed by the
 * same repo hash `RepoGit` uses for `repo-cache/<hash>` / `dep-cache/<hash>`.
 * On a Claude session's first turn we copy that dir INTO the session's memory
 * subtree; after each turn we copy modified files back OUT. This mirrors the
 * per-turn OAuth token sync (no live bind mount) so warm containers and Codex
 * isolation are untouched: nothing is materialized until the session is pinned
 * to Claude AND has a remote URL. Last-write-wins per file is acceptable —
 * each memory is a separate file by slug; only the shared `MEMORY.md` index
 * can race, and it is regeneratable. See plan.md for the full rationale.
 */

import fs from "node:fs";
import path from "node:path";
import {
  chownSessionCredentialsTree,
  perSessionCredentialsDir,
} from "./session-credentials-scaffold.js";

/** Subdirectory under the credentials root holding per-repo shared memory dirs. */
export const REPO_MEMORY_SUBDIR = "repo-memory";

/**
 * Claude's auto-memory directory relative to a per-session credentials dir. The
 * container symlinks `~/.claude -> /credentials/.claude` and runs with cwd
 * `/workspace`, so the CLI's project slug is `-workspace`. Claude-CLI-specific
 * on-disk shape (docs/155) — callers gate on the Claude agent before using it.
 */
const CLAUDE_MEMORY_REL = path.join(".claude", "projects", "-workspace", "memory");

/** Absolute host path of the shared per-repo memory dir for a repo hash. */
export function repoMemoryDir(credentialsRoot: string, repoHash: string): string {
  return path.join(credentialsRoot, REPO_MEMORY_SUBDIR, repoHash);
}

/** Copy a file preserving its source mtime, via temp + atomic rename. Preserving
 * mtime is what makes the newer-wins comparison in {@link mirrorNewerMemoryFiles}
 * stable across a copy-in/copy-back round trip: an unchanged file keeps the same
 * mtime in the session dir and the shared dir, so it never copies back. */
function copyFilePreservingMtime(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  try {
    const st = fs.statSync(src);
    fs.utimesSync(tmp, st.atime, st.mtime);
  } catch {
    // Best-effort mtime preservation — a failure just means an unchanged file
    // may copy back once next turn (harmless, last-write-wins).
  }
  fs.renameSync(tmp, dst);
}

/**
 * Recursively mirror files from `srcRoot` into `dstRoot`, copying a file only
 * when the destination is missing or strictly older (last-write-wins by mtime).
 * Directories are created as needed; non-regular files (symlinks, sockets) are
 * skipped. Best-effort — a per-file error is logged and skipped, never thrown.
 * Returns the number of files copied.
 */
function mirrorNewerMemoryFiles(srcRoot: string, dstRoot: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  } catch {
    return 0; // src missing — nothing to mirror
  }
  let copied = 0;
  for (const entry of entries) {
    const src = path.join(srcRoot, entry.name);
    const dst = path.join(dstRoot, entry.name);
    if (entry.isDirectory()) {
      copied += mirrorNewerMemoryFiles(src, dst);
      continue;
    }
    if (!entry.isFile()) continue; // skip symlinks/specials
    let srcStat: fs.Stats;
    try {
      srcStat = fs.statSync(src);
    } catch {
      continue;
    }
    let dstStat: fs.Stats | null = null;
    try {
      dstStat = fs.statSync(dst);
    } catch {
      // dst missing — copy
    }
    if (dstStat && srcStat.mtimeMs <= dstStat.mtimeMs) continue; // dst as fresh or fresher
    try {
      copyFilePreservingMtime(src, dst);
      copied += 1;
    } catch (err) {
      console.warn(`[session-credentials] failed to mirror memory file ${src} -> ${dst}:`, err);
    }
  }
  return copied;
}

/**
 * First-turn provisioning (docs/155): seed a Claude session's memory subtree
 * from the shared per-repo memory dir. Creates the shared dir if this is the
 * first session for the repo (so sync-back has a destination), then copies its
 * files into `<sessionDir>/.claude/projects/-workspace/memory/`. Best-effort;
 * never throws. Callers gate on `agentId === "claude"` and a non-empty remote
 * URL — sessions without a remote get no shared dir (memory stays ephemeral).
 */
export function provisionRepoMemory(
  credentialsRoot: string,
  sessionId: string,
  repoHash: string,
): void {
  const shared = repoMemoryDir(credentialsRoot, repoHash);
  const sessionMemory = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), CLAUDE_MEMORY_REL);
  try {
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(sessionMemory, { recursive: true });
    mirrorNewerMemoryFiles(shared, sessionMemory);
    // docs/150 §7 — this runs on the first turn, AFTER the container booted, so
    // the entrypoint's boot-time chown can't see these files. Without the
    // handoff the memory dir lands `root:root 0755`: the agent (`shipit`) could
    // read seeded memory but could not WRITE new memory into a root-owned dir,
    // silently breaking the auto-memory feature. Hand the subtree to the worker.
    chownSessionCredentialsTree(credentialsRoot, sessionId);
  } catch (err) {
    console.warn(`[session-credentials] provisionRepoMemory failed for ${sessionId}:`, err);
  }
}

/**
 * Turn-end sync-back (docs/155): copy memory files the Claude CLI wrote during
 * the turn from the session's memory subtree back to the shared per-repo dir.
 * Mirror of {@link syncAgentTokenBack}; last-write-wins per file by mtime. No-op
 * when the session has no memory subtree (Claude never wrote any). Best-effort;
 * never throws.
 */
export function syncMemoryBack(
  credentialsRoot: string,
  sessionId: string,
  repoHash: string,
): void {
  const sessionMemory = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), CLAUDE_MEMORY_REL);
  if (!fs.existsSync(sessionMemory)) return;
  const shared = repoMemoryDir(credentialsRoot, repoHash);
  try {
    fs.mkdirSync(shared, { recursive: true });
    mirrorNewerMemoryFiles(sessionMemory, shared);
  } catch (err) {
    console.warn(`[session-credentials] syncMemoryBack failed for ${sessionId}:`, err);
  }
}
