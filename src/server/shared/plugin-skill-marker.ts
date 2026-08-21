/**
 * docs/262 req 22 — the on-disk identity of a skill ShipIt materialized from a
 * plugin repository, in the one place every side of the boundary can read.
 *
 * `session/plugin-skills.ts` WRITES those directories; two other layers have to
 * RECOGNIZE them, and neither can reach that module. The orchestrator's skill
 * scan cannot import `session/` at all (`eslint.config.js` makes it a hard
 * error), and the client cannot import `node:fs`. So this file holds the
 * constants and the pure predicates only — each side does its own read.
 *
 * Two rules travel with them, and both are load-bearing:
 *
 * **The name is never proof of ownership.** A directory called `plugins--…` may
 * be the user's own, and a marketplace plugin named `plugins--acme` installs as
 * `plugins--acme__<skill>`. Ownership is the marker's CONTENT — checked by
 * {@link markerClaimsOwnership} — which is why deletion and replacement paths
 * ask that question rather than reading a prefix.
 *
 * **A materialized skill is agent-facing, never user-callable** (req 22). It
 * reaches the agent exactly as a project skill does; it does not reach the
 * user's `/` menu, where a hashed namespace name is noise the user cannot act
 * on. {@link pluginSkillLabel} is what renders one when it does appear in the
 * transcript.
 */

/**
 * Prefix of every directory materialization owns. A single namespace, so stale
 * cleanup can identify its own output without a per-directory marker, and one
 * that cannot collide with the marketplace installer's `<plugin>__<skill>`.
 */
export const PLUGIN_SKILL_PREFIX = "plugins--";

/** Written into each materialized skill so nothing else is ever overwritten. */
export const PLUGIN_SKILL_MARKER = ".shipit-plugin-skill.json";

/** Value the marker must carry — presence of the FILE is not proof of ownership. */
export const PLUGIN_SKILL_MARKER_ID = "shipit-plugin-skill-v1";

/**
 * Whether a marker file's contents prove ShipIt materialized the directory it
 * sits in. Malformed JSON, a different id, or anything that is not an object
 * all read as "not ours" — the safe answer, because every caller uses this to
 * decide whether it may delete or hide somebody else's work.
 */
export function markerClaimsOwnership(contents: string): boolean {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as Record<string, unknown>).marker === PLUGIN_SKILL_MARKER_ID;
  } catch {
    return false;
  }
}

/**
 * `plugins--<alias>--<skill>-<hash>` rendered back as `<alias>/<skill>` for
 * display, or `null` when the name is not one this module's writer produced.
 *
 * How the user knows the skill is `<alias>/<skill>` — the same label the plugin
 * card carries. The directory name adds a namespace and a collision hash, which
 * are the right thing on disk and the wrong thing in a transcript row.
 *
 * The rendering is lossy in the same way the name itself is (punctuation runs
 * were collapsed on the way in), so this reverses the *shape*, not the exact
 * spelling. That is fine for a label and no use as an identifier — nothing may
 * key off the result.
 *
 * The hash suffix is required, not optional: it is what separates our own
 * output from a marketplace plugin that merely happens to be called
 * `plugins--acme`. Segments can never contain `--` (the writer collapses every
 * punctuation run to one dash), so the alias/skill split is unambiguous.
 */
export function pluginSkillLabel(name: string): string | null {
  if (!name.startsWith(PLUGIN_SKILL_PREFIX)) return null;
  const match = /^([a-z0-9-]+)--([a-z0-9-]+)-[0-9a-f]{12}$/.exec(
    name.slice(PLUGIN_SKILL_PREFIX.length),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}
