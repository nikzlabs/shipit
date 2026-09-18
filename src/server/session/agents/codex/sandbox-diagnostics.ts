/**
 * Recognizing the two ways Codex's sandbox goes wrong inside a ShipIt session
 * container, so the session says what happened instead of repeating a kernel
 * message the user cannot act on.
 *
 * The incident: every tool call in a session failed with `bwrap: No permissions
 * to create new namespace…`, the turn settled as errored, and nothing connected
 * those two facts. `CODEX_SANDBOX_ARGS` (adapter.ts) is the fix; this is the
 * part that says so when the fix is overruled, since a managed policy can veto
 * ShipIt's config at any time with no ShipIt deploy.
 *
 * **Both matchers run against text the agent itself produced, in a repo whose
 * own source discusses this failure.** So they are narrow on purpose: the
 * bubblewrap one wants the binary's actual output shape (a line that BEGINS
 * `bwrap:`, carrying a failure phrase), not a mention of the words, and the
 * veto one wants a veto of a setting ShipIt actually sets, not any veto at all.
 * A false positive costs a permanent, wrong diagnosis on a healthy session and
 * burns the once-per-process notice; a missed match costs only the explanation.
 *
 * Wording comes from the pinned codex-cli 0.153.2 — the bubblewrap text
 * reproduced in a live session container, the veto phrasings read out of the
 * binary's string table.
 */

/**
 * `bwrap` could not start — the sandbox is fatal rather than restrictive.
 * Anchored to the start of a line because that is how the helper prints it,
 * which is also what keeps quoted occurrences in source and test files out.
 */
const BUBBLEWRAP_FAILURE = [
  /^[ \t]*bwrap:[^\n]*\b(?:No permissions|not allowed|Operation not permitted|namespace)\b/im,
  /^[ \t]*bubblewrap is unavailable\b/im,
];

/**
 * A managed policy refused a config value. Two phrasings: the verb before
 * "requirements" ("is disallowed by requirements") and after it ("requirements
 * do not allow").
 */
const REQUIREMENT_VETO = [
  /\b(?:disallowed|not allowed|overridden|not permitted)\b[^.\n]{0,40}\brequirements\b/i,
  /\brequirements\b[^.\n]{0,40}\bdo(?:es)? not allow\b/i,
];

/**
 * The settings `CODEX_SANDBOX_ARGS` sets. A veto of `web_search_mode` is a
 * veto, but it says nothing about the sandbox and must not raise a sandbox
 * alarm.
 */
const SANDBOX_SETTING = /\b(?:sandbox_mode|approval_policy|permission_profile|landlock|sandbox)\b/i;

/** Whether output from a FAILED tool call shows bubblewrap failing to start. */
export function isBubblewrapFailure(text: string): boolean {
  return BUBBLEWRAP_FAILURE.some((pattern) => pattern.test(text));
}

/** Whether a `configWarning` reports a policy vetoing one of our sandbox settings. */
export function isSandboxVeto(text: string): boolean {
  return SANDBOX_SETTING.test(text) && REQUIREMENT_VETO.some((pattern) => pattern.test(text));
}

/**
 * Where a veto can come from. `$CODEX_HOME/requirements.toml` is deliberately
 * NOT listed: measured against 0.153.2, a requirements file at that path is
 * ignored outright — invalid TOML there raises no error and changes nothing —
 * so naming it would send the user to edit a file that does nothing.
 */
const POLICY_SOURCES = "/etc/codex/requirements.toml, or an enterprise-managed Codex policy";

/**
 * Said once per process when a FAILED tool call shows bubblewrap failing.
 *
 * States the mechanism and stops. It does not name a culprit: this evidence
 * proves the sandbox ran and could not start, not *why* ShipIt's settings did
 * not prevent it.
 */
export const BUBBLEWRAP_NOTICE =
  "**Codex's sandbox could not start in this container.** Bubblewrap needs a new "
  + "user namespace, and a ShipIt session container drops `CAP_SYS_ADMIN`, so any "
  + "command Codex sandboxes fails this way. ShipIt spawns Codex with "
  + "`sandbox_mode=\"danger-full-access\"` and `features.use_legacy_landlock=true` "
  + "precisely so no bubblewrap sandbox is used — seeing this means something "
  + `overrode them, most likely a policy from ${POLICY_SOURCES}.`;

/**
 * Said once per process when a `configWarning` vetoes a sandbox setting.
 *
 * Reports the refusal and leaves it there. It deliberately does NOT predict
 * that commands will fail: `features.use_legacy_landlock` exists to make the
 * fallback sandbox one that works without capabilities, and whether a given
 * policy leaves that route open is not knowable from the warning.
 */
export function sandboxVetoNotice(warning: string): string {
  return (
    `**Codex refused a ShipIt sandbox setting.** ${warning} `
    + "ShipIt disables Codex's own sandbox because the session container is the "
    + "sandbox. Overruled, Codex applies its own profile instead; if its "
    + "bubblewrap backend is what ends up running, no command can succeed here. "
    + `The veto comes from ${POLICY_SOURCES} — outside ShipIt's control.`
  );
}
