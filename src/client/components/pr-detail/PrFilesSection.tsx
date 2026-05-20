/**
 * PrFilesSection — entry point to the existing Monaco diff viewer.
 *
 * Per docs/133, the panel does NOT re-implement a diff viewer. For now it
 * surfaces a single "View full diff" affordance that fetches HEAD-vs-base and
 * opens the shared diff dialog (same path the card's diff stats use). A
 * per-file list is a Phase 5 follow-up once the file list is on the summary.
 */

import { useState } from "react";
import { GitDiffIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { Button } from "../ui/button.js";
import { useGitStore } from "../../stores/git-store.js";

export function PrFilesSection({ sessionId, baseBranch }: { sessionId: string; baseBranch: string }) {
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
      <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-text-tertiary) mb-2">
        Files
      </h3>
      <Button variant="secondary" size="sm" onClick={handleViewDiff} disabled={loading}>
        <GitDiffIcon size={ICON_SIZE.SM} />
        {loading ? "Loading diff…" : "View full diff"}
      </Button>
    </section>
  );
}
