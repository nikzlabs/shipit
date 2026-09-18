import fs from "node:fs";
import path from "node:path";

export const CLAUDE_PRE_TRUSTED_DIRS = ["/app", "/workspace"] as const;

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

export function ensureClaudeUserConfigDefaults(configPath: string): boolean {
  return updateClaudeUserConfig(configPath, applyClaudeUserConfigDefaults);
}

/** Claude 2.1.219 keys trust by enclosing git root, or cwd outside a repo. */
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
