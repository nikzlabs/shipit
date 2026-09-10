import { provisionOpenCodeAccount, revokeOpenCodeAccount } from "./openai-account-delivery.js";
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  ensureClaudeUserConfigDefaults,
  ensureClaudeWorkspaceTrusted,
} from "./agents/claude/user-config.js";
import { CONTAINER_CREDENTIALS_DIR } from "../shared/fs-constants.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import {
  AGENT_TOKEN_FILES,
  SUBTREE_STATE_SUBPATHS,
  preserveBorrowedTokensBeforeWipe,
  syncSubAgentSpawnHomeTokenBack,
} from "./token-sync-manager.js";
import {
  AGENT_CREDENTIAL_PATHS,
  SHARED_CREDENTIAL_PATHS,
  SUB_AGENT_HOME_SUBDIR,
  agentCredentialDirs,
  beginSubtreeBorrow,
  chownSessionCredentialsTree,
  copyCredentialPath,
  endSubtreeBorrow,
  perSessionCredentialsDir,
  readSessionAccountMarker,
  writeSessionAccountMarker,
  writeSessionGitConfig,
} from "./session-credentials-scaffold.js";

export function provisionAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  provisionAgentCredentialsFromRoot(credentialsRoot, sessionId, agentId, credentialsRoot, false);
}

export function provisionProviderAccountCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
): void {
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (agentId === "opencode") {
    provisionOpenCodeAccount(providerAccountCredentialRoot(credentialsRoot, agentId, accountId), perSessionCredentialsDir(credentialsRoot, sessionId), accountId);
    chownSessionCredentialsTree(credentialsRoot, sessionId);
  } else {
    provisionAgentCredentialsFromRoot(
      credentialsRoot,
      sessionId,
      agentId,
      providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
      true,
    );
  }
  writeSessionAccountMarker(credentialsRoot, sessionId, agentId, accountId);
}

export { readSessionAccountMarker, writeSessionAccountMarker };

// Recovery reads the last spawn's route; the account marker describes only files on disk.
const SESSION_RESIDENT_ROUTE = ".shipit-resident-route.json";

export interface RecordedResidentRoute {
  kind: "account" | "reserved" | "string";
  id: string;
}

export function readSessionResidentRoute(
  credentialsRoot: string,
  sessionId: string,
): Partial<Record<AgentId, RecordedResidentRoute>> {
  const file = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SESSION_RESIDENT_ROUTE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<AgentId, RecordedResidentRoute>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key !== "claude" && key !== "codex" && key !== "opencode" && key !== "grok") continue;
      const route = value as { kind?: unknown; id?: unknown };
      if (
        (route?.kind === "account" || route?.kind === "reserved" || route?.kind === "string")
        && typeof route.id === "string"
      ) {
        out[key] = { kind: route.kind, id: route.id };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSessionResidentRoute(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  route: RecordedResidentRoute,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  const current = readSessionResidentRoute(credentialsRoot, sessionId);
  current[agentId] = route;
  fs.writeFileSync(path.join(dir, SESSION_RESIDENT_ROUTE), JSON.stringify(current));
}

export function ensureSessionAccountCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
): "match" | "provisioned" | "adopted" | "replaced" {
  const recorded = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (recorded === accountId) {
    // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
    if (agentId === "opencode") provisionOpenCodeAccount(providerAccountCredentialRoot(credentialsRoot, agentId, accountId), perSessionCredentialsDir(credentialsRoot, sessionId), accountId);
    return "match";
  }
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  const sessionToken = readFirstTokenFile(sessionDir, agentId);
  if (recorded === undefined && sessionToken === null) {
    provisionProviderAccountCredentials(credentialsRoot, sessionId, agentId, accountId);
    return "provisioned";
  }
  if (recorded === undefined && sessionToken !== null) {
    const rootToken = readFirstTokenFile(
      providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
      agentId,
    );
    if (rootToken !== null && sessionToken === rootToken) {
      writeSessionAccountMarker(credentialsRoot, sessionId, agentId, accountId);
      return "adopted";
    }
  }
  provisionProviderAccountCredentials(credentialsRoot, sessionId, agentId, accountId);
  return "replaced";
}

function readFirstTokenFile(root: string, agentId: AgentId): string | null {
  for (const rel of AGENT_TOKEN_FILES[agentId] ?? []) {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      // Try the next token filename.
    }
  }
  return null;
}

