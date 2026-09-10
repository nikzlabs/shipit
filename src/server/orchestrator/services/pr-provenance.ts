import type { SessionManager } from "../sessions.js";
import { repoId, repoIdFromOwnerRepo } from "../git-utils.js";

export interface WitnessedCreate {
  number: number;
  alreadyExisted: boolean;
  owner: string;
  repo: string;
}

// Only witnessed creation in the session's own repository grants agent merge authority.
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
