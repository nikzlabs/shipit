
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../shared/types/agent-types.js";
import {
  CONTAINER_WORKSPACE_DIR,
  STRANDED_CREDENTIAL_MARKER,
  isStrandedCredentialOf,
} from "../shared/fs-constants.js";
import { PROVIDER_ACCOUNTS_SUBDIR, providerAccountCredentialRoot } from "./provider-account-manager.js";
import { probeNestedString } from "./agents/agent-auth-base.js";
import { readXaiTokenFreshnessFile } from "./agents/grok/auth-manager.js";
import {
  AGENT_CREDENTIAL_PATHS,
  chownSessionCredentialsTree,
  perSessionCredentialsDir,
  readSessionAccountMarker,
  subtreeBorrowInFlight,
  writeSessionAccountMarker,
} from "./session-credentials-scaffold.js";

// Sync tokens only, preserving CLI history/config. New entries need a reader and fixture.
export const AGENT_TOKEN_FILES: Partial<Record<AgentId, readonly string[]>> = {
  claude: [".claude/.credentials.json", ".claude/credentials.json", ".claude/auth.json"],
  codex: [".codex/auth.json"],
  // Grok's adapter must copy back auth.json when the CLI replaces its file symlink.
  grok: [".grok/auth.json"],
};

// Claude resume only finds conversations in the current working directory's bucket.
const CLAUDE_SESSION_PROJECT_DIR = CONTAINER_WORKSPACE_DIR.replaceAll("/", "-");

function atomicCopyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

// Match the refresher's numeric expiry policy; Date.parse also accepts malformed values.
function readClaudeTokenExpiry(file: string): number | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const oauth = o.claudeAiOauth as Record<string, unknown> | undefined;
    const raw = oauth?.expiresAt ?? oauth?.expires_at ?? o.expiresAt ?? o.expires_at;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 10_000_000_000 ? raw * 1000 : raw; // seconds → ms heuristic
    }
  } catch {
    // missing / invalid JSON
  }
  return null;
}

// Check all token aliases: an unreadable expiry alone does not make a credential blank.
export function isBlankedClaudeCredential(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  const oauth = o.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return false;
  return probeNestedString(o, ["accessToken", "access_token"], "claudeAiOauth") === null
    && probeNestedString(o, ["refreshToken", "refresh_token"], "claudeAiOauth") === null;
}

const AGENT_BLANK_CREDENTIAL: Partial<Record<AgentId, (parsed: unknown) => boolean>> = {
  claude: isBlankedClaudeCredential,
};

// Repair blank replicas only; repairing a source can overwrite a concurrent sign-in.
type TokenFileRole = "replica" | "source";

export function readCodexTokenFreshness(file: string): number | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const tokens = (o.tokens && typeof o.tokens === "object" ? o.tokens : {}) as Record<string, unknown>;
    const explicit = o.expires_at ?? o.expiresAt ?? tokens.expires_at ?? tokens.expiresAt;
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
      return explicit < 10_000_000_000 ? explicit * 1000 : explicit; // seconds → ms
    }
    for (const k of ["access_token", "id_token"]) {
      const jwt = tokens[k] ?? o[k];
      if (typeof jwt !== "string") continue;
      const parts = jwt.split(".");
      if (parts.length < 2) continue;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
          return payload.exp * 1000; // JWT exp is seconds
        }
      } catch { /* malformed JWT segment — try the next token */ }
    }
    if (typeof o.last_refresh === "string") {
      const t = Date.parse(o.last_refresh);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    // missing / invalid JSON
  }
  return null;
}

export const TOKEN_FRESHNESS: Partial<Record<AgentId, (file: string) => number | null>> = {
  claude: readClaudeTokenExpiry,
  codex: readCodexTokenFreshness,
  grok: readXaiTokenFreshnessFile,
};

// Unknown freshness does not mean absence: preserve credentials the reader cannot order.
export type TokenFreshnessReading =
  | { kind: "ordered"; at: number }
  | { kind: "unorderable" }
  | { kind: "absent" };

function holdsProtectableCredential(agentId: AgentId, role: TokenFileRole, file: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length === 0) return false;
  if (role === "source") return true;
  return !(AGENT_BLANK_CREDENTIAL[agentId]?.(record) ?? false);
}

function classifyTokenFreshness(
  agentId: AgentId,
  role: TokenFileRole,
  read: (file: string) => number | null,
  file: string,
): TokenFreshnessReading {
  if (!fs.existsSync(file)) return { kind: "absent" };
  const at = read(file);
  if (at !== null) return { kind: "ordered", at };
  return holdsProtectableCredential(agentId, role, file) ? { kind: "unorderable" } : { kind: "absent" };
}