export function revokeSessionProviderCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (agentId === "opencode") {
    revokeOpenCodeAccount(perSessionCredentialsDir(credentialsRoot, sessionId));
    writeSessionAccountMarker(credentialsRoot, sessionId, agentId, null);
    return;
  }
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    removeProviderSubtreeForReplacement(dir, rel);
  }
  // A stale marker would skip reprovisioning on the next turn.
  writeSessionAccountMarker(credentialsRoot, sessionId, agentId, null);
}

// Preserve conversation state when replacing credentials, including unknown agent subtrees.
function removeProviderSubtreeForReplacement(sessionDir: string, rel: string): void {
  const target = path.join(sessionDir, rel);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;

  // Remove symlinks themselves, never their targets.
  if (!stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }

  const preserved = SUBTREE_STATE_SUBPATHS[rel];
  if (!preserved) return;

  for (const entry of fs.readdirSync(target)) {
    if (preserved.includes(entry)) continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

const POST_PROVISION_CONFIG: Partial<Record<AgentId, (sessionDir: string) => boolean>> = {
  claude: (sessionDir) => ensureClaudeUserConfigDefaults(path.join(sessionDir, ".claude.json")),
};

export function ensureSessionAgentUserConfig(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  const wrote = POST_PROVISION_CONFIG[agentId]?.(perSessionCredentialsDir(credentialsRoot, sessionId));
  // Files created after container boot still need worker ownership.
  if (wrote) chownSessionCredentialsTree(credentialsRoot, sessionId);
}

// Codex sets project trust in its adapter, for both local and container runtimes.
const LOCAL_WORKSPACE_TRUST: Partial<Record<AgentId, (home: string, workspaceDir: string) => void>> = {
  claude: (home, workspaceDir) => {
    ensureClaudeWorkspaceTrusted(path.join(home, ".claude.json"), workspaceDir);
  },
};

export function ensureLocalWorkspaceTrust(
  home: string,
  agentId: AgentId,
  workspaceDir: string,
): void {
  LOCAL_WORKSPACE_TRUST[agentId]?.(home, workspaceDir);
}

function provisionAgentCredentialsFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  replaceExistingProviderSubtree: boolean,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Shared credentials and Git identity may have changed since the warm scaffold.
  for (const rel of SHARED_CREDENTIAL_PATHS) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
  writeSessionGitConfig(credentialsRoot, sessionId);
  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    if (replaceExistingProviderSubtree) {
      removeProviderSubtreeForReplacement(dir, rel);
    }
    copyCredentialPath(sourceRoot, dir, rel);
  }
  // Create symlink targets even for key-only agents, before handing ownership to the worker.
  for (const rel of agentCredentialDirs(agentId)) {
    try {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
    } catch (err) {
      console.warn(`[session-credentials] could not materialize ${rel} for ${agentId}:`, err);
    }
  }
  POST_PROVISION_CONFIG[agentId]?.(dir);
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

export function provisionSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
  accountId?: string,
): void {
  const sourceRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, subAgentId, accountId)
    : credentialsRoot;
  // Record the borrow before copying so concurrent token write-back cannot misattribute it.
  beginSubtreeBorrow(credentialsRoot, sessionId, subAgentId);
  provisionAgentCredentialsFromRoot(credentialsRoot, sessionId, subAgentId, sourceRoot, true);
  writeSessionAccountMarker(credentialsRoot, sessionId, subAgentId, accountId ?? null);
}

export function releaseSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
): string | undefined {
  // Preserve rotations while the marker and borrow ledger still identify their owner.
  preserveBorrowedTokens(
    credentialsRoot,
    sessionId,
    subAgentId,
    readSessionAccountMarker(credentialsRoot, sessionId)[subAgentId],
  );
  removeSubAgentCredentials(credentialsRoot, sessionId, subAgentId);
  return endSubtreeBorrow(sessionId, subAgentId);
}

function preserveBorrowedTokens(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
  accountId: string | undefined,
): void {
  try {
    preserveBorrowedTokensBeforeWipe(credentialsRoot, sessionId, subAgentId, accountId);
  } catch (err) {
    console.warn(`[session-credentials] borrow preservation failed for ${subAgentId}:`, err);
  }
}

// Revocation and failover wipe credentials without ending the borrow or saving revoked tokens.
export function removeSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of AGENT_CREDENTIAL_PATHS[subAgentId]) {
    try {
      removeProviderSubtreeForReplacement(dir, rel);
    } catch {
      // Retry cleanup on the next provision.
    }
  }
  writeSessionAccountMarker(credentialsRoot, sessionId, subAgentId, null);
}

