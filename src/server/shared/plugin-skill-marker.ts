export const PLUGIN_SKILL_PREFIX = "plugins--";
export const PLUGIN_SKILL_MARKER = ".shipit-plugin-skill.json";
export const PLUGIN_SKILL_MARKER_ID = "shipit-plugin-skill-v1";

/** Ownership comes from marker contents, never a directory name or marker presence. */
export function markerClaimsOwnership(contents: string): boolean {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as Record<string, unknown>).marker === PLUGIN_SKILL_MARKER_ID;
  } catch {
    return false;
  }
}

/** Lossy display label only; never use it as an identifier. */
export function pluginSkillLabel(name: string): string | null {
  if (!name.startsWith(PLUGIN_SKILL_PREFIX)) return null;
  const match = /^([a-z0-9-]+)--([a-z0-9-]+)-[0-9a-f]{12}$/.exec(
    name.slice(PLUGIN_SKILL_PREFIX.length),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}
