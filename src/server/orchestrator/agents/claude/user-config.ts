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
 * Ensure the `.claude.json` at `configPath` carries ShipIt's onboarding + trust
 * defaults, creating the file if it doesn't exist yet.
 *
 * Best-effort and never throws — a missing or unreadable config must not fail a
 * login or a turn. An existing file that fails to parse is left **untouched**:
 * rewriting it would clobber a real (if malformed) user config, and the worst
 * case of skipping is the pre-existing behavior — a trust prompt.
 *
 * Returns true when the file was written.
 */
export function ensureClaudeUserConfigDefaults(configPath: string): boolean {
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

    if (!applyClaudeUserConfigDefaults(config)) return false;

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (err) {
    console.warn(`[claude-config] failed to write ${configPath}:`, err);
    return false;
  }
}
