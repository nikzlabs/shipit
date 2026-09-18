import type { SessionInfo } from "../../shared/types.js";

// Automatic workspace sweeps only; explicit template, PR and plugin commits have separate callers.
const NO_AUTO_COMMIT_KINDS: ReadonlySet<string> = new Set<string>(["ops", "sandbox"]);

export function autoCommitAllowed(
  session: Pick<SessionInfo, "kind"> | undefined | null,
): boolean {
  return !(session?.kind !== undefined && NO_AUTO_COMMIT_KINDS.has(session.kind));
}

export function sessionAutoCommitAllowed(
  sessionManager: { get(id: string): Pick<SessionInfo, "kind"> | undefined },
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return true;
  return autoCommitAllowed(sessionManager.get(sessionId));
}