function logUnorderableToken(
  outcome: "refused-copy" | "skipped-copy" | "stranded-rotation" | "refused-publish",
  fields: { sessionId: string; agentId: AgentId; direction: "sync-in" | "sync-back"; file: string },
  prose: string,
): void {
  console.warn(
    `[session-credentials] token-freshness=unorderable outcome=${outcome} session=${fields.sessionId} `
      + `agent=${fields.agentId} direction=${fields.direction} file=${fields.file} — ${prose}`,
  );
}

const UNORDERABLE_HINT =
  "the file parses as a credential but carries no freshness signal this reader recognizes, "
  + "which is what a renamed field or a changed encoding looks like — re-check the reader "
  + "against a REAL captured credential file (docs/266-harness-integration-recipe)";

// null tells the caller to clear the stale CLI resume ID; ShipIt's transcript survives.
export type AgentSessionIdRecoveryCallback = (
  recoveredOrClear: string | null,
) => void;

export interface SyncTokenInOptions {
  // Set false under a live CLI: subtree replacement briefly removes its credentials.
  repairLeakedSubtrees?: boolean;
}

export function syncAgentTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId, opts,
  );
}

export function syncProviderAccountTokenIn(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  syncAgentTokenInFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
    opts,
  );
}

// Leaked absolute symlinks resolve differently under the container's credentials submount.
function containerVisibleCredentialPath(
  credentialsRoot: string,
  sessionDir: string,
  rel: string,
): string {
  const naive = path.join(sessionDir, rel);
  const segments = rel.split("/");
  const subtreeRoot = segments[0];
  const rest = segments.slice(1);
  if (!subtreeRoot || rest.length === 0) return naive;

  let target: string;
  try {
    if (!fs.lstatSync(path.join(sessionDir, subtreeRoot)).isSymbolicLink()) return naive;
    target = fs.readlinkSync(path.join(sessionDir, subtreeRoot));
  } catch {
    return naive;
  }

  let relativeFromVolume: string | null = null;
  if (target.startsWith(CREDENTIALS_MOUNT_PREFIX)) {
    relativeFromVolume = target.slice(CREDENTIALS_MOUNT_PREFIX.length);
  } else if (target.startsWith(`${credentialsRoot}${path.sep}`)) {
    relativeFromVolume = target.slice(credentialsRoot.length + 1);
  }
  if (!relativeFromVolume) return naive;

  return path.join(sessionDir, relativeFromVolume, ...rest);
}

function syncAgentTokenInFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (opts?.repairLeakedSubtrees ?? true) {
    const repair = materializeLeakedSubtreeSymlinks(
      credentialsRoot, sessionDir, agentId, sourceRoot, currentAgentSessionId,
    );
    if (repair.outcome !== "no-action" && onRecoverAgentSessionId) {
      try {
        onRecoverAgentSessionId(
          repair.outcome === "recovered" ? repair.recoveredAgentSessionId : null,
        );
      } catch (err) {
        console.warn("[session-credentials] recovered agent_session_id callback failed:", err);
      }
    }
  }
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = containerVisibleCredentialPath(credentialsRoot, sessionDir, rel);
    const dstReading = classifyTokenFreshness(agentId, "replica", freshness, dst);
    if (dstReading.kind === "unorderable") {
      logUnorderableToken(
        "refused-copy",
        { sessionId, agentId, direction: "sync-in", file: dst },
        `refusing to copy ${src} over the session's own credential: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    if (dstReading.kind === "ordered") {
      const srcReading = classifyTokenFreshness(agentId, "source", freshness, src);
      if (srcReading.kind === "unorderable") {
        logUnorderableToken(
          "skipped-copy",
          { sessionId, agentId, direction: "sync-in", file: src },
          `not pulling the source token into ${sessionId}: ${UNORDERABLE_HINT}`,
        );
        continue;
      }
      if (srcReading.kind !== "ordered" || srcReading.at <= dstReading.at) continue;
    }
    atomicCopyFile(src, dst);
  }
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

// Re-auth bypasses expiry checks: a dead token can have a later expiry than its replacement.
export function repushAgentToken(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot, sessionId, agentId, credentialsRoot,
    onRecoverAgentSessionId, currentAgentSessionId, opts,
  );
}

export function repushProviderAccountToken(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): boolean {
  return repushAgentTokenFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    onRecoverAgentSessionId,
    currentAgentSessionId,
    opts,
  );
}

function repushAgentTokenFromRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
  onRecoverAgentSessionId?: AgentSessionIdRecoveryCallback,
  currentAgentSessionId?: string | null,
  opts?: SyncTokenInOptions,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return false;
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);

  if (opts?.repairLeakedSubtrees ?? true) {
    const repair = materializeLeakedSubtreeSymlinks(
      credentialsRoot, sessionDir, agentId, sourceRoot, currentAgentSessionId,
    );
    if (repair.outcome !== "no-action" && onRecoverAgentSessionId) {
      try {
        onRecoverAgentSessionId(
          repair.outcome === "recovered" ? repair.recoveredAgentSessionId : null,
        );
      } catch (err) {
        console.warn("[session-credentials] recovered agent_session_id callback failed:", err);
      }
    }
  }

  let wrote = false;
  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = containerVisibleCredentialPath(credentialsRoot, sessionDir, rel);
    if (!fs.existsSync(dst)) continue; // don't seed creds into a non-holder
    atomicCopyFile(src, dst);
    wrote = true;
  }
  if (wrote) chownSessionCredentialsTree(credentialsRoot, sessionId);
  return wrote;
}

const CLAUDE_SESSION_STATE_SUBPATHS: readonly string[] = [
  "projects",
  "sessions",
  "history.jsonl",
];

const CODEX_SESSION_STATE_SUBPATHS: readonly string[] = [
  "sessions",
  "archived_sessions",
  "history.jsonl",
];

const GROK_SESSION_STATE_SUBPATHS: readonly string[] = ["sessions"];

// Shared by leak repair and account replacement; keep auth/config out of state merges.
export const SUBTREE_STATE_SUBPATHS: Readonly<Record<string, readonly string[]>> = {
  ".claude": CLAUDE_SESSION_STATE_SUBPATHS,
  ".codex": CODEX_SESSION_STATE_SUBPATHS,
  ".grok": GROK_SESSION_STATE_SUBPATHS,
  ".local/share/opencode": ["shipit-data", "opencode.db", "opencode.db-wal", "opencode.db-shm", "storage", "snapshot"],
};

const CODEX_ROLLOUT_ROOTS: readonly string[] = ["sessions", "archived_sessions"];

const CODEX_ROLLOUT_SCAN_MAX_DEPTH = 5;

const CREDENTIALS_MOUNT_PREFIX = "/credentials/";

type LeakRepairResult =
  | { outcome: "no-action" }
  | { outcome: "recovered"; recoveredAgentSessionId: string }
  | { outcome: "clear" };

function tokenFileNamesForSubtree(rel: string): string[] {
  const names: string[] = [];
  for (const files of Object.values(AGENT_TOKEN_FILES)) {
    for (const file of files ?? []) {
      const parts = file.split("/");
      if (parts.length === 2 && parts[0] === rel) names.push(parts[1]);
    }
  }
  return names;
}

// Orphans can belong to renamed/deleted accounts, not just the current source root.
function discoverOrphanBases(
  credentialsRoot: string,
  sessionDir: string,
  agentId: AgentId,
  sourceRoot: string,
): string[] {
  const sourceRelToCredentials = path.relative(credentialsRoot, sourceRoot);
  const expectedBase =
    sourceRelToCredentials
      && sourceRelToCredentials !== ""
      && !sourceRelToCredentials.startsWith("..")
      && !path.isAbsolute(sourceRelToCredentials)
      ? sourceRelToCredentials
      : null;

  const bases: string[] = expectedBase ? [expectedBase] : [];

  const accountsDir = path.join(sessionDir, PROVIDER_ACCOUNTS_SUBDIR, agentId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return bases;
  }
  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PROVIDER_ACCOUNTS_SUBDIR, agentId, entry.name))
    .sort();
  for (const base of discovered) {
    if (!bases.includes(base)) bases.push(base);
  }
  return bases;
}

function orphanRootFor(sessionDir: string, relBase: string): string | null {
  const firstSegment = relBase.split(path.sep)[0] ?? "";
  if (!firstSegment) return null;
  const root = path.join(sessionDir, firstSegment);
  return root === sessionDir ? null : root;
}

// Any failed merge protects the entire orphan root from deletion.
function mergeOrphans(
  orphans: readonly { path: string; root: string | null }[],
  dst: string,
  rel: string,
  unsafeOrphanRoots: Set<string>,
): OrphanMergeResult {
  const combined: OrphanMergeResult = { preserved: false, failed: false };
  for (const orphan of orphans) {
    if (!fs.existsSync(orphan.path)) continue;
    const merge = mergeOrphanState(orphan.path, dst, rel);
    if (merge.preserved) combined.preserved = true;
    if (merge.failed) {
      combined.failed = true;
      if (orphan.root) unsafeOrphanRoots.add(orphan.root);
    }
  }
  return combined;
}

function materializeLeakedSubtreeSymlinks(
  credentialsRoot: string,
  sessionDir: string,
  agentId: AgentId,
  sourceRoot: string,
  currentAgentSessionId?: string | null,
): LeakRepairResult {
  let aCaseFired = false;
  let recoveredAgentSessionId: string | null = null;
  const orphanRootsToRemove = new Set<string>();
  const unsafeOrphanRoots = new Set<string>();

  const orphanBases = discoverOrphanBases(credentialsRoot, sessionDir, agentId, sourceRoot);

  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    const dst = path.join(sessionDir, rel);
    let dstStat: fs.Stats;
    try {
      dstStat = fs.lstatSync(dst);
    } catch {
      continue;
    }

    const orphans: { path: string; root: string | null }[] = [];
    let isSymlinkLeak = false;

    if (dstStat.isSymbolicLink()) {
      isSymlinkLeak = true;
      const target = fs.readlinkSync(dst);
      let relativeFromVolume: string | null = null;
      if (target.startsWith(CREDENTIALS_MOUNT_PREFIX)) {
        relativeFromVolume = target.slice(CREDENTIALS_MOUNT_PREFIX.length);
      } else if (target.startsWith(`${credentialsRoot}${path.sep}`)) {
        relativeFromVolume = target.slice(credentialsRoot.length + 1);
      }
      if (relativeFromVolume) {
        orphans.push({
          path: path.join(sessionDir, relativeFromVolume),
          root: orphanRootFor(sessionDir, relativeFromVolume),
        });
      }
    } else {
      // A real destination may already contain new CLI state; do not recopy the baseline.
      for (const base of orphanBases) {
        const candidateOrphan = path.join(sessionDir, base, rel);
        if (!fs.existsSync(candidateOrphan)) continue;
        orphans.push({ path: candidateOrphan, root: orphanRootFor(sessionDir, base) });
      }
    }

    for (const orphan of orphans) {
      if (orphan.root) orphanRootsToRemove.add(orphan.root);
    }

    if (!isSymlinkLeak && orphans.length === 0) {
      // Key-billed sessions use environment credentials and can have empty subtrees.
      const tokenNames = tokenFileNamesForSubtree(rel);
      if (
        tokenNames.length > 0
        && sourceRoot !== credentialsRoot
        && dstStat.isDirectory()
        && !tokenNames.some((name) => fs.existsSync(path.join(dst, name)))
      ) {
        console.warn(
          `[session-credentials] ${sessionDir}: ${rel} has no token file (looked for ${tokenNames.join(", ")}) `
            + `and no orphan to recover one from — this session will fail authentication until its credentials `
            + `are reprovisioned (source root ${sourceRoot})`,
        );
      }
      continue;
    }

    // Recover before copying changes the mtimes used to select a conversation.
    if (rel === ".claude" && recoveredAgentSessionId === null) {
      for (const orphan of orphans) {
        if (!fs.existsSync(orphan.path)) continue;
        recoveredAgentSessionId = findLatestAgentSessionId(path.join(orphan.path, "projects"));
        if (recoveredAgentSessionId !== null) break;
      }
    }

    const orphanPathsNote = orphans.map((orphan) => orphan.path).join(", ") || null;

    if (isSymlinkLeak) {
      // Node 24.13.0 needs recursive:true to remove a directory symlink without EISDIR.
      fs.rmSync(dst, { force: true, recursive: true });
      const src = path.join(sourceRoot, rel);
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true, force: true, dereference: true });
      }
      const merge = mergeOrphans(orphans, dst, rel, unsafeOrphanRoots);
      console.log(
        `[session-credentials] repaired leaked symlink in ${sessionDir}: ${rel}${describeMerge(merge, orphanPathsNote)}`,
      );
    } else {
      const merge = mergeOrphans(orphans, dst, rel, unsafeOrphanRoots);
      console.log(
        `[session-credentials] recovered orphaned history in ${sessionDir}: ${rel} (no leaked symlink, but ${orphanPathsNote} present)${describeMerge(merge, orphanPathsNote)}`,
      );
    }

    aCaseFired = true;
  }

  if (
    // eslint-disable-next-line no-restricted-syntax -- Claude conversation file layout
    agentId === "claude"
    && recoveredAgentSessionId === null
    && currentAgentSessionId
  ) {
    const dst = path.join(sessionDir, ".claude");
    let isRealDir = false;
    try {
      const stat = fs.lstatSync(dst);
      isRealDir = !stat.isSymbolicLink() && stat.isDirectory();
    } catch { /* dst doesn't exist — nothing to recover */ }
    if (isRealDir) {
      const projectsRoot = path.join(dst, "projects");
      if (!jsonlExistsForAgentSessionId(projectsRoot, currentAgentSessionId)) {
        aCaseFired = true;
        const latest = findLatestAgentSessionId(projectsRoot);
        if (latest && latest !== currentAgentSessionId) {
          recoveredAgentSessionId = latest;
          console.log(
            `[session-credentials] recovered stale agent_session_id in ${sessionDir}: .claude (DB pointed at ${currentAgentSessionId}, latest on disk is ${latest})`,
          );
        } else {
          console.log(
            `[session-credentials] clearing stale agent_session_id in ${sessionDir}: .claude (DB pointed at ${currentAgentSessionId}, no resumable jsonl on disk)`,
          );
        }
      }
    }
  }

  if (aCaseFired) {
    for (const orphanRoot of orphanRootsToRemove) {
      if (unsafeOrphanRoots.has(orphanRoot)) {
        console.warn(
          `[session-credentials] keeping orphan ${orphanRoot}: its conversation state could not be preserved (it is the only copy)`,
        );
        continue;
      }
      try {
        fs.rmSync(orphanRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[session-credentials] failed to drop orphan ${orphanRoot}:`, err);
      }
    }
  }

  // eslint-disable-next-line no-restricted-syntax -- Codex rollout file layout
  if (agentId === "codex") {
    if (!currentAgentSessionId) return { outcome: "no-action" };
    const dst = path.join(sessionDir, ".codex");
    let isRealDir = false;
    try {
      const stat = fs.lstatSync(dst);
      isRealDir = !stat.isSymbolicLink() && stat.isDirectory();
    } catch { /* no `.codex` yet — nothing to judge */ }
    if (!isRealDir) return { outcome: "no-action" };
    // Check after merging so a restored rollout keeps its resume ID.
    if (codexRolloutState(dst, currentAgentSessionId) !== "absent") {
      return { outcome: "no-action" };
    }
    console.log(
      `[session-credentials] clearing stale agent_session_id in ${sessionDir}: .codex (DB pointed at thread ${currentAgentSessionId}, no rollout on disk)`,
    );
    return { outcome: "clear" };
  }
  // eslint-disable-next-line no-restricted-syntax -- Claude conversation recovery result
  if (agentId !== "claude") return { outcome: "no-action" };
  if (!aCaseFired) return { outcome: "no-action" };
  if (recoveredAgentSessionId !== null) {
    return { outcome: "recovered", recoveredAgentSessionId };
  }
  return { outcome: "clear" };
}

