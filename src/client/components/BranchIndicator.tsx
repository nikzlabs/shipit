import { useState, useRef, useEffect, useCallback } from "react";
import type { BranchInfo, CheckpointInfo } from "../../server/types.js";

export { type BranchInfo, type CheckpointInfo };

export function BranchIndicator({
  branches,
  activeBranchId,
  onCreateCheckpoint,
  onBranchFromCheckpoint,
  onSwitchBranch,
  disabled,
}: {
  branches: BranchInfo[];
  activeBranchId: string;
  onCreateCheckpoint: (label?: string) => void;
  onBranchFromCheckpoint: (checkpointId: string) => void;
  onSwitchBranch: (branchId: string) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showCheckpointInput, setShowCheckpointInput] = useState(false);
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeBranch = branches.find((b) => b.id === activeBranchId);

  // Close dropdown on outside click
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setExpanded(false);
        setShowCheckpointInput(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded]);

  // Focus input when checkpoint input is shown
  useEffect(() => {
    if (showCheckpointInput && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showCheckpointInput]);

  const handleCreateCheckpoint = useCallback(() => {
    onCreateCheckpoint(checkpointLabel.trim() || undefined);
    setCheckpointLabel("");
    setShowCheckpointInput(false);
  }, [checkpointLabel, onCreateCheckpoint]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleCreateCheckpoint();
      }
      if (e.key === "Escape") {
        setShowCheckpointInput(false);
        setCheckpointLabel("");
      }
    },
    [handleCreateCheckpoint],
  );

  // Don't render if there are no branches
  if (branches.length === 0) return null;

  const allCheckpoints = branches.flatMap((b) =>
    b.checkpoints.map((cp) => ({ ...cp, branchName: b.name })),
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-center gap-1.5">
        {/* Branch name button */}
        <button
          onClick={() => setExpanded((v) => !v)}
          disabled={disabled}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
          title="Branches & Checkpoints"
        >
          {/* Git branch icon */}
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m0 0a3 3 0 103 3H15a3 3 0 100-3m-9 0h9m-9 0a3 3 0 01-3-3V6a3 3 0 013-3h0" />
          </svg>
          <span className="max-w-[100px] truncate">{activeBranch?.name ?? "main"}</span>
          {branches.length > 1 && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500">
              ({branches.length})
            </span>
          )}
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Quick checkpoint button */}
        <button
          onClick={() => setShowCheckpointInput(true)}
          disabled={disabled}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-50"
          title="Create checkpoint"
        >
          {/* Flag icon */}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" />
          </svg>
        </button>
      </div>

      {/* Checkpoint label input */}
      {showCheckpointInput && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2 w-64">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={checkpointLabel}
              onChange={(e) => setCheckpointLabel(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Checkpoint label (optional)"
              maxLength={200}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 outline-none focus:border-blue-500"
            />
            <button
              onClick={handleCreateCheckpoint}
              className="text-xs px-2 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Dropdown */}
      {expanded && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg w-72 max-h-80 overflow-y-auto">
          {/* Branches section */}
          <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
              Branches
            </p>
            <div className="space-y-0.5">
              {branches.map((branch) => (
                <button
                  key={branch.id}
                  onClick={() => {
                    if (branch.id !== activeBranchId) {
                      onSwitchBranch(branch.id);
                      setExpanded(false);
                    }
                  }}
                  className={`flex items-center gap-2 w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
                    branch.id === activeBranchId
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    branch.id === activeBranchId ? "bg-blue-500" : "bg-gray-400 dark:bg-gray-600"
                  }`} />
                  <span className="truncate">{branch.name}</span>
                  {branch.checkpoints.length > 0 && (
                    <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500">
                      {branch.checkpoints.length} cp
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Checkpoints section */}
          {allCheckpoints.length > 0 && (
            <div className="px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                Checkpoints
              </p>
              <div className="space-y-0.5">
                {allCheckpoints.map((cp) => (
                  <div
                    key={cp.id}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 group"
                  >
                    <svg className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M3 6a3 3 0 013-3h2.25a3 3 0 013 3v2.25a3 3 0 01-3 3H6a3 3 0 01-3-3V6zm9.75 0a3 3 0 013-3H18a3 3 0 013 3v2.25a3 3 0 01-3 3h-2.25a3 3 0 01-3-3V6zM3 15.75a3 3 0 013-3h2.25a3 3 0 013 3V18a3 3 0 01-3 3H6a3 3 0 01-3-3v-2.25z" clipRule="evenodd" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <p className="text-gray-700 dark:text-gray-300 truncate">
                        {cp.label || `Checkpoint at msg ${cp.messageIndex}`}
                      </p>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">
                        {cp.branchName} &middot; {formatRelativeDate(cp.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        onBranchFromCheckpoint(cp.id);
                        setExpanded(false);
                      }}
                      className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-700 dark:hover:text-gray-300 transition-all"
                    >
                      branch
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
