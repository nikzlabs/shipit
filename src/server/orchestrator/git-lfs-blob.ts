import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGitLfsAvailable } from "./git-lfs.js";
import { killChild } from "../shared/kill-child.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";
import {
  type GitRemoteCredential,
  type GitRemoteCredentialResolver,
  gitCredentialSpawnOverrides,
  resolveTreeRemoteCredential,
  sanitizeGitEnv,
  withPreemptiveAuthFallback,
} from "../shared/git-remote-credential.js";

// Commit blobs remain LFS pointers after checkout. Resolve them for image diffs.
const POINTER_V1_HEADER = "version https://git-lfs.github.com/spec/v1";
const MAX_POINTER_BYTES = 1024;
const SMUDGE_TIMEOUT_MS = 15_000;
const SMUDGE_TIMEOUT_ENV = "SHIPIT_GIT_LFS_DIFF_TIMEOUT_MS";
const DEFAULT_NETWORK_FETCH_BUDGET = 8;
const NETWORK_FETCH_BUDGET_ENV = "SHIPIT_GIT_LFS_DIFF_FETCH_BUDGET";

export interface LfsPointer {
  oid: string;
  size: number;
}

export function parseLfsPointer(content: string | Buffer): LfsPointer | null {
  if (content.length === 0 || content.length > MAX_POINTER_BYTES) return null;
  const text = typeof content === "string" ? content : content.toString("utf-8");
  if (!text.startsWith(POINTER_V1_HEADER)) return null;

  let oid: string | null = null;
  let size: number | null = null;
  for (const line of text.split("\n")) {
    const oidMatch = /^oid sha256:([0-9a-f]{64})$/.exec(line.trim());
    if (oidMatch) oid = oidMatch[1];
    const sizeMatch = /^size (\d+)$/.exec(line.trim());
    if (sizeMatch) size = Number(sizeMatch[1]);
  }
  if (!oid || size === null || !Number.isSafeInteger(size)) return null;
  return { oid, size };
}

export function lfsObjectPath(workspaceDir: string, oid: string): string {
  return path.join(workspaceDir, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
}

function smudgeTimeoutMs(): number {
  const raw = Number(process.env[SMUDGE_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : SMUDGE_TIMEOUT_MS;
}

function networkFetchBudget(): number {
  const raw = Number(process.env[NETWORK_FETCH_BUDGET_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NETWORK_FETCH_BUDGET;
}

function readLocalLfsObject(workspaceDir: string, pointer: LfsPointer): Buffer | null {
  try {
    const buf = fs.readFileSync(lfsObjectPath(workspaceDir, pointer.oid));
    return buf.length === pointer.size ? buf : null;
  } catch {
    return null;
  }
}

function smudgeLfsObject(
  workspaceDir: string,
  pointerText: string,
  filePath: string,
  credential: GitRemoteCredential | null,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      const cred = gitCredentialSpawnOverrides(credential);
      proc = spawn("git", gitArgsWithHooksDisabled([...cred.args, "lfs", "smudge", "--", filePath]), {
        cwd: workspaceDir,
        env: credential
          ? { ...sanitizeGitEnv(process.env), ...cred.env, GIT_TERMINAL_PROMPT: "0" }
          : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "ignore"],
        ...gitSpawnOverridesForTree(workspaceDir),
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    proc.stdout.on("data", (c: Buffer) => {
      chunks.push(c);
      bytes += c.length;
    });
    const timer = setTimeout(() => killChild(proc, "SIGKILL"), smudgeTimeoutMs());
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes === 0) {
        resolve(null);
        return;
      }
      const out = Buffer.concat(chunks);
      // Smudge can echo the pointer on failure; those bytes are not an image.
      resolve(parseLfsPointer(out) ? null : out);
    });
    proc.stdin.on("error", () => {
      /* Early-exit EPIPE is handled by the close listener. */
    });
    proc.stdin.end(pointerText);
  });
}

export type LfsBlobResolver = (
  pointerText: string | Buffer,
  filePath: string,
  maxBytes: number,
) => Promise<Buffer | null>;

export function createLfsBlobResolver(
  workspaceDir: string,
  opts?: {
    isAvailable?: () => Promise<boolean>;
    networkBudget?: number;
    resolveRemoteCredential?: GitRemoteCredentialResolver;
  },
): LfsBlobResolver {
  let remainingFetches = opts?.networkBudget ?? networkFetchBudget();
  let available: Promise<boolean> | null = null;

  return async (pointerText, filePath, maxBytes) => {
    const pointer = parseLfsPointer(pointerText);
    if (!pointer || pointer.size === 0 || pointer.size > maxBytes) return null;

    const local = readLocalLfsObject(workspaceDir, pointer);
    if (local) return local;

    if (remainingFetches <= 0) return null;
    available ??= (opts?.isAvailable ?? isGitLfsAvailable)();
    if (!(await available)) return null;

    // Reserve before awaiting so concurrent requests share the budget.
    remainingFetches--;
    const text = typeof pointerText === "string" ? pointerText : pointerText.toString("utf-8");
    const credential = await resolveTreeRemoteCredential(
      workspaceDir, "origin", opts?.resolveRemoteCredential,
    );
    const fetched = await withPreemptiveAuthFallback(
      credential,
      "LFS smudge",
      (cred) => smudgeLfsObject(workspaceDir, text, filePath, cred),
      (result) => result === null,
    );
    if (!fetched) {
      console.warn(`[git-lfs-blob] Could not fetch LFS content for ${filePath} (oid ${pointer.oid.slice(0, 12)})`);
      return null;
    }
    return fetched;
  };
}