export function subAgentSpawnHomeDir(
  credentialsRoot: string,
  sessionId: string,
  spawnId: string,
): string {
  return path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SUB_AGENT_HOME_SUBDIR, spawnId);
}

export function subAgentSpawnHomeContainerDir(spawnId: string): string {
  return path.posix.join(CONTAINER_CREDENTIALS_DIR, SUB_AGENT_HOME_SUBDIR, spawnId);
}

// Token write-back uses this record, since the caller's selected account may have changed.
const SPAWN_HOME_PROVENANCE = ".shipit-spawn-home.json";

interface SpawnHomeProvenance {
  agentId: AgentId;
  accountId: string | null;
}

function readSpawnHomeProvenance(home: string): SpawnHomeProvenance | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, SPAWN_HOME_PROVENANCE), "utf8"),
    ) as { agentId?: unknown; accountId?: unknown };
    if (typeof parsed?.agentId !== "string" || !Object.hasOwn(AGENT_CREDENTIAL_PATHS, parsed.agentId)) {
      return null;
    }
    return {
      agentId: parsed.agentId as AgentId,
      accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
    };
  } catch {
    return null;
  }
}

// Same-harness background runs need separate homes so they cannot replace the live agent's tokens.
export function provisionSubAgentSpawnHome(
  credentialsRoot: string,
  sessionId: string,
  spawnId: string,
  subAgentId: AgentId,
  accountId?: string,
): void {
  const sourceRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, subAgentId, accountId)
    : credentialsRoot;
  const home = subAgentSpawnHomeDir(credentialsRoot, sessionId, spawnId);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  for (const rel of subAgentId === "opencode" && accountId ? [] : AGENT_CREDENTIAL_PATHS[subAgentId]) {
    copyCredentialPath(sourceRoot, home, rel);
  }
  // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
  if (subAgentId === "opencode" && accountId) provisionOpenCodeAccount(sourceRoot, home, accountId);
  // Record provenance only after copying; partial copies must never be published.
  fs.writeFileSync(
    path.join(home, SPAWN_HOME_PROVENANCE),
    JSON.stringify({ agentId: subAgentId, accountId: accountId ?? null }),
  );
  for (const rel of agentCredentialDirs(subAgentId)) {
    try {
      fs.mkdirSync(path.join(home, rel), { recursive: true });
    } catch (err) {
      console.warn(`[session-credentials] could not materialize ${rel} in spawn home for ${subAgentId}:`, err);
    }
  }
  POST_PROVISION_CONFIG[subAgentId]?.(home);
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

export function releaseSubAgentSpawnHome(
  credentialsRoot: string,
  sessionId: string,
  spawnId: string,
): void {
  releaseSpawnHomeAt(credentialsRoot, sessionId, subAgentSpawnHomeDir(credentialsRoot, sessionId, spawnId));
}

function releaseSpawnHomeAt(credentialsRoot: string, sessionId: string, home: string): void {
  revokeOpenCodeAccount(home);
  const provenance = readSpawnHomeProvenance(home);
  let safeToDelete = true;
  if (provenance) {
    try {
      safeToDelete = syncSubAgentSpawnHomeTokenBack(
        credentialsRoot,
        sessionId,
        home,
        provenance.agentId,
        provenance.accountId ?? undefined,
      );
    } catch (err) {
      console.warn(
        `[session-credentials] spawn-home token sync-back failed for ${provenance.agentId}:`, err,
      );
      safeToDelete = false;
    }
  }
  // Retain the only copy of a rotated token if publication and quarantine both failed.
  if (!safeToDelete) {
    console.warn(
      `[session-credentials] KEEPING spawn home ${home}: a rotation in it is neither published nor `
      + "quarantined, and deleting it now would be the only copy. Retried at the next container create.",
    );
    return;
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // Retry at the next container create.
  }
}

// Run before the new container has a worker; no spawn can still own these homes.
export function sweepSubAgentSpawnHomes(credentialsRoot: string, sessionId: string): void {
  const dir = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SUB_AGENT_HOME_SUBDIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    releaseSpawnHomeAt(credentialsRoot, sessionId, path.join(dir, entry));
  }
  try {
    // Never recursively remove homes retained to protect unpublished tokens.
    fs.rmdirSync(dir);
  } catch {
    // Retained homes or an already removed directory are expected.
  }
}
