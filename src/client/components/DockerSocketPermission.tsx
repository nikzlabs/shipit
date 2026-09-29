/**
 * The Docker socket grant (docs/318-compose-remaining-escapes req 8), as the row
 * `project.allowDockerSocket` names. A component for its VALUE, like
 * `AgentPermissions`: one repository's, read and written through the
 * repositories store.
 */

import { useRepoStore } from "../stores/repo-store.js";
import { DeclaredToggle } from "./Settings/declared.js";
import { useProjectRepoUrl } from "./Settings/components/project-repo.js";

export function DockerSocketPermission() {
  const repoUrl = useProjectRepoUrl();
  const allowed = useRepoStore(
    (s) => s.repos.find((r) => r.url === repoUrl)?.allowDockerSocket === true,
  );
  const setAllow = useRepoStore((s) => s.setRepoAllowDockerSocket);

  return (
    <DeclaredToggle
      settingKey="project.allowDockerSocket"
      enabled={allowed}
      onToggle={(next) => { if (repoUrl) void setAllow(repoUrl, next); }}
      testId="allow-docker-socket-toggle"
    />
  );
}