function jsonlExistsForAgentSessionId(projectsRoot: string, agentSessionId: string): boolean {
  const candidate = path.join(
    projectsRoot,
    CLAUDE_SESSION_PROJECT_DIR,
    `${agentSessionId}.jsonl`,
  );
  return fs.existsSync(candidate) && jsonlIsResumableConversation(candidate);
}

interface OrphanMergeResult {
  preserved: boolean;
  failed: boolean;
}

function describeMerge(merge: OrphanMergeResult, orphanPath: string | null): string {
  if (!orphanPath) return "";
  if (merge.failed) {
    return merge.preserved
      ? ` (orphan PARTIALLY merged from ${orphanPath}; kept — some state could not be preserved)`
      : ` (orphan NOT merged from ${orphanPath}; kept — nothing could be preserved)`;
  }
  return merge.preserved
    ? ` (orphan merged from ${orphanPath})`
    : ` (orphan at ${orphanPath} held no conversation state)`;
}

function mergeOrphanState(orphanPath: string, dstPath: string, rel: string): OrphanMergeResult {
  const stateSubpaths = SUBTREE_STATE_SUBPATHS[rel];
  if (stateSubpaths) {
    const result: OrphanMergeResult = { preserved: false, failed: false };
    for (const sub of stateSubpaths) {
      const orphanSub = path.join(orphanPath, sub);
      if (!fs.existsSync(orphanSub)) continue;
      try {
        fs.cpSync(orphanSub, path.join(dstPath, sub), {
          recursive: true,
          force: false,
          errorOnExist: false,
          dereference: true,
          // OpenCode projections are disposable; repair carries state only.
          filter: (source) => rel !== ".local/share/opencode" || !["auth.json", ".shipit-openai-account.json"].includes(path.basename(source)),
        });
        result.preserved = true;
      } catch (err) {
        result.failed = true;
        console.warn(`[session-credentials] failed to merge orphan ${orphanSub}:`, err);
      }
    }
    // The orphan may hold the only token after its account root was deleted.
    for (const name of tokenFileNamesForSubtree(rel)) {
      const orphanToken = path.join(orphanPath, name);
      const dstToken = path.join(dstPath, name);
      if (!fs.existsSync(orphanToken) || fs.existsSync(dstToken)) continue;
      try {
        fs.mkdirSync(path.dirname(dstToken), { recursive: true });
        fs.cpSync(orphanToken, dstToken, { dereference: true });
        result.preserved = true;
        console.log(
          `[session-credentials] restored missing ${rel}/${name} from orphan ${orphanPath}`,
        );
      } catch (err) {
        result.failed = true;
        console.warn(`[session-credentials] failed to restore ${orphanToken}:`, err);
      }
    }
    return result;
  }
  if (rel === ".claude.json") {
    try {
      const orphanContent = fs.readFileSync(orphanPath);
      let dstContent: Buffer | null = null;
      try {
        dstContent = fs.readFileSync(dstPath);
      } catch { /* dst missing — orphan wins by default */ }
      if (!dstContent || !orphanContent.equals(dstContent)) {
        fs.writeFileSync(dstPath, orphanContent);
      }
      return { preserved: true, failed: false };
    } catch (err) {
      console.warn(`[session-credentials] failed to merge orphan .claude.json from ${orphanPath}:`, err);
      return { preserved: false, failed: true };
    }
  }
  console.warn(
    `[session-credentials] no merge strategy for orphan subtree ${rel} at ${orphanPath}; keeping it rather than deleting unknown state`,
  );
  return { preserved: false, failed: true };
}

