/**
 * docs/287-agent-merge-per-repo — the ONE place a session's pull-request
 * provenance is written.
 *
 * Two rules, both because the alternative hands the agent someone else's work:
 * **only a witnessed create counts** (a FOUND pull request may be a person's,
 * req 5), and **the repository must be the session's own**, by the identity the
 * create itself resolved. A create that crashes before this records nothing —
 * recovering it would need evidence an agent cannot write, and a marker in the
 * pull-request body is not one.
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
 * Record a pull request this session just opened, if it really opened one in its
 * own repository. Silent otherwise — a rejection means "merge from the card".
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
