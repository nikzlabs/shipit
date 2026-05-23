/**
 * PrFilesSection — entry point to the existing Monaco diff viewer.
 *
 * Per docs/133, the panel does NOT re-implement a diff viewer. For now it
 * surfaces a per-file summary plus the shared full-diff affordance. Per-row
 * buttons intentionally open the existing diff dialog rather than reimplement
 * file-scoped diffing in this panel.
 */

import { useState } from "react";
import { GitDiffIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { useGitStore } from "../../stores/git-store.js";
import type { PrFileStat } from "../../../server/shared/types/github-types.js";

function statusLabel(status: string): string {
  switch (status) {
    case "A": return "Added";
    case "D": return "Deleted";
    case "R": return "Renamed";
    case "C": return "Copied";
    case "M":
    default: return "Modified";
  }
}

export function PrFilesSection({
  sessionId,
  baseBranch,
  files,
}: {
  sessionId: string;
  baseBranch: string;
  files?: PrFileStat[];
}) {
  const [loading, setLoading] = useState(false);

  const handleViewDiff = async () => {
    if (loading) return;
    setLoading(true);
    const base = baseBranch || "main";
    try {
      await useGitStore.getState().fetchDiffVsBranch(sessionId, base);
      useGitStore.getState().openDiffDialog(`Changes vs ${base}`);
    } catch {
      // Silently fail — the diff dialog simply won't open.
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="px-4 py-3 border-b border-(--color-border-primary)">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary)">
          Files{files ? ` (${files.length})` : ""}
        </h3>
        <Button variant="secondary" size="sm" onClick={handleViewDiff} disabled={loading}>
          <GitDiffIcon size={ICON_SIZE.SM} />
          {loading ? "Loading diff..." : "View full diff"}
        </Button>
      </div>

      {files && files.length > 0 ? (
        <div className="divide-y divide-(--color-border-primary) rounded-md border border-(--color-border-primary)">
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 px-2.5 py-2 text-xs">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-(--color-border-secondary) bg-(--color-bg-tertiary) font-mono text-[10px] text-(--color-text-secondary)"
                title={statusLabel(file.status)}
              >
                {file.status}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-(--color-text-secondary)" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 text-(--color-success)">+{file.insertions}</span>
              <span className="shrink-0 text-(--color-error)">-{file.deletions}</span>
              <button
                type="button"
                onClick={handleViewDiff}
                disabled={loading}
                className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-(--color-text-link) hover:bg-(--color-bg-hover) hover:text-(--color-accent) disabled:opacity-50"
              >
                View diff
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-(--color-text-tertiary)">File details will appear after the next PR status refresh.</p>
      )}
    </section>
  );
}
