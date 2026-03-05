import { useRef, useEffect } from "react";
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

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute left-2 top-11 w-52 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1"
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
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        Add Repository
      </button>
      <button
        onClick={() => { onCreateNew(); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-xs text-(--color-text-link) hover:bg-(--color-bg-hover) transition-colors flex items-center gap-2"
      >
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        Create New
      </button>
    </div>
  );
}
