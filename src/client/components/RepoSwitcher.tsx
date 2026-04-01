import { PlusIcon, FolderPlusIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { parseRepoName } from "../utils/repo-label.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";
import type { RepoInfo } from "../../server/shared/types.js";

interface RepoSwitcherProps {
  repos: RepoInfo[];
  activeRepoUrl: string | undefined;
  onSelectRepo: (url: string) => void;
  onAddRepo: () => void;
  onCreateNew: () => void;
  children: React.ReactNode;
}

export function RepoSwitcher({ repos, activeRepoUrl, onSelectRepo, onAddRepo, onCreateNew, children }: RepoSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {repos.length > 0 && (
          <>
            {repos.map((repo) => {
              const isActive = repo.url === activeRepoUrl;
              return (
                <DropdownMenuItem
                  key={repo.url}
                  onSelect={() => onSelectRepo(repo.url)}
                  className={isActive ? "text-(--color-text-primary)" : "text-(--color-text-secondary)"}
                >
                  <span className={`w-3 text-center ${isActive ? "text-(--color-success)" : "opacity-0"}`}>
                    ✓
                  </span>
                  <span className="truncate flex-1 text-left">{parseRepoName(repo.url)}</span>
                  {repo.status === "cloning" && (
                    <span className="text-[9px] text-(--color-warning) animate-pulse">cloning</span>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onAddRepo} className="text-(--color-text-link)">
          <PlusIcon size={ICON_SIZE.XS} className="shrink-0" />
          Add Repository
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateNew} className="text-(--color-text-link)">
          <FolderPlusIcon size={ICON_SIZE.XS} className="shrink-0" />
          Create New
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
