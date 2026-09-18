/**
 * The agent-merge grant (docs/287), as the row `project.allowAgentMerge` names.
 *
 * It renders the same toggle every generated boolean does — this is a component
 * for its VALUE, not its looks: one repository's, so it is read and written
 * through the repositories store, which already carries the optimistic write,
 * the rollback and the reconcile docs/287 asked for.
 */

import { useRepoStore } from "../stores/repo-store.js";
import { DeclaredToggle } from "./Settings/declared.js";
import { useProjectRepoUrl } from "./Settings/components/project-repo.js";

export function AgentPermissions() {
  const repoUrl = useProjectRepoUrl();
  const allowed = useRepoStore(
    (s) => s.repos.find((r) => r.url === repoUrl)?.allowAgentMerge === true,
  );
  const setAllow = useRepoStore((s) => s.setRepoAllowAgentMerge);

  return (
    <DeclaredToggle
      settingKey="project.allowAgentMerge"
      enabled={allowed}
      onToggle={(next) => { if (repoUrl) void setAllow(repoUrl, next); }}
      testId="allow-agent-merge-toggle"
    />
  );
}