// An unreadable directory must not clear a live resume ID as if its rollout were absent.
function codexRolloutState(codexHome: string, threadId: string): "found" | "absent" | "unknown" {
  let sawUnreadableDir = false;

  const walk = (dir: string, depth: number): boolean => {
    if (depth > CODEX_ROLLOUT_SCAN_MAX_DEPTH) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") sawUnreadableDir = true;
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (walk(path.join(dir, entry.name), depth + 1)) return true;
      } else if (entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        return true;
      }
    }
    return false;
  };

  for (const root of CODEX_ROLLOUT_ROOTS) {
    if (walk(path.join(codexHome, root), 0)) return "found";
  }
  return sawUnreadableDir ? "unknown" : "absent";
}

const RESUMABLE_JSONL_SCAN_LINES = 50;

// Post-turn metadata stubs can be newer than conversations but cannot be resumed.
function jsonlIsResumableConversation(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (!raw.trim()) return false;
  let hasUser = false;
  let hasAssistant = false;
  const lines = raw.split("\n", RESUMABLE_JSONL_SCAN_LINES);
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: { type?: unknown };
    try {
      parsed = JSON.parse(line) as { type?: unknown };
    } catch {
      continue;
    }
    if (parsed.type === "user") hasUser = true;
    else if (parsed.type === "assistant") hasAssistant = true;
    if (hasUser && hasAssistant) return true;
  }
  return false;
}

