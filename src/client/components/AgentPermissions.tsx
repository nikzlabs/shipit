import { GitMergeIcon } from "@phosphor-icons/react";
import { useRepoStore } from "../stores/repo-store.js";
import { ICON_SIZE } from "../design-tokens.js";

/**
 * docs/287 — per-repository agent permissions, in the Project Settings dialog.
 *
 * Currently one grant: may an agent merge the pull request its own session
 * opened? It lives here rather than in a tab of its own because a single toggle
 * does not justify a navigation category, and it is deliberately NOT declarable
 * in `shipit.yaml` — the agent can write that file, so a permission stated there
 * would be one it could grant itself.
 */
export function AgentPermissions({ repoUrl }: { repoUrl: string }) {
  const repo = useRepoStore((s) => s.repos.find((r) => r.url === repoUrl));
  const setAllow = useRepoStore((s) => s.setRepoAllowAgentMerge);
  const allowed = repo?.allowAgentMerge === true;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-(--color-text-primary)">Agent permissions</h3>
        <p className="text-xs text-(--color-text-secondary)">
          What agents working in this repository may do on their own.
        </p>
      </div>

      <div className="flex gap-3 p-3 rounded-lg border border-(--color-border-secondary)">
        <span className="w-8 h-8 rounded-lg bg-(--color-bg-tertiary) text-(--color-text-secondary) flex items-center justify-center shrink-0">
          <GitMergeIcon size={ICON_SIZE.SM} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-(--color-text-primary)">
            Allow agents to merge their own pull requests
          </div>
          <p className="text-xs text-(--color-text-secondary) mt-0.5">
            An agent may merge only the pull request its own session opened, and only when
            every check has passed. Branch protection and required reviews are still
            enforced by GitHub. Off for every repository until you turn it on.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowed}
          aria-label="Allow agents to merge their own pull requests"
          data-testid="allow-agent-merge-toggle"
          onClick={() => void setAllow(repoUrl, !allowed)}
          className={`relative w-9.5 h-5.5 rounded-full shrink-0 mt-0.5 transition-colors border ${
            allowed
              ? "bg-(--color-accent) border-(--color-accent)"
              : "bg-(--color-bg-tertiary) border-(--color-border-secondary)"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left] ${
              allowed ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
