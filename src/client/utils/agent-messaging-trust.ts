import type { RepoInfo, SessionInfo } from "../../server/shared/types.js";

export function isAgentMessagingBlocked(
  session: Pick<SessionInfo, "kind"> | undefined,
  repoUrl: string | undefined,
  repo: Pick<RepoInfo, "trusted"> | undefined,
): boolean {
  if (session?.kind === "ops" || session?.kind === "sandbox") return false;
  return repoUrl !== undefined && repo?.trusted !== true;
}