function findLatestAgentSessionId(projectsRoot: string): string | null {
  const candidates: { path: string; mtimeMs: number }[] = [];
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(
      path.join(projectsRoot, CLAUDE_SESSION_PROJECT_DIR),
      { withFileTypes: true },
    );
  } catch {
    return null;
  }
  const projectDir = path.join(projectsRoot, CLAUDE_SESSION_PROJECT_DIR);
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const full = path.join(projectDir, file.name);
    try {
      const mtimeMs = fs.statSync(full).mtimeMs;
      candidates.push({ path: full, mtimeMs });
    } catch { /* ignore — race with another writer */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if (!jsonlIsResumableConversation(c.path)) continue;
    try {
      const raw = fs.readFileSync(c.path, "utf8");
      const firstNewline = raw.indexOf("\n");
      const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
      if (!firstLine.trim()) continue;
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      const sid = parsed.sessionId;
      if (typeof sid === "string" && sid.length > 0) return sid;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export function agentTokenFilePaths(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): string[] {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return [];
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  return files.map((rel) => path.join(sessionDir, rel));
}

// Avoid sync-back/chown on non-token writes; sync-back must still repeat the freshness check.
export function sessionTokenIsAheadOfSource(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId?: string,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return false;
  const sourceRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const sessionFile = path.join(sessionDir, rel);
    const sessionReading = classifyTokenFreshness(agentId, "replica", freshness, sessionFile);
    if (sessionReading.kind !== "ordered") continue;
    const sourceFile = path.join(sourceRoot, rel);
    const sourceReading = classifyTokenFreshness(agentId, "source", freshness, sourceFile);
    // Turn-end sync-back reports refusals; this per-file-change probe stays silent.
    if (sourceReading.kind === "unorderable") continue;
    if (sourceReading.kind === "ordered" && sessionReading.at <= sourceReading.at) continue;
    return true;
  }
  return false;
}

export function syncAgentTokenBack(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  opts?: ProviderTokenWriteBackOptions,
): void {
  // Borrow copies precede their markers; block session-route writes for the whole borrow.
  if (opts?.sessionOwnRoute === true && subtreeBorrowInFlight(sessionId, agentId)) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: "flat-root", holder: undefined, reason: "borrow-in-flight" },
      `refusing ${agentId} token write-back for ${sessionId} to the flat root: `
        + `the subtree is lent to a sub-agent`,
    );
    return;
  }
  // Publishing an account token to the flat root also creates a false legacy migration.
  const holder = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (holder !== undefined) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: "flat-root", holder, reason: "subtree-holds-account" },
      `refusing ${agentId} token write-back for ${sessionId} to the flat root: `
        + `the subtree holds account ${holder}`,
    );
    return;
  }
  syncAgentTokenBackToRoot(credentialsRoot, sessionId, agentId, credentialsRoot);
}

