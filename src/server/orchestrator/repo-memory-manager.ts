import fs from "node:fs";
import path from "node:path";
import {
  chownSessionCredentialsTree,
  perSessionCredentialsDir,
} from "./session-credentials-scaffold.js";

export const REPO_MEMORY_SUBDIR = "repo-memory";

// Claude encodes the container's /workspace cwd as -workspace.
const CLAUDE_MEMORY_REL = path.join(".claude", "projects", "-workspace", "memory");

export function repoMemoryDir(credentialsRoot: string, repoHash: string): string {
  return path.join(credentialsRoot, REPO_MEMORY_SUBDIR, repoHash);
}

// Preserve mtime so an unchanged seed does not overwrite shared memory on sync-back.
function copyFilePreservingMtime(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  try {
    const st = fs.statSync(src);
    fs.utimesSync(tmp, st.atime, st.mtime);
  } catch {
    // A failed timestamp copy can cause one redundant sync-back.
  }
  fs.renameSync(tmp, dst);
}

function mirrorNewerMemoryFiles(srcRoot: string, dstRoot: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let copied = 0;
  for (const entry of entries) {
    const src = path.join(srcRoot, entry.name);
    const dst = path.join(dstRoot, entry.name);
    if (entry.isDirectory()) {
      copied += mirrorNewerMemoryFiles(src, dst);
      continue;
    }
    if (!entry.isFile()) continue;
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
    if (dstStat && srcStat.mtimeMs <= dstStat.mtimeMs) continue;
    try {
      copyFilePreservingMtime(src, dst);
      copied += 1;
    } catch (err) {
      console.warn(`[session-credentials] failed to mirror memory file ${src} -> ${dst}:`, err);
    }
  }
  return copied;
}

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
    // These files are created after boot, so the entrypoint's chown cannot cover them.
    chownSessionCredentialsTree(credentialsRoot, sessionId);
  } catch (err) {
    console.warn(`[session-credentials] provisionRepoMemory failed for ${sessionId}:`, err);
  }
}

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
