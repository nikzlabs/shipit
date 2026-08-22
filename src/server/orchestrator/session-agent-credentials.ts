/**
 * Per-agent / provider-account credential provisioning (docs/138, docs/144).
 *
 * Copies the pinned agent's credential subtree into a session's per-session
 * credentials dir on its first turn, and provisions/removes a sub-agent's
 * subtree on a cross-provider `shipit agent run` spawn. The per-session dir
 * scaffold (dir creation, shared config, gitconfig, worker-UID handoff) lives in
 * `session-credentials-scaffold.ts`; this module layers the agent-specific
 * subtree on top of it.
 *
 * Pure filesystem in/out — no Docker, no DB.
 */

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

/**
 * Provision the **pinned agent's** credential subtree into a session's
 * credentials dir. Called exactly once, on the session's first turn, after the
 * agent is fixed. Copies only `agentId`'s files (plus a fresh `.gitconfig`) —
 * the other agent's credentials never land in this session's container.
 *
 * Because the per-session dir is already mounted into the (possibly already
 * running) container, writing here makes the credentials visible immediately;
 * no container remount is needed. This mirrors how env-based platform
 * credentials are injected, one layer down (files, not env).
 */
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
  provisionAgentCredentialsFromRoot(
    credentialsRoot,
    sessionId,
    agentId,
    providerAccountCredentialRoot(credentialsRoot, agentId, accountId),
    true,
  );
  writeSessionAccountMarker(credentialsRoot, sessionId, agentId, accountId);
}

/**
 * docs/260 §4/§5 — the subtree's recorded account. Defined in
 * `session-credentials-scaffold.ts` (the token sync has to read it without
 * importing this module) and re-exported here, where its readers have always
 * found it: the per-turn identity check ({@link
 * ensureSessionAccountCredentials}), post-restart resident-process adoption
 * (the account a surviving CLI runs on IS the marker, since any account change
 * retires the process before reprovisioning), and disconnect revocation ("which
 * sessions hold account X's copy").
 */
export { readSessionAccountMarker, writeSessionAccountMarker };

/**
 * docs/260 §5 — the credential route the session's LAST SPAWNED resident
 * process runs on, per agent. The account marker above cannot carry this: it
 * records which account's SUBTREE COPY is on disk (revocation depends on that
 * meaning), while a string-delivered credential authenticates from spawn env
 * and leaves the subtree — and therefore the marker — untouched. Without this
 * record a post-restart adoption cannot attribute a surviving string-credential
 * process (req 11), and the busy deletion guard cannot see that the credential
 * is in use (req 13).
 *
 * Written at the pre-spawn stamp (the same moment `runner.residentRoute` is
 * set) and read ONLY by adoption recovery — a stale file with no surviving
 * process is never consulted, so retirement does not need to clear it.
 */
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

/**
 * docs/260-turn-level-account-routing req 4 — make the session's credential subtree belong to the
 * CHOSEN account before the turn spawns, whatever it held before.
 *
 *   - `match`: the marker already names the chosen account; the per-turn
 *     freshness sync (which is same-account by construction now) does the
 *     rest.
 *   - `provisioned`: the subtree had no credentials for this agent yet.
 *   - `adopted`: a pre-260 subtree with no marker whose token byte-matches
 *     the chosen account's root — recorded, nothing copied.
 *   - `replaced`: the subtree held a different account's credentials (the
 *     wrong-account poisoning class), or an unidentifiable pre-260 copy.
 *     Reprovisioned wholesale from the chosen account's root; conversation
 *     state survives via the replacement allowlist.
 */
export function ensureSessionAccountCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
  accountId: string,
): "match" | "provisioned" | "adopted" | "replaced" {
  const recorded = readSessionAccountMarker(credentialsRoot, sessionId)[agentId];
  if (recorded === accountId) return "match";
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
      // Missing candidate — try the next filename this agent has used.
    }
  }
  return null;
}

/**
 * Take a session's copy of a provider account's credentials away, with no
 * replacement to copy in (docs/150-multiple-provider-subscriptions req 23).
 *
 * Disconnecting the account only removes the *source* subtree under
 * `provider-accounts/<provider>/<accountId>/`. Every session pinned to that
 * account already holds its own copy of the OAuth token — that copy is what the
 * CLI in the container actually reads — and nothing else deletes it: the
 * account-switch path overwrites it (`provisionProviderAccountCredentials` with
 * `replace = true`), and first-turn provisioning is guarded on
 * `session.agentPinned` so it never runs again. Without this, "disconnected"
 * sessions kept a working subscription token on disk indefinitely.
 *
 * Deliberately the removal half of a replacement and nothing more: it preserves
 * the conversation-state subpaths (see
 * {@link removeProviderSubtreeForReplacement}), so reconnecting an account
 * resumes the same conversation rather than starting a new one. No chown — this
 * only deletes.
 */
