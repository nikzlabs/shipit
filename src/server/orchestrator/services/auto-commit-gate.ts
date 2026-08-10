/**
 * The one place that answers "may ShipIt commit this session's workspace on its
 * own?" — docs/128 (ops) and docs/211 (sandbox).
 *
 * ## The invariant
 *
 * For `kind === "ops"` and `kind === "sandbox"`, **ShipIt performs no automatic
 * commit.** Not at turn end, not on an interrupt, not when a sub-agent consult
 * lands late, not when the user edits a file in the UI, not when the disk
 * janitor is about to evict. Those workspaces are the agent's own: an ops
 * session is a throwaway host-debugging cockpit with no remote and no branch
 * lifecycle, and a sandbox has no root repo at all. Both agents are told, in
 * their system prompt, that they own git themselves — so anything worth keeping
 * is committed deliberately by the agent, and scratch stays scratch.
 *
 * This reverses the docs/128 decision that an ops session "COMMITS (the
 * workspace is a real repo and the history is part of the incident log) but
 * never auto-pushes". **Consequence, stated plainly:** an ops workspace's git
 * history is no longer an incident log. Whatever an investigation wants to keep
 * must be committed by the agent, captured in an issue, or carried into a
 * `--shipit-source` fix session.
 *
 * ## Why a helper and not nine `kind` checks
 *
 * There are nine `git.autoCommit()` call sites in the orchestrator and they do
 * not share a single runtime chokepoint: `GitManager` is built from a *directory*
 * and knows nothing about sessions, and the deliberate commits (template apply)
 * go through the same method as the automatic ones. So the rule lives here once
 * and every automatic path consults it. Editing the set of gated kinds is a
 * one-line change in this file.
 *
 * ## Who consults it
 *
 * | Path | Site |
 * |---|---|
 * | Post-turn commit (and, via it, the post-interrupt fallback) | `ws-handlers/post-turn.ts` |
 * | The turn executor's fallback commit (both `SystemTurnDeps.autoCommit` wirings) | `turn-executor.ts` |
 * | A sub-agent consult finishing after its parent turn | `services/sub-agent-commit.ts` |
 * | A file edited from the ShipIt UI | `api-routes-files.ts` |
 * | Disk eviction (which refuses the whole eviction, not just its commit) | `tier-escalation.ts` |
 *
 * ## Who deliberately does NOT
 *
 * All three are commits ShipIt makes on behalf of an explicit human or agent
 * action, path-scoped or creation-time, never "sweeping up the workspace":
 *
 * - **`services/templates.ts`** — template application is session *creation*,
 *   not a turn. It is what gives an ops workspace its `Initial commit` +
 *   `Apply template: Ops session` history; without it the tree is dirty from the
 *   first second and the agent starts by staring at unstaged template files.
 * - **`services/github.ts` → `flushPendingTurnCommit`** on the `agentCreatePr`
 *   route — that flush is triggered by the agent explicitly running
 *   `gh pr create`, which cannot mean anything without its edits in a commit.
 *   It is a deliberate agent action, not an automatic one. (The *other* caller
 *   of that helper, `sub-agent-commit.ts`, is gated — see above.)
 * - **`services/marketplace.ts` → plugin install** — the user clicked Install.
 *   It commits through `git.commitPaths()` (the files it just wrote, not
 *   `git add -A`), and that commit is what makes the install durable and
 *   legible, exactly like the template baseline. Note it does NOT appear in a
 *   `grep` for `autoCommit`; it is listed here because a census that only
 *   greps that one method is incomplete.
 *
 * ## Known limit, deliberately not gated here
 *
 * `services/rebase-driver.ts` stages and runs `git rebase --continue`, driven by
 * the PR poller's automatic conflict resolution. It reaches neither `autoCommit`
 * nor this gate. It is out of reach for these kinds in practice — it requires an
 * open pull request AND a `session.remoteUrl`, which an ops/sandbox session only
 * acquires when a human adds an `origin` through the UI or the agent explicitly
 * runs `gh pr create`. Both are deliberate acts that opt the session into the PR
 * lifecycle, and finishing a rebase for a PR you asked for is not ShipIt
 * committing behind your back. Named here so the next reader does not have to
 * rediscover it.
 */

import type { SessionInfo } from "../../shared/types.js";

/**
 * Session kinds ShipIt never auto-commits for. Add a kind here and every
 * automatic path picks it up.
 */
const NO_AUTO_COMMIT_KINDS: ReadonlySet<string> = new Set<string>(["ops", "sandbox"]);

/**
 * True when ShipIt may auto-commit this session's workspace. An absent session
 * (unknown id, minimal test setup) is treated as an ordinary one — the gate
 * narrows behavior for two explicit kinds and must never widen into a silent
 * refusal for everything else.
 */
export function autoCommitAllowed(
  session: Pick<SessionInfo, "kind"> | undefined | null,
): boolean {
  return !(session?.kind !== undefined && NO_AUTO_COMMIT_KINDS.has(session.kind));
}

/**
 * {@link autoCommitAllowed} keyed by session id. Structural in `sessionManager`
 * (only `get` is used) so stubs and non-`SessionManager` callers work.
 */
export function sessionAutoCommitAllowed(
  sessionManager: { get(id: string): Pick<SessionInfo, "kind"> | undefined },
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return true;
  return autoCommitAllowed(sessionManager.get(sessionId));
}
