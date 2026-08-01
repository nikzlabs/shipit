import type { RepoInfo, SessionInfo } from "../../server/shared/types.js";

/** Client UX mirror of the server-owned repository messaging admission rule. */
export function isAgentMessagingBlocked(
  session: Pick<SessionInfo, "kind"> | undefined,
  repoUrl: string | undefined,
  repo: Pick<RepoInfo, "trusted"> | undefined,
): boolean {
  if (session?.kind === "ops" || session?.kind === "sandbox") return false;
  return repoUrl !== undefined && repo?.trusted !== true;
}