export function revokeSessionProviderCredentials(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  if (!fs.existsSync(dir)) return;
  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    removeProviderSubtreeForReplacement(dir, rel);
  }
  // docs/260 — the subtree no longer holds any account's credentials for this
  // agent; a stale marker would make the next turn's identity check skip the
  // reprovision it needs.
  writeSessionAccountMarker(credentialsRoot, sessionId, agentId, null);
}

/**
 * Clear a session's existing provider subtree so a *different* account's
 * subtree can be copied over it — **without** deleting the agent's
 * conversation state.
 *
 * `cpSync({ force: true })` already overwrites every file both subtrees have;
 * the removal exists only for files the outgoing account left that the
 * incoming one does not produce (a cached `.claude/settings.json`, a stale
 * per-account state file). Doing that as a blanket `rmSync(rel)` also takes
 * `projects/`, `sessions/`, `archived_sessions/`, and `history.jsonl` — the
 * files Claude's `--resume` and Codex's `thread/resume` read. Those are
 * per-session and carry no account identity, so an account switch does not
 * invalidate them; deleting them is what would strand the user mid-conversation
 * (docs/150-multiple-provider-subscriptions req 9, and the same data-loss shape docs/153 hit).
 *
 * Three cases, mirroring the allowlist's own fail-safe contract:
 *
 *   - Path is a **file** (`.claude.json`): no conversation state to lose,
 *     remove it.
 *   - Path is a **directory with an allowlist entry** (`.claude`, `.codex`):
 *     remove every top-level entry *except* the allowlisted ones.
 *   - Path is a **directory with no allowlist entry** (a future agent's
 *     subtree): remove nothing and let the copy overwrite in place. Leaking a
 *     stale file is recoverable; deleting an unknown agent's conversation is
 *     not. This is the same "absent from the map ⇒ unpreservable ⇒ don't
 *     delete" default {@link SUBTREE_STATE_SUBPATHS} documents for the leak
 *     repair.
 */
