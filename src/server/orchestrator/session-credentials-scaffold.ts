import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import { GLOBAL_CREDENTIAL_FILENAME, writeContainerGitConfig } from "./git-config.js";
import { chownTreeToSessionWorker, sealDirMode } from "./session-worker-uid.js";

export const SESSION_CREDENTIALS_SUBDIR = "sessions";

// Separate spawn homes keep a consult from replacing the live primary CLI's credentials.
export const SUB_AGENT_HOME_SUBDIR = "sub-agent-homes";

// Link token directories, not token files: refresh renames must not replace the link.
export const AGENT_CREDENTIAL_PATHS: Record<AgentId, readonly string[]> = {
  claude: [".claude", ".claude.json"],
  codex: [".codex"],
  opencode: [".local/share/opencode"],
  grok: [".grok"],
};

// JSON files cannot be scaffolded as empty directories.
const AGENT_CREDENTIAL_FILES: ReadonlySet<string> = new Set([".claude.json"]);

// Even key-billed agents need these directories as targets for the image's home symlinks.
export function agentCredentialDirs(agentId: AgentId): readonly string[] {
  return AGENT_CREDENTIAL_PATHS[agentId].filter((rel) => !AGENT_CREDENTIAL_FILES.has(rel));
}

// Never copy the orchestrator's .gitconfig: it can contain a token-bearing helper.
export const SHARED_CREDENTIAL_PATHS: readonly string[] = [];

export function writeSessionGitConfig(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  writeContainerGitConfig(path.join(dir, ".gitconfig"));
}

export function perSessionCredentialsDir(credentialsRoot: string, sessionId: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR, sessionId);
}

export function perSessionCredentialsRoot(credentialsRoot: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR);
}

// Every orchestrator-side credential writer must hand new files back to the worker.
export function chownSessionCredentialsTree(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  chownTreeToSessionWorker(dir);
  sealDirMode(dir);
}

// Token write-back uses this account identity; rotating token bytes cannot identify it.
const SESSION_ACCOUNT_MARKER = ".shipit-provider-accounts.json";

function isAgentId(key: string): key is AgentId {
  return Object.hasOwn(AGENT_CREDENTIAL_PATHS, key);
}

export function readSessionAccountMarker(
  credentialsRoot: string,
  sessionId: string,
): Partial<Record<AgentId, string>> {
  const file = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SESSION_ACCOUNT_MARKER);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<AgentId, string>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAgentId(key) && typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSessionAccountMarker(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string | null,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  const current = readSessionAccountMarker(credentialsRoot, sessionId);
  if (accountId === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by the AgentId union, not arbitrary input
    delete current[agentId];
  } else {
    current[agentId] = accountId;
  }
  // Atomic replacement prevents a partial read from discarding a token rotation.
  const file = path.join(dir, SESSION_ACCOUNT_MARKER);
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(current));
  fs.renameSync(tmp, file);
}

// Preserve the displaced account and distinguish a borrowed legacy route from a lost marker.
const outstandingBorrows = new Map<string, string | undefined>();

const borrowKey = (sessionId: string, agentId: AgentId): string => `${sessionId}:${agentId}`;

// Repeated borrows retain the first displaced account, not the borrowed account.
export function beginSubtreeBorrow(credentialsRoot: string, sessionId: string, agentId: AgentId): void {
  const key = borrowKey(sessionId, agentId);
  if (outstandingBorrows.has(key)) return;
  outstandingBorrows.set(key, readSessionAccountMarker(credentialsRoot, sessionId)[agentId]);
}

export function endSubtreeBorrow(sessionId: string, agentId: AgentId): string | undefined {
  const key = borrowKey(sessionId, agentId);
  const displaced = outstandingBorrows.get(key);
  outstandingBorrows.delete(key);
  return displaced;
}

export function subtreeBorrowInFlight(sessionId: string, agentId: AgentId): boolean {
  return outstandingBorrows.has(borrowKey(sessionId, agentId));
}

/** Test cleanup only. */
export function clearSubtreeBorrows(): void {
  outstandingBorrows.clear();
}

export function perSessionCredentialsSubpath(sessionId: string): string {
  return path.posix.join(SESSION_CREDENTIALS_SUBDIR, sessionId);
}

// Only the leaf is checked; credential paths must have real parent directories.
function materializeCredentialDestination(dest: string): void {
  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink()) return;
  let target = "?";
  try {
    target = fs.readlinkSync(dest);
  } catch {
    // Unreadable link — still remove it.
  }
  fs.rmSync(dest, { recursive: true, force: true });
  console.warn(
    `[session-credentials] removed symlink at credential destination ${dest} -> ${target}; `
      + `materializing a real path instead. Any state under the old target is recovered by the `
      + `per-turn orphan repair (docs/153).`,
  );
}

export function copyCredentialPath(srcRoot: string, destRoot: string, rel: string): void {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return;
  const dest = path.join(destRoot, rel);
  materializeCredentialDestination(dest);
  // Absolute source links would resolve to different files inside the session's subpath mount.
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: true });
}

export function ensureSessionCredentialsScaffold(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of SHARED_CREDENTIAL_PATHS) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
  writeSessionGitConfig(credentialsRoot, sessionId);
  // Remove stale credentials left by an orchestrator-shaped writer inside the sandbox.
  fs.rmSync(path.join(dir, GLOBAL_CREDENTIAL_FILENAME), { force: true });
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

export function removeSessionCredentials(credentialsRoot: string, sessionId: string): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — the next disk-janitor pass will retry.
  }
}

export function sessionCredentialsRoot(credentialsRoot: string): string {
  return path.join(credentialsRoot, SESSION_CREDENTIALS_SUBDIR);
}
