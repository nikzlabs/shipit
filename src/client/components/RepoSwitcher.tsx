import { useRef } from "react";
import { useClickOutside } from "../hooks/useClickOutside.js";
import { PlusIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { parseRepoName } from "../utils/repo-label.js";
import type { RepoInfo } from "../../server/shared/types.js";

interface RepoSwitcherProps {
  open: boolean;
  onClose: () => void;
  repos: RepoInfo[];
  activeRepoUrl: string | undefined;
  onSelectRepo: (url: string) => void;
  onAddRepo: () => void;
  onCreateNew: () => void;
}

export function RepoSwitcher({ open, onClose, repos, activeRepoUrl, onSelectRepo, onAddRepo, onCreateNew }: RepoSwitcherProps) {
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, onClose, open);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-2 top-11 w-52 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1"
    >
      {repos.length > 0 && (
        <>
          {repos.map((repo) => {
            const isActive = repo.url === activeRepoUrl;
            return (
              <button
                key={repo.url}
                onClick={() => { onSelectRepo(repo.url); onClose(); }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-(--color-bg-hover) transition-colors ${
                  isActive ? "text-(--color-text-primary)" : "text-(--color-text-secondary)"
                }`}
              >
                <span className={`w-3 text-center ${isActive ? "text-(--color-success)" : "opacity-0"}`}>
                  ✓
                </span>
                <span className="truncate flex-1">{parseRepoName(repo.url)}</span>
                {repo.status === "cloning" && (
                  <span className="text-[9px] text-(--color-warning) animate-pulse">cloning</span>
                )}
              </button>
            );
          })}
          <div className="border-t border-(--color-border-primary) my-1" />
        </>
      )}
      <button
        onClick={() => { onAddRepo(); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-xs text-(--color-text-link) hover:bg-(--color-bg-hover) transition-colors flex items-center gap-2"
      >
        <PlusIcon size={ICON_SIZE.XS} className="shrink-0" />
        Add Repository
      </button>
      <button
        onClick={() => { onCreateNew(); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-xs text-(--color-text-link) hover:bg-(--color-bg-hover) transition-colors flex items-center gap-2"
      >
        <FolderPlusIcon size={ICON_SIZE.XS} className="shrink-0" />
        Create New
      </button>
    </div>
  );
}