function removeProviderSubtreeForReplacement(sessionDir: string, rel: string): void {
  const target = path.join(sessionDir, rel);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;

  // A symlink at `rel` is the docs/153 leak shape, not a real subtree — drop
  // the link itself (never follow it) and let the copy write a real dir.
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

/**
 * Per-agent normalization applied to a session's credential subtree after the
 * source files have been copied in.
 *
 * A runtime table rather than an `agentId === "claude"` branch (docs/155): a new
 * backend that needs its own post-copy config fixup adds a row here.
 *
 * Claude's entry writes the CLI's onboarding + workspace-trust defaults into the
 * session's own `.claude.json`. Without it the container starts *untrusted* and
 * the CLI silently drops the workspace's `.claude/settings.json`
 * `permissions.allow` entries ("Ignoring N permissions.allow entries … this
 * workspace has not been trusted"), so users get permission prompts for tools
 * they explicitly allowlisted. The orchestrator-side equivalent runs only inside
 * the login flow (`AuthManager.ensureOnboardingComplete`) and only on the
 * orchestrator's own config, which is a different file from the one the
 * container reads — hence writing it here, on the path every session takes
 * regardless of when or how the account logged in.
 */
const POST_PROVISION_CONFIG: Partial<Record<AgentId, (sessionDir: string) => boolean>> = {
  claude: (sessionDir) => ensureClaudeUserConfigDefaults(path.join(sessionDir, ".claude.json")),
};

/**
 * Apply {@link POST_PROVISION_CONFIG} for `agentId` to a session's credentials
 * dir. Idempotent, merge-only, and safe to call on every turn — the underlying
 * writer only touches the file when a key is actually missing.
 *
 * Called both from provisioning (so a freshly-provisioned session container is
 * correct from its first turn) and from per-turn env prep (so sessions
 * provisioned *before* this existed are healed on their next turn instead of
 * staying untrusted forever — provisioning runs once per session and never
 * again).
 */
export function ensureSessionAgentUserConfig(
  credentialsRoot: string,
  sessionId: string,
  agentId: AgentId,
): void {
  const wrote = POST_PROVISION_CONFIG[agentId]?.(perSessionCredentialsDir(credentialsRoot, sessionId));
  // Only when the file was actually (re)written — a newly created config is
  // `root:root` and the container's boot-time chown has long since run
  // (docs/150 §7). Skipping the walk on the common no-op keeps this cheap
  // enough to run every turn.
  if (wrote) chownSessionCredentialsTree(credentialsRoot, sessionId);
}

/**
 * Per-agent workspace trust for `RUNTIME_MODE=local`, keyed by the directory
 * the agent CLI actually runs in.
 *
 * A runtime table rather than an `agentId === "claude"` branch (docs/155), for
 * the same reason {@link POST_PROVISION_CONFIG} is one. Only Claude has a row:
 * its CLI gates a workspace's own `.claude/settings.json` `permissions.allow`
 * entries on per-directory trust. Codex has a comparable
 * `projects.<path>.trust_level` in `config.toml`, but ShipIt spawns it with an
 * explicit `approvalPolicy: "never"`, so nothing is silently dropped there and
 * it needs no row.
 */
const LOCAL_WORKSPACE_TRUST: Partial<Record<AgentId, (home: string, workspaceDir: string) => void>> = {
  claude: (home, workspaceDir) => {
    ensureClaudeWorkspaceTrusted(path.join(home, ".claude.json"), workspaceDir);
  },
};

/**
 * Trust `workspaceDir` in the config the local-mode `agentId` CLI reads under
 * `home`. Idempotent and safe to call on every turn; a no-op for an agent with
 * no row in {@link LOCAL_WORKSPACE_TRUST}.
 *
 * Local mode only — the caller (`session-agent-env.ts`) gates on
 * `isLocalRuntime()`, and containerized sessions are covered by
 * {@link ensureSessionAgentUserConfig} writing `CLAUDE_PRE_TRUSTED_DIRS` into
 * their own per-session config instead.
 */
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
  // Refresh shared config first (token may have been set after the warm
  // container's scaffold ran), then the agent subtree.
  for (const rel of SHARED_CREDENTIAL_PATHS) {
    copyCredentialPath(credentialsRoot, dir, rel);
  }
  // Regenerate the token-free gitconfig — identity may have been set after the
  // warm container's scaffold ran (e.g. GitHub connected mid-session).
  writeSessionGitConfig(credentialsRoot, sessionId);
  for (const rel of AGENT_CREDENTIAL_PATHS[agentId]) {
    if (replaceExistingProviderSubtree) {
      removeProviderSubtreeForReplacement(dir, rel);
    }
    copyCredentialPath(sourceRoot, dir, rel);
  }
  // planning#444 — and materialize whatever the copy did not, so the image's
  // `~/.<agent>` symlink resolves even for a key-billed harness with no
  // credential material on disk. See `agentCredentialDirs` for why a dangling
  // link is a startup failure rather than a harmless absence.
  //
  // Per path rather than around the loop: one unwritable entry must not cost the
  // others, and it must never skip the chown below — the whole subtree has just
  // been rewritten and the container's boot-time chown has long since run.
  //
  // **This loop MUST stay above `chownSessionCredentialsTree`.** It creates the
  // directories as the orchestrator (root), so a chown that ran first would
  // leave them root-owned inside a subtree sealed 0700 to the session's uid —
  // unreadable to the very CLI they exist for, and the failure would look
  // exactly like the dangling link this replaces.
  for (const rel of agentCredentialDirs(agentId)) {
    try {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
    } catch (err) {
      console.warn(`[session-credentials] could not materialize ${rel} for ${agentId}:`, err);
    }
  }
  // Normalize the copied config (e.g. Claude's onboarding + workspace trust)
  // before the chown, so the file it may create is handed over too.
  POST_PROVISION_CONFIG[agentId]?.(dir);
  // Hand the freshly-written subtree to the unprivileged worker user (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

/**
 * docs/144 — provision a **sub-agent's** credential subtree into a session's
 * credentials dir, on a cross-provider `shipit agent run` spawn. Mirrors
 * {@link provisionProviderAccountCredentials} but is named for the sub-agent
 * lifecycle: lazy (only on a spawn), scoped (only the sub-agent's subtree, never
 * the pinned agent's), account-correct (copies from the resolved provider-account
 * root, not the flat root — the flat root holds stale legacy-alias symlinks for a
 * multi-account user), and reversible ({@link removeSubAgentCredentials}).
 *
 * The copy is placed in the **same** per-session dir that already holds the
 * pinned agent's subtree — the container's `~/.codex` (or `~/.claude`)
 * symlink resolves into it immediately, so the sub-agent CLI finds its creds
 * with no remount. `replaceExistingProviderSubtree` is always true so a stale
 * leftover (e.g. from a crashed prior spawn whose wipe didn't complete) is
 * cleared before the fresh copy.
 *
 * `accountId` is the resolved provider-account id (`selectRouteForTurn(subAgentId)`
 * → `{ kind: "account", id }`); pass `undefined` for the legacy no-account
 * fallback (env-token / api-key routes), which copies from the flat root.
 *
 * **The marker moves with the copy**, and that is the point: a SAME-harness
 * consult borrows the very subtree the session's own turn reads from, for an
 * account chosen independently of the session's (`balanced` routing routinely
 * hands background work the other account). While the borrow is in place the
 * session's token file holds the borrowed account's bearer — so a marker still
 * naming the session's account is a false statement, and the two write-back
 * paths that trust it (the turn-end sync-back and the mid-turn publisher, both
 * still pointed at the session's account) would publish one account's
 * credential into another account's root. That is the duplicate-bearer state
 * `quarantineDuplicateClaudeCredentials` cleans up after, and it presents to
 * the user as a connected account silently becoming a different one.
 *
 * So the borrow states what is on disk, `syncProviderAccountTokenBack` refuses
 * any write the marker does not agree with, and the restore in each caller's
 * `finally` puts the session's own account back. A crash mid-borrow now leaves
 * a marker that DISAGREES with the session's route, which makes the next turn's
 * `ensureSessionAccountCredentials` reprovision — where a stale "match" used to
 * let the session spawn on the borrowed account's token.
 *
 * **The account it displaces is captured HERE**, into the borrow ledger, rather
 * than by each caller reading the marker some lines earlier (planning#445). The
 * displaced account is what {@link releaseSubAgentCredentials} hands back for
 * the restore, and a capture that reads `undefined` loses it — leaving the
 * session with no marker at all and every later write-back refused, which for a
 * rotating refresh token is not a delay but the permanent death of the source
 * credential. Two things made a caller-side read return `undefined` on a
 * session that plainly had an account: a torn read of the then non-atomic
 * marker write, and a second borrow starting inside the window where the first
 * had already cleared it. Capturing at the instant of overwrite closes the
 * first; the ledger's re-entrancy closes the second.
 */
export function provisionSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
  accountId?: string,
): void {
  const sourceRoot = accountId
    ? providerAccountCredentialRoot(credentialsRoot, subAgentId, accountId)
    : credentialsRoot;
  // Before the copy, not just before the marker write: the copy is what makes
  // the subtree the borrower's, and the ledger entry is what tells a concurrent
  // write-back that an absent marker means "borrowed", not "lost".
  beginSubtreeBorrow(credentialsRoot, sessionId, subAgentId);
  provisionAgentCredentialsFromRoot(credentialsRoot, sessionId, subAgentId, sourceRoot, true);
  writeSessionAccountMarker(credentialsRoot, sessionId, subAgentId, accountId ?? null);
}

