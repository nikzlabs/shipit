/**
 * RepoTrustBanner — the trust-on-first-use consent surface (docs/178).
 *
 * Cloning a repo never auto-runs its code. A freshly-added remote is
 * "untrusted": ShipIt clones it, renders the file tree and diffs, and lets the
 * agent chat — but defers every repo-declared command it would otherwise
 * auto-execute (`agent.install` and compose `command:`/`build:`) until the user
 * accepts once. Because the preview can't start while untrusted, this renders
 * as the Preview tab's restricted **empty state** — a centered card overlaying
 * the (empty) preview frame, exactly where the preview would be (per CLAUDE.md
 * §1–§2: inline, no link-out, no settings-page bounce). It mirrors VS Code's
 * Restricted Mode: you can read everything; you just can't run the project's
 * code until you trust it.
 *
 * It is a one-time security *consent*, not a shell-shaped action button (§5):
 * the agent still operates the box; the user is granting the box permission to
 * run foreign setup code once. The decision is per-remote and persists in
 * RepoStore, so it does not recur per session — driven by the repo's `trusted`
 * flag (authoritative, flows over SSE), so it clears for every tab the moment
 * trust is granted. ShipIt-template repos are trusted at creation and never
 * reach this state.
 *
 * Rendered inside the Preview tab's frame container, so it is only visible on
 * the Preview tab (the parent wrapper is `invisible` off-tab). The user can
 * keep working restricted simply by not trusting — chat, files, diffs, and the
 * other tabs all stay available.
 */

import { useState } from "react";
import { ShieldWarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useRepoStore } from "../stores/repo-store.js";
import { Button } from "./ui/button.js";

/** Tolerant repo-URL match — mirrors the server's `canonicalRepoKey` fallback. */
function normalizeRepoUrl(u: string): string {
  return u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

export function RepoTrustBanner({ repoUrl }: { repoUrl: string | undefined }) {
  const repos = useRepoStore((s) => s.repos);
  const [trusting, setTrusting] = useState(false);

  if (!repoUrl) return null;
  const key = normalizeRepoUrl(repoUrl);
  const repo = repos.find((r) => normalizeRepoUrl(r.url) === key);
  // Show only once we know the repo AND it is explicitly untrusted. `undefined`
  // (repo still loading, or a hand-built RepoInfo without the flag) is treated
  // as "don't prompt" to avoid a flash of the card during hydration.
  if (repo?.trusted !== false) return null;

  const onTrust = async () => {
    setTrusting(true);
    await useRepoStore.getState().trustRepo(repo.url);
    setTrusting(false);
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="absolute inset-0 z-10 flex items-center justify-center p-6 bg-(--color-bg-secondary)"
      data-testid="repo-trust-banner"
    >
      <div className="max-w-md w-full flex flex-col items-center text-center gap-3">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-(--color-warning-subtle) text-(--color-warning)">
          <ShieldWarningIcon size={ICON_SIZE.LG} weight="fill" className="shrink-0" />
        </div>
        <h2 className="text-base font-semibold text-(--color-text-primary)">
          This repository is not trusted yet
        </h2>
        <p className="text-sm text-(--color-text-secondary)">
          It can run setup commands and start services on your machine. The
          preview and <code className="text-xs">agent.install</code> stay off
          until you trust it — browsing files, diffs, and chat keep working
          while restricted.
        </p>
        <Button
          size="md"
          onClick={onTrust}
          disabled={trusting}
          data-testid="repo-trust-accept"
          className="mt-1"
        >
          {trusting ? "Trusting…" : "Trust this repository"}
        </Button>
        <p className="text-xs text-(--color-text-tertiary)">
          Trusting is remembered for this repository — you won't be asked again.
        </p>
      </div>
    </div>
  );
}
