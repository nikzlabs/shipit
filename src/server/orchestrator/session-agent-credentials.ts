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
import { providerAccountCredentialRoot } from "./provider-account-manager.js";
import { SUBTREE_STATE_SUBPATHS } from "./token-sync-manager.js";
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
