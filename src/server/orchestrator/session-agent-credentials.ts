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
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import { AGENT_TOKEN_FILES, SUBTREE_STATE_SUBPATHS } from "./token-sync-manager.js";
import {
  AGENT_CREDENTIAL_PATHS,
  SHARED_CREDENTIAL_PATHS,
  chownSessionCredentialsTree,
  copyCredentialPath,
  perSessionCredentialsDir,
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
 * docs/260 §4/§5 — which provider ACCOUNT'S credentials a session's subtree
 * currently holds, per agent. Written by the only provisioning writer above
 * and cleared by revocation, so it is authoritative for the copy on disk —
 * token bytes cannot answer this (the CLI rotates them), and the session row
 * no longer records a route at all.
 *
 * Three readers: the per-turn identity check ({@link
 * ensureSessionAccountCredentials}), post-restart resident-process adoption
 * (the account a surviving CLI runs on IS the marker, since any account
 * change retires the process before reprovisioning), and disconnect
 * revocation ("which sessions hold account X's copy").
 */
const SESSION_ACCOUNT_MARKER = ".shipit-provider-accounts.json";

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
      if ((key === "claude" || key === "codex") && typeof value === "string") out[key] = value;
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
  fs.writeFileSync(path.join(dir, SESSION_ACCOUNT_MARKER), JSON.stringify(current));
}

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
      if (key !== "claude" && key !== "codex") continue;
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
 * docs/260 req 4 — make the session's credential subtree belong to the
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
 * replacement to copy in (docs/150 req 23).
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
 * (docs/150 req 9, and the same data-loss shape docs/153 hit).
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
  provisionAgentCredentialsFromRoot(credentialsRoot, sessionId, subAgentId, sourceRoot, true);
}

/**
 * docs/144 — remove a **sub-agent's** credential subtree from a session's
 * credentials dir after a spawn completes (success, failure, crash, or cancel).
 * Deletes ONLY the sub-agent's paths (`.codex` for a Codex sub-agent, `.claude`
 * + `.claude.json` for a Claude one) — the pinned agent's subtree and the rest
 * of the per-session dir are untouched. Best-effort: the sub-agent CLI may still
 * be flushing writes to its own subtree at the instant we delete it, which is
 * tolerable (the next provision re-copies cleanly from source-of-truth).
 */
export function removeSubAgentCredentials(
  credentialsRoot: string,
  sessionId: string,
  subAgentId: AgentId,
): void {
  const dir = perSessionCredentialsDir(credentialsRoot, sessionId);
  for (const rel of AGENT_CREDENTIAL_PATHS[subAgentId]) {
    try {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    } catch {
      // Best-effort — a leftover is reclaimed by the next provision's
      // replace-existing pass, or the disk-janitor's session sweep.
    }
  }
}