/**
 * Close a borrow: wipe the borrowed credentials ({@link
 * removeSubAgentCredentials}) and report the account the borrow displaced, so
 * the caller can put the session back on its own credentials.
 *
 * This is the call every borrow's `finally` makes. The bare wipe is still
 * exported for the two callers that are not ending a borrow — an account
 * failover, which wipes and immediately re-borrows, and the sign-out sweep,
 * which wipes another session's subtree it never borrowed — and neither may
 * clear the ledger entry the in-flight borrow still needs.
 *
 * Ordering is load-bearing: the wipe runs while the ledger entry is still in
 * place, so a write-back racing the wipe sees "a borrow is in flight" rather
 * than an absent marker it might repair.
 */
export function releaseSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
): string | undefined {
  removeSubAgentCredentials(credentialsRoot, sessionId, subAgentId);
  return endSubtreeBorrow(sessionId, subAgentId);
}

/**
 * docs/144 — close a temporary sub-agent credential window after a spawn
 * completes (success, failure, crash, or cancel). Removes authentication and
 * config material from only that agent's paths, while preserving the
 * conversation-state allowlist used by account replacement. This distinction
 * is load-bearing for a same-harness reviewer: its temporary route borrows the
 * parent's `.codex` / `.claude` subtree, and deleting the whole directory would
 * delete the rollout that the parent must resume after the reviewer finishes.
 *
 * All cleanup callers use this boundary, including quota failover, sign-out,
 * reviewer/non-turn completion, and their failure/cancellation paths. A
 * cross-provider temporary subtree can therefore leave non-secret conversation
 * state behind, but never temporary authentication or config. Best-effort: the
 * sub-agent CLI may still be flushing writes at the instant we clean it; the
 * next provision runs the same replacement cleanup before copying credentials.
 *
 * The marker is cleared with the credentials, because it describes them: a
 * marker outliving the copy it names would tell a write-back it may publish a
 * token that is no longer there, and tell revocation to hunt a copy that is
 * already gone. Callers that restore the session's own account afterwards write
 * it back as part of reprovisioning.
 *
 * A caller ENDING a borrow wants {@link releaseSubAgentCredentials} instead —
 * this one deliberately leaves the borrow ledger alone, for the failover that
 * wipes and re-borrows in the same window.
 */
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
      // Best-effort — a leftover is reclaimed by the next provision's
      // replace-existing pass, or the disk-janitor's session sweep.
    }
  }
  writeSessionAccountMarker(credentialsRoot, sessionId, subAgentId, null);
}

