/**
 * docs/287-agent-merge-per-repo — the ONE place a session's pull-request
 * provenance is written.
 *
 * The per-repository merge grant says an agent may merge "its own" pull
 * request, and this module is what makes "its own" mean something. Two rules,
 * and both exist because the alternative hands the agent someone else's work:
 *
 * 1. **Only a witnessed create counts.** A pull request ShipIt merely found on
 *    the branch — by the poller's discovery-by-branch-name, or by a create that
 *    returned one already open — may have been opened by a person, so adopting
 *    it would grant the agent merge rights over their pull request, which
 *    requirement 5 excludes by name. Every create path funnels through here so
 *    that rule is stated once instead of re-derived at four call sites.
 *
 * 2. **The repository must be the session's own.** `agentCreatePr` accepts
 *    `--repo` and passes the retargeted remote through, so a pull request opened
 *    in repository B could otherwise be recorded as this session's number — and
 *    numbers coincide across repositories. The comparison uses the identity the
 *    create ITSELF resolved (a create with no explicit remote reads the clone's
 *    own `origin`), never the URL the caller hoped for.
 *
 * A create that crashes between GitHub accepting it and this call records
 * nothing, and that is the safe answer: the pull request exists and the session
 * simply cannot merge it from the shim. Recovering that case needs evidence an
 * agent cannot write, and a marker in the pull-request body is not one — the
 * agent can edit any pull request's body through the shim.
 */

import type { SessionManager } from "../sessions.js";
import { repoId, repoIdFromOwnerRepo } from "../git-utils.js";

/** The part of a create's result this needs. Both create services return it. */
export interface WitnessedCreate {
  number: number;
  /** False only when THIS call opened the pull request. */
  alreadyExisted: boolean;
  /** The repository GitHub actually created it in. */
  owner: string;
  repo: string;
}

/**
 * Record a pull request this session just opened, if it really opened one in
 * its own repository. Silent and side-effect-free otherwise — every rejection
 * here means "the agent merges from the PR card instead", never an error.
 */
export function recordWitnessedPrCreate(
  sessionManager: SessionManager,
  sessionId: string,
  created: WitnessedCreate,
): void {
  if (created.alreadyExisted) return;
  const identity = repoIdFromOwnerRepo(created.owner, created.repo);
  if (!identity) return;
  const session = sessionManager.get(sessionId);
  if (!session) return;
  if (repoId(session.remoteUrl ?? "") !== identity) return;
  sessionManager.recordPrProvenance(sessionId, created.number, identity);
}
