import { useState, useRef, useMemo } from "react";
import { parseRepoLabel } from "../utils/repo-label.js";
import type { SessionInfo, RepoInfo } from "../../server/shared/types.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { SessionItem } from "./SessionSidebar.js";

interface AllSessionsDialogProps {
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  repos: RepoInfo[];
  currentRepoUrl: string | undefined;
  onFetch: () => void;
  onResume: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => Promise<void>;
  onArchive: (sessionId: string) => Promise<void>;
}

const ALL_REPOS = "__all__";
// docs/128 (ops) / docs/211 (sandbox) — these kinds are repo-less (no
// `remoteUrl`), so they belong to no repo bucket and would only ever surface
// under "All Repositories". Give them their own synthetic filter entries so an
// archived sandbox/ops session is discoverable and restorable on its own,
// instead of being effectively unreachable from a repo-scoped view.
const SANDBOX_FILTER = "__sandbox__";
const OPS_FILTER = "__ops__";

export function AllSessionsDialog({
  open,
  onClose,
  sessions,
  repos,
  currentRepoUrl,
  onFetch,
  onResume,
  onUnarchive,
  onArchive,
}: AllSessionsDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>(ALL_REPOS);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build unique repo URLs from all sessions + repos list
  const repoOptions = useMemo(() => {
    const urls = new Set<string>();
    for (const s of sessions) {
      if (s.remoteUrl) urls.add(s.remoteUrl);
    }
    for (const r of repos) {
      urls.add(r.url);
    }
    return [...urls].sort((a, b) =>
      parseRepoLabel(a).localeCompare(parseRepoLabel(b)),
    );
  }, [sessions, repos]);

  // Only offer the kind-based filters when such sessions actually exist
  // (archived ones are included — `sessions` is the full `/all` list).
  const hasSandbox = useMemo(() => sessions.some((s) => s.kind === "sandbox"), [sessions]);
  const hasOps = useMemo(() => sessions.some((s) => s.kind === "ops"), [sessions]);

  // Reset state when dialog opens (inline state reset during render)
  const prevOpenRef = useRef(false);
  if (open && !prevOpenRef.current) {
    setQuery("");
    setSelectedRepo(currentRepoUrl ?? ALL_REPOS);
    setActioningId(null);
    queueMicrotask(() => {
      onFetch();
      inputRef.current?.focus();
    });
  }
  prevOpenRef.current = open;

  if (!open) return null;

  const filtered = sessions.filter((s) => {
    // Repo / kind filter
    if (selectedRepo === SANDBOX_FILTER) {
      if (s.kind !== "sandbox") return false;
    } else if (selectedRepo === OPS_FILTER) {
      if (s.kind !== "ops") return false;
    } else if (selectedRepo !== ALL_REPOS && s.remoteUrl !== selectedRepo) {
      return false;
    }
    // Text filter
    if (query.trim()) {
      const q = query.toLowerCase();
      const matchesTitle = s.title.toLowerCase().includes(q);
      const matchesRepo =
        s.remoteUrl && parseRepoLabel(s.remoteUrl).toLowerCase().includes(q);
      if (!matchesTitle && !matchesRepo) return false;
    }
    return true;
  });

  const handleUnarchive = async (sessionId: string) => {
    setActioningId(sessionId);
    try {
      await onUnarchive(sessionId);
    } finally {
      setActioningId(null);
    }
  };

  const handleArchive = async (sessionId: string) => {
    setActioningId(sessionId);
    try {
      await onArchive(sessionId);
    } finally {
      setActioningId(null);
    }
  };

  const handleResume = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    // Restore the workspace before resuming when the session has no live
    // on-disk checkout: either the user hid it (`archived`/`userArchived`) or
    // the disk-idle ladder evicted it (`diskTier === "evicted"`). `unarchive`
    // re-clones from the bare cache on a fresh branch.
    if (session && (session.archived || session.userArchived || session.diskTier === "evicted")) {
      await onUnarchive(sessionId);
    }
    onResume(sessionId);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="w-full max-md:flex max-md:flex-col md:max-w-lg rounded-lg border-(--color-border-secondary)">
        {/* Header */}
        <div className="flex items-center border-b border-(--color-border-secondary) px-4 py-3">
          <DialogTitle className="text-sm font-medium text-(--color-text-primary)">
            All Sessions
          </DialogTitle>
        </div>

        {/* Filter bar */}
        <div className="px-4 pt-3 pb-2 flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            placeholder="Search sessions..."
            className="flex-1 min-w-0 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-1.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:border-(--color-border-focus) focus:outline-none"
          />
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="shrink-0 max-w-[200px] rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 py-1.5 text-sm text-(--color-text-primary) focus:border-(--color-border-focus) focus:outline-none truncate"
          >
            <option value={ALL_REPOS}>All Repositories</option>
            {hasSandbox && <option value={SANDBOX_FILTER}>Sandbox</option>}
            {hasOps && <option value={OPS_FILTER}>Host / Ops</option>}
            {repoOptions.map((url) => (
              <option key={url} value={url}>
                {parseRepoLabel(url)}
              </option>
            ))}
          </select>
        </div>

        {/* Session list */}
        <div className="px-4 pb-3 max-md:flex-1 max-md:min-h-0">
          <div className="h-80 max-md:h-full overflow-y-auto rounded-md border border-(--color-border-secondary) flex flex-col gap-1 py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-(--color-text-secondary)">
                {sessions.length === 0
                  ? "No sessions yet."
                  : "No matches found."}
              </p>
            ) : (
              filtered.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isCurrent={false}
                  onResume={handleResume}
                  onArchive={handleArchive}
                  onRestore={handleUnarchive}
                  repoLabel={selectedRepo === ALL_REPOS && session.remoteUrl ? parseRepoLabel(session.remoteUrl) : undefined}
                  disabled={actioningId === session.id}
                  overflowMenuPortaled={false}
                />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-(--color-border-secondary) px-4 py-3">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
