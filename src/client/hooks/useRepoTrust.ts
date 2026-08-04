/**
 * useRepoTrust — shared lookup + grant action for the docs/178 trust gate.
 *
 * Two surfaces now consent to the same one-time decision: the Preview tab's
 * restricted empty state (`RepoTrustBanner`) and the notice above the composer
 * that appears when the docs/243 messaging gate blocks a turn
 * (`RepoTrustNotice`). The repo lookup, the in-flight flag, and the POST live
 * here once so the two can't drift — a second hand-rolled copy of the matching
 * rule is exactly how one surface ends up prompting for a repo the other
 * considers trusted.
 */

import { useState } from "react";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";

/** Tolerant repo-URL match — mirrors the server's `canonicalRepoKey` fallback. */
function normalizeRepoUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

export interface RepoTrust {
  /**
   * True only once the remote resolves to a tracked repo AND that repo is
   * explicitly untrusted. `undefined` (still hydrating, or a hand-built
   * RepoInfo without the flag) is treated as "don't prompt", so no surface
   * flashes during hydration.
   *
   * This is also the condition for offering the grant at all: an unresolved
   * remote has no URL the server would accept (`POST /api/repos/trust` 404s on
   * an unknown remote). A surface that explains the block on its own authority
   * should still render its text when this is false — just without the button.
   */
  untrusted: boolean;
  /** A grant is in flight. */
  trusting: boolean;
  /** Grant trust for this remote. No-op unless `untrusted`. */
  trust: () => Promise<void>;
}

export function useRepoTrust(repoUrl: string | undefined): RepoTrust {
  const repos = useRepoStore((s) => s.repos);
  const [trusting, setTrusting] = useState(false);

  const key = repoUrl ? normalizeRepoUrl(repoUrl) : undefined;
  const repo = key ? repos.find((r) => normalizeRepoUrl(r.url) === key) : undefined;

  const trust = async () => {
    // Post the tracked repo's own `url`, not the caller's spelling: the store's
    // optimistic flip matches rows by exact string.
    if (!repo || trusting) return;
    setTrusting(true);
    try {
      const trusted = await useRepoStore.getState().trustRepo(repo.url);
      if (!trusted) {
        useUiStore.getState().setToast({ message: "Repository trust could not be saved. Try again." });
      }
    } finally {
      setTrusting(false);
    }
  };

  return { untrusted: repo?.trusted === false, trusting, trust };
}