/**
 * Host path of the isolated per-spawn HOME a same-harness sub-agent run gets.
 * Inside the per-session subtree, so the container mount, the tree chown/seal,
 * and session removal all cover it with no extra plumbing.
 */
export function subAgentSpawnHomeDir(
  credentialsRoot: string,
  sessionId: string,
  spawnId: string,
): string {
  return path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SUB_AGENT_HOME_SUBDIR, spawnId);
}

/**
 * The same directory as seen from INSIDE the session container, where the
 * per-session subtree is mounted at {@link CONTAINER_CREDENTIALS_DIR}. This is
 * the value the spawn request carries as `homeDir` for the worker to hand the
 * sub-agent CLI as its HOME.
 */
export function subAgentSpawnHomeContainerDir(spawnId: string): string {
  return path.posix.join(CONTAINER_CREDENTIALS_DIR, SUB_AGENT_HOME_SUBDIR, spawnId);
}

/**
 * The spawn home's own record of WHAT was provisioned into it: the harness and
 * the account (null ⇒ the flat root). Written by
 * {@link provisionSubAgentSpawnHome} AFTER the copy completes — a home without
 * the file holds unproven (possibly partial) content and is never published.
 *
 * This file, not a caller argument, is what the release and the orphan sweep
 * sync back from. Two failure shapes forced that: a suppressed removal failure
 * can leave an OLD account's copy in the home while the failover loop has
 * already moved `accountId` on (a caller-supplied id would then publish the
 * failed account's token into the fallback account's root — the
 * duplicate-bearer class), and an orchestrator restart orphans homes whose
 * caller — the only party that knew the pairing — is gone.
 */
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
    // hasOwn against the credential-path record, the one enumeration the
    // compiler keeps complete (planning#443's lesson on the marker reader).
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

