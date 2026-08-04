/**
 * Claude CLI user-config (`.claude.json`) defaults — onboarding + workspace trust.
 *
 * The CLI refuses to apply a workspace's own `.claude/settings.json`
 * `permissions.allow` entries until the directory has been trusted:
 *
 *   Ignoring 2 permissions.allow entries from .claude/settings.json: this
 *   workspace has not been trusted. Run Claude Code interactively here once
 *   and accept the trust dialog, or set
 *   projects["/workspace"].hasTrustDialogAccepted: true in ~/.claude.json.
 *
 * Two *different* config files need those defaults and are written by two
 * unrelated code paths:
 *
 *   - The orchestrator's own config (`/root/.claude.json`, or a provider-account
 *     root under docs/150), written during the login flow by `AuthManager` so
 *     `claude /login` skips the onboarding wizard and the trust prompt.
 *   - Each **session container's** config, which is a per-session copy under
 *     `<credentialsDir>/sessions/<id>/.claude.json` mounted as
 *     `/home/shipit/.claude.json`. Nothing in the login flow touches it, so
 *     before this module every session container started untrusted and silently
 *     dropped the workspace's allowlisted permissions.
 *
 * Both paths go through the helpers here so the trust/onboarding keys can't
 * drift apart. Everything is merge-only and idempotent: unrelated keys in an
 * existing (possibly user-authored) config are preserved, and a file that
 * already carries the defaults is not rewritten.
 *
 * A third case, `RUNTIME_MODE=local` (the dogfood inner orchestrator), needs a
 * *different* key rather than the same defaults: there is no container, so the
 * agent's cwd is `<dataDir>/sessions/<id>/workspace` rather than `/workspace`,
 * and trust is keyed by exact directory — an ancestor grants nothing. See
 * {@link ensureClaudeWorkspaceTrusted}.
 *
 * See: https://github.com/anthropics/claude-code/issues/4714
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Directories pre-trusted in every Claude user config ShipIt writes.
 *
 * `/app` is the orchestrator container's WORKDIR (where the server runs) and
 * `/workspace` is the data volume — the directory the agent is actually started
 * in inside a session container.
 */
export const CLAUDE_PRE_TRUSTED_DIRS = ["/app", "/workspace"] as const;

/**
 * Apply ShipIt's Claude user-config defaults to an already-parsed config
 * object, in place. Returns whether anything changed, so callers can skip the
 * write on a config that is already correct.
 *
 * Merge-only by construction: it sets `hasCompletedOnboarding` and spreads each
 * pre-trusted dir's existing entry rather than replacing `projects` wholesale,
 * so per-project state the CLI keeps there (history, mcp servers, …) survives.
 */
export function applyClaudeUserConfigDefaults(config: Record<string, unknown>): boolean {
  let changed = false;

  if (!config.hasCompletedOnboarding) {
    config.hasCompletedOnboarding = true;
    changed = true;
  }

  const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
  for (const dir of CLAUDE_PRE_TRUSTED_DIRS) {
    if (!projects[dir]?.hasTrustDialogAccepted) {
      projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
      changed = true;
    }
  }
  if (changed) config.projects = projects;

  return changed;
}

/**
 * Read `configPath`, hand the parsed object to `mutate`, and write it back if
 * `mutate` reports a change.
 *
 * Best-effort and never throws — a missing or unreadable config must not fail a
 * login or a turn. An existing file that fails to parse is left **untouched**:
 * rewriting it would clobber a real (if malformed) user config, and the worst
 * case of skipping is the pre-existing behavior — a trust prompt.
 *
 * Returns true when the file was written.
 */
function updateClaudeUserConfig(
  configPath: string,
  mutate: (config: Record<string, unknown>) => boolean,
): boolean {
  try {
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        console.warn(`[claude-config] ${configPath} is not valid JSON — leaving it alone:`, err);
        return false;
      }
    }

    if (!mutate(config)) return false;

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.warn(`[claude-config] failed to write ${configPath}:`, err);
    return false;
  }
}

