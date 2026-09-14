import { GitMergeIcon } from "@phosphor-icons/react";
import { useRepoStore } from "../stores/repo-store.js";
import { ICON_SIZE } from "../design-tokens.js";
import { bindSetting, settingCopy } from "./Settings/setting-binding.js";

export function AgentPermissions({ repoUrl }: { repoUrl: string }) {
  const repo = useRepoStore((s) => s.repos.find((r) => r.url === repoUrl));
  const setAllow = useRepoStore((s) => s.setRepoAllowAgentMerge);
  const allowed = repo?.allowAgentMerge === true;
  const { label, description } = settingCopy("project.allowAgentMerge");

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
          <div
            className="text-[13.5px] font-semibold text-(--color-text-primary)"
            data-setting-label="project.allowAgentMerge"
          >
            {label}
          </div>
          <p
            className="text-xs text-(--color-text-secondary) mt-0.5"
            data-setting-description="project.allowAgentMerge"
          >
            {description}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowed}
          aria-label={label}
          data-testid="allow-agent-merge-toggle"
          {...bindSetting("project.allowAgentMerge")}
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
