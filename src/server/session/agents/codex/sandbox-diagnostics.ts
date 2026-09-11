/**
 * Recognizing the two ways Codex's sandbox goes wrong inside a ShipIt session
 * container, so the session says what happened instead of repeating a kernel
 * message the user cannot act on.
 *
 * The incident: every tool call in a session failed with `bwrap: No permissions
 * to create new namespace…`, the turn settled as errored, and nothing connected
 * those two facts. `CODEX_SANDBOX_ARGS` (adapter.ts) is the fix; this is the
 * part that says so when the fix is overruled, since a requirements policy can
 * veto ShipIt's config at any time with no ShipIt deploy.
 *
 * Both matchers key on wording from the pinned codex-cli 0.153.2 — the
 * bubblewrap text reproduced in a live session container, the veto phrasings
 * read out of the binary's string table. They are deliberately loose about the
 * words in between: the job is to classify, and a missed match costs only the
 * explanation.
 */

/** `bwrap` could not start — the sandbox is fatal rather than restrictive. */
const BUBBLEWRAP_FAILURE = [
  /\bbwrap\b[^\n]{0,80}\bnamespace\b/i,
  /\bbubblewrap is unavailable\b/i,
];

/**
 * A config value ShipIt set was refused by a requirements / managed policy
 * layer. Two phrasings: the verb before "requirements" ("is disallowed by
 * requirements") and after it ("requirements do not allow").
 */
const REQUIREMENT_VETO = [
  /\b(?:disallowed|not allowed|overridden|not permitted)\b[^.\n]{0,40}\brequirements\b/i,
  /\brequirements\b[^.\n]{0,40}\bdo(?:es)? not allow\b/i,
];

/** Whether tool output shows Codex's bubblewrap sandbox failing to start. */
export function isBubblewrapFailure(text: string): boolean {
  return BUBBLEWRAP_FAILURE.some((pattern) => pattern.test(text));
}

/** Whether a `configWarning` reports a requirements layer vetoing our config. */
export function isRequirementVeto(text: string): boolean {
  return REQUIREMENT_VETO.some((pattern) => pattern.test(text));
}

// Named in full because all three are outside ShipIt: the user has to go and
// look, and nothing in the session can do it for them.
const POLICY_SOURCES =
  "$CODEX_HOME/requirements.toml, /etc/codex/requirements.toml, or a managed administrator policy";

/** Said once per process when tool output shows bubblewrap failing. */
export const BUBBLEWRAP_NOTICE =
  "**Codex's sandbox cannot run in this container.** Bubblewrap needs a new user "
  + "namespace, and a ShipIt session container drops `CAP_SYS_ADMIN`, so every "
  + "command Codex sandboxes will fail for the rest of this session. ShipIt spawns "
  + "Codex with `sandbox_mode=\"danger-full-access\"` and "
  + "`features.use_legacy_landlock=true` precisely to avoid this, so a policy "
  + `outside ShipIt is overriding them — check ${POLICY_SOURCES}.`;

/** Said once per process when a `configWarning` reports a veto. */
export function requirementVetoNotice(warning: string): string {
  return (
    `**Codex refused a ShipIt setting.** ${warning} `
    + "ShipIt disables Codex's own sandbox because the session container is the "
    + "sandbox; overruled, Codex falls back to a restricted profile whose "
    + "bubblewrap sandbox cannot start here, and shell commands fail. The veto "
    + `comes from ${POLICY_SOURCES} — all outside ShipIt's control.`
  );
}