/**
 * Ensure the `.claude.json` at `configPath` carries ShipIt's onboarding + trust
 * defaults, creating the file if it doesn't exist yet.
 *
 * Returns true when the file was written.
 */
export function ensureClaudeUserConfigDefaults(configPath: string): boolean {
  return updateClaudeUserConfig(configPath, applyClaudeUserConfigDefaults);
}

/**
 * The key the Claude CLI indexes a directory's trust state under.
 *
 * The CLI normalizes the agent's cwd to its **enclosing git repository root**
 * before looking it up in `projects`, falling back to the resolved path when
 * the directory is not inside a repo. Verified against the shipped CLI (2.1.219):
 * started in `<repo>/sub/deep`, its own warning names `projects["<repo>"]`.
 *
 * Resolved by walking up for a `.git` entry rather than by shelling out to
 * `git rev-parse` — this runs on every local-mode turn, and a `.git` *file*
 * (a linked worktree) marks a root just as a directory does.
 */
export function claudeTrustKey(dir: string): string {
  const start = path.resolve(dir);
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * Sibling session-workspace trust keys in `keys` whose directory is gone.
 *
 * `key` is a local session's workspace (`<dataDir>/sessions/<id>/workspace`),
 * so its siblings are the same-named leaf under the same grandparent —
 * `<dataDir>/sessions/<other>/workspace`. Only entries matching that exact shape
 * **and** missing from disk are returned, so a real per-project entry the CLI
 * keeps for a directory that still exists is never touched.
 *
 * Self-guards against a shallow key: `/workspace` has no grandparent to scope
 * the match to, so it matches nothing.
 */
function staleSiblingWorkspaceKeys(keys: readonly string[], key: string): string[] {
  const grandparent = path.dirname(path.dirname(key));
  if (grandparent === path.dirname(grandparent)) return [];
  const leaf = path.basename(key);
  return keys.filter((candidate) =>
    candidate !== key
    && path.basename(candidate) === leaf
    && path.dirname(path.dirname(candidate)) === grandparent
    && !fs.existsSync(candidate),
  );
}

/**
 * Trust `workspaceDir` in the Claude user config at `configPath` — the
 * `RUNTIME_MODE=local` counterpart to {@link CLAUDE_PRE_TRUSTED_DIRS}.
 *
 * Deliberately narrower than {@link applyClaudeUserConfigDefaults}: it writes
 * the one trust key and nothing else, so `CLAUDE_PRE_TRUSTED_DIRS` keeps
 * meaning exactly what it means for a container (where the agent's cwd *is*
 * `/workspace`) and the containerized posture is untouched.
 *
 * Growth is bounded by pruning sibling workspaces that no longer exist, which
 * caps the file at the set of live local sessions. That matters because in
 * local mode this config is the account root's, shared by every session on the
 * account *and* the source containerized sessions are provisioned from — see
 * the caller in `session-agent-env.ts` for why per-directory keys are
 * nonetheless the only available mechanism.
 *
 * Returns true when the file was written.
 */
export function ensureClaudeWorkspaceTrusted(configPath: string, workspaceDir: string): boolean {
  return updateClaudeUserConfig(configPath, (config) => {
    const key = claudeTrustKey(workspaceDir);
    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    let changed = false;

    if (!projects[key]?.hasTrustDialogAccepted) {
      projects[key] = { ...projects[key], hasTrustDialogAccepted: true };
      changed = true;
    }

    const stale = new Set(staleSiblingWorkspaceKeys(Object.keys(projects), key));
    if (stale.size > 0) changed = true;

    if (changed) {
      config.projects = Object.fromEntries(
        Object.entries(projects).filter(([candidate]) => !stale.has(candidate)),
      );
    }
    return changed;
  });
}