export interface ProviderTokenWriteBackOptions {
  // Only the session's resolved turn route can repair a missing account marker.
  sessionOwnRoute?: boolean;
}

function logWriteBackOutcome(
  outcome: "repaired" | "refused",
  fields: { sessionId: string; agentId: AgentId; target: string; holder: string | undefined; reason: string },
  prose: string,
): void {
  console.warn(
    `[session-credentials] write-back=${outcome} session=${fields.sessionId} agent=${fields.agentId} `
      + `target=${fields.target} holder=${fields.holder ?? "none"} reason=${fields.reason} — ${prose}`,
  );
}

export function syncProviderAccountTokenBack(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
  opts?: ProviderTokenWriteBackOptions,
): void {
  // Check ownership before freshness; a newer token may belong to another account.
  if (opts?.sessionOwnRoute === true && subtreeBorrowInFlight(sessionId, agentId)) {
    logWriteBackOutcome(
      "refused",
      { sessionId, agentId, target: `account:${accountId}`, holder: undefined, reason: "borrow-in-flight" },
      `refusing ${agentId} token write-back for ${sessionId} to account ${accountId}: `
        + `the subtree is lent to a sub-agent`,
    );
    return;
  }
  const holder = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (holder !== accountId) {
    const repairable = holder === undefined && opts?.sessionOwnRoute === true;
    if (!repairable) {
      logWriteBackOutcome(
        "refused",
        {
          sessionId, agentId, target: `account:${accountId}`, holder,
          reason: holder === undefined ? "no-recorded-account" : "other-account",
        },
        `refusing ${agentId} token write-back for ${sessionId} to account ${accountId}: `
          + `the subtree holds ${holder ?? "no recorded account"}`,
      );
      return;
    }
    logWriteBackOutcome(
      "repaired",
      { sessionId, agentId, target: `account:${accountId}`, holder, reason: "lost-marker" },
      `repairing lost ${agentId} account marker for ${sessionId}: recording ${accountId} `
        + `(the session's own turn route, no borrow in flight) and publishing its rotation`,
    );
    writeSessionAccountMarker(credentialsRoot, sessionId, agentId, accountId);
  }
  syncAgentTokenBackToRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
  );
}

