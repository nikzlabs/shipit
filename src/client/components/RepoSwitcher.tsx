import { PlusIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { parseRepoName } from "../utils/repo-label.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";
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
  return (
    <DropdownMenu open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DropdownMenuContent
        align="end"
        className="w-52"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {repos.length > 0 && (
          <>
            {repos.map((repo) => {
              const isActive = repo.url === activeRepoUrl;
              return (
                <DropdownMenuItem
                  key={repo.url}
                  onClick={() => onSelectRepo(repo.url)}
                  className={`text-xs ${
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
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={onAddRepo} className="text-xs text-(--color-text-link)">
          <PlusIcon size={ICON_SIZE.XS} className="shrink-0" />
          Add Repository
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCreateNew} className="text-xs text-(--color-text-link)">
          <FolderPlusIcon size={ICON_SIZE.XS} className="shrink-0" />
          Create New
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