/**
 * Provision a SAME-harness sub-agent spawn's credentials into an isolated
 * per-spawn home instead of the session's own subtree.
 *
 * The session-subtree borrow ({@link provisionSubAgentCredentials}) assumed the
 * primary was blocked waiting for the consult, but docs/236 made backgrounded
 * consults the recommended shape — the primary keeps making API calls while the
 * spawn runs. A same-harness provision then swaps the very credential file the
 * LIVE primary CLI re-reads: a cross-provider route (a z.ai flat key into
 * `.claude/`) 401s it within seconds, the quiet auth retry kills the turn and
 * cancels every in-flight spawn, and the re-dispatched turn repeats the same
 * consults — a loop (2026-08-21 incident, host session 53cf9934). A
 * same-provider borrow of another account was quieter but still wrong: the
 * primary silently ran mid-turn on the borrowed account's bearer.
 *
 * So a same-harness spawn never touches the session subtree at all. Its copy
 * lands under {@link subAgentSpawnHomeDir} — same source-root rule as the
 * borrow (the resolved provider-account root, else the flat root), same
 * post-copy config normalization, same worker-uid handoff via the whole-tree
 * chown — and the spawned CLI is pointed at it via the run's `homeDir`. No
 * marker write and no borrow-ledger entry: the session's marker keeps naming
 * the session's own account throughout, so the primary's own token write-backs
 * flow normally during the consult instead of being refused for the borrow.
 *
 * Idempotent per `spawnId`: an account failover re-provisions the same home
 * after {@link releaseSubAgentSpawnHome} cleared it.
 */
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
  // A fresh root per attempt: clear any leftover from a prior attempt of this
  // same spawn (account failover re-provisions under the same spawnId).
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  for (const rel of AGENT_CREDENTIAL_PATHS[subAgentId]) {
    copyCredentialPath(sourceRoot, home, rel);
  }
  // AFTER the copy, deliberately: the provenance file is the release's licence
  // to publish, so a copy that threw halfway leaves a home with no file — and
  // partial content that is never synced anywhere. See SPAWN_HOME_PROVENANCE.
  fs.writeFileSync(
    path.join(home, SPAWN_HOME_PROVENANCE),
    JSON.stringify({ agentId: subAgentId, accountId: accountId ?? null }),
  );
  // Same planning#444 materialization as the session-subtree provision: a
  // key-billed harness has no credential material on disk, and its CLI must
  // still find (or be able to create) its config root under the new HOME.
  // Above the chown for the same reason spelled out there.
  for (const rel of agentCredentialDirs(subAgentId)) {
    try {
      fs.mkdirSync(path.join(home, rel), { recursive: true });
    } catch (err) {
      console.warn(`[session-credentials] could not materialize ${rel} in spawn home for ${subAgentId}:`, err);
    }
  }
  // Normalize the copied config (Claude's onboarding + trust defaults) so the
  // one-shot CLI starts clean in its fresh home.
  POST_PROVISION_CONFIG[subAgentId]?.(home);
  // The home sits inside the per-session subtree, so the whole-tree handoff
  // covers it (docs/150).
  chownSessionCredentialsTree(credentialsRoot, sessionId);
}

/**
 * Close a spawn home: publish any rotation the sub-agent CLI performed back to
 * the root the home's OWN provenance names (freshness-gated — see
 * {@link syncSubAgentSpawnHomeTokenBack}), then delete the home.
 *
 * The write-back target comes from the {@link SPAWN_HOME_PROVENANCE} file, not
 * from the caller: the caller's idea of the account can have moved on (the
 * failover loop re-points `accountId` between attempts) while a suppressed
 * removal failure left the PREVIOUS account's copy in the home — a
 * caller-supplied target would then publish one account's token into another
 * account's root. A home with no provenance (a torn provision) is deleted
 * without publishing anything.
 *
 * Best-effort on both halves: a failed sync-back costs at worst a slightly
 * older token on the next provision, and a failed removal is reclaimed —
 * rotation included, thanks to the provenance — by the container-create
 * {@link sweepSubAgentSpawnHomes}.
 */
export function releaseSubAgentSpawnHome(
  credentialsRoot: string,
  sessionId: string,
  spawnId: string,
): void {
  releaseSpawnHomeAt(credentialsRoot, sessionId, subAgentSpawnHomeDir(credentialsRoot, sessionId, spawnId));
}

function releaseSpawnHomeAt(credentialsRoot: string, sessionId: string, home: string): void {
  const provenance = readSpawnHomeProvenance(home);
  if (provenance) {
    try {
      syncSubAgentSpawnHomeTokenBack(
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
    }
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // Best-effort — swept at the next container create.
  }
}

/**
 * Container-create sweep of spawn homes a crashed or restarted orchestrator
 * left behind. Runs when no spawn of this session can be in flight (a fresh
 * container has no worker yet), so every dir here belongs to a run whose
 * `finally` never executed — including a run that survived a graceful
 * orchestrator restart and finished with nobody left to release it.
 *
 * Each home is RELEASED, not just deleted: a rotation the consult's CLI
 * performed is published to the provenance-named root first (freshness-gated),
 * because with rotating refresh tokens a deleted rotation is not lost work but
 * the permanent death of the source credential (planning#445's arithmetic,
 * one directory over).
 */
export function sweepSubAgentSpawnHomes(credentialsRoot: string, sessionId: string): void {
  const dir = path.join(perSessionCredentialsDir(credentialsRoot, sessionId), SUB_AGENT_HOME_SUBDIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // No homes — the common case.
  }
  for (const entry of entries) {
    releaseSpawnHomeAt(credentialsRoot, sessionId, path.join(dir, entry));
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — retried at the next container create.
  }
}