function syncAgentTokenBackToRoot(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  sourceRoot: string,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const sessionDir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const sessionFile = path.join(sessionDir, rel);
    const sessionReading = classifyTokenFreshness(agentId, "replica", freshness, sessionFile);
    if (sessionReading.kind === "absent") continue;
    if (sessionReading.kind === "unorderable") {
      logUnorderableToken(
        "stranded-rotation",
        { sessionId, agentId, direction: "sync-back", file: sessionFile },
        `not publishing this session's token to ${sourceRoot}: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    const sourceFile = path.join(sourceRoot, rel);
    const sourceReading = classifyTokenFreshness(agentId, "source", freshness, sourceFile);
    if (sourceReading.kind === "unorderable") {
      logUnorderableToken(
        "refused-publish",
        { sessionId, agentId, direction: "sync-back", file: sourceFile },
        `refusing to overwrite the source credential with ${sessionFile}: ${UNORDERABLE_HINT}`,
      );
      continue;
    }
    if (sourceReading.kind === "ordered" && sessionReading.at <= sourceReading.at) continue;
    atomicCopyFile(sessionFile, sourceFile);
  }
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

// Keep quarantined tokens outside provisioned subtrees so new sessions do not inherit them.
const STRANDED_TOKEN_SUBDIR = ".shipit-stranded-tokens";

const STRANDED_TOKEN_KEEP = 5;

// A refused publish can still hold the only live token. Delete only after successful rescue.
function quarantineTokenCopy(targetRoot: string, rel: string, sourceFile: string): boolean {
  const flat = rel.replaceAll("/", "_");
  // UUID suffix prevents same-millisecond releases from overwriting each other's rescue.
  const stamped = isStrandedCredential(flat) ? flat : `${flat}${STRANDED_CREDENTIAL_MARKER}${Date.now()}`;
  const quarantined = path.join(targetRoot, STRANDED_TOKEN_SUBDIR, `${stamped}-${randomUUID().slice(0, 8)}`);
  try {
    atomicCopyFile(sourceFile, quarantined);
    fs.chmodSync(quarantined, 0o600);
    console.warn(`[session-credentials] quarantined unpublishable token at ${quarantined}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[session-credentials] failed to quarantine ${sourceFile} at ${quarantined}: ${reason}`);
    return false;
  }
  pruneStrandedTokens(targetRoot, flat);
  return true;
}

function isStrandedCredential(flat: string): boolean {
  const at = flat.lastIndexOf(STRANDED_CREDENTIAL_MARKER);
  return at >= 0 && isStrandedCredentialOf(flat, flat.slice(0, at));
}

function pruneStrandedTokens(targetRoot: string, flat: string): void {
  const dir = path.join(targetRoot, STRANDED_TOKEN_SUBDIR);
  try {
    const mine = fs.readdirSync(dir).filter((n) => n.startsWith(`${flat}${STRANDED_CREDENTIAL_MARKER}`)).sort();
    for (const stale of mine.slice(0, Math.max(0, mine.length - STRANDED_TOKEN_KEEP))) {
      fs.rmSync(path.join(dir, stale), { force: true });
    }
  } catch {
    // Unreadable directory — leave the pile alone.
  }
}

// Adapter quarantines may be inside the home that cleanup will delete.
function rescueAdapterQuarantines(targetRoot: string, rel: string, copyFile: string): boolean {
  const dir = path.dirname(copyFile);
  const base = path.basename(rel);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return true;
  }
  let allRescued = true;
  for (const entry of entries) {
    if (!isStrandedCredentialOf(entry, base)) continue;
    const found = path.join(dir, entry);
    if (!fs.lstatSync(found, { throwIfNoEntry: false })?.isFile()) continue;
    if (!quarantineTokenCopy(targetRoot, path.join(path.dirname(rel), entry), found)) allRescued = false;
  }
  return allRescued;
}

// Caller must use the provisioning account ID and keep the home if this returns false.
export function syncSubAgentSpawnHomeTokenBack(
  credentialsRoot: string,
  sessionId: string,
  spawnHome: string,
  agentId: AgentId,
  accountId?: string,
): boolean {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return true;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const targetRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  let safeToDelete = true;
  for (const rel of files) {
    const spawnFile = path.join(spawnHome, rel);
    if (!rescueAdapterQuarantines(targetRoot, rel, spawnFile)) safeToDelete = false;
    const spawnReading = classifyTokenFreshness(agentId, "replica", freshness, spawnFile);
    if (spawnReading.kind === "absent") continue;
    const targetFile = path.join(targetRoot, rel);
    if (spawnReading.kind === "unorderable") {
      logUnorderableToken(
        "stranded-rotation",
        { sessionId, agentId, direction: "sync-back", file: spawnFile },
        `not publishing this spawn home's token to ${targetRoot}: ${UNORDERABLE_HINT}`,
      );
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
      continue;
    }
    const targetReading = classifyTokenFreshness(agentId, "source", freshness, targetFile);
    if (targetReading.kind === "unorderable") {
      logUnorderableToken(
        "refused-publish",
        { sessionId, agentId, direction: "sync-back", file: targetFile },
        `refusing to overwrite the source credential with ${spawnFile}: ${UNORDERABLE_HINT}`,
      );
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
      continue;
    }
    if (targetReading.kind === "ordered" && spawnReading.at <= targetReading.at) continue;
    try {
      atomicCopyFile(spawnFile, targetFile);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[session-credentials] failed to publish ${spawnFile} to ${targetFile}: ${reason}`);
      if (!quarantineTokenCopy(targetRoot, rel, spawnFile)) safeToDelete = false;
    }
  }
  return safeToDelete;
}

// Run after publishing. Borrow cleanup must wipe for isolation even if rescue fails.
export function preserveBorrowedTokensBeforeWipe(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId?: string,
): void {
  const files = AGENT_TOKEN_FILES[agentId];
  if (!files) return;
  const freshness = TOKEN_FRESHNESS[agentId] ?? (() => null);
  const targetRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, agentId, accountId)
    : credentialsRoot;
  const borrowRoot = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of files) {
    const borrowedFile = path.join(borrowRoot, rel);
    rescueAdapterQuarantines(targetRoot, rel, borrowedFile);
    const borrowedReading = classifyTokenFreshness(agentId, "replica", freshness, borrowedFile);
    if (borrowedReading.kind === "absent") continue;
    const targetReading = classifyTokenFreshness(agentId, "source", freshness, path.join(targetRoot, rel));
    const superseded = borrowedReading.kind === "ordered"
      && targetReading.kind === "ordered"
      && borrowedReading.at <= targetReading.at;
    if (superseded) continue;
    quarantineTokenCopy(targetRoot, rel, borrowedFile);
  }
}
