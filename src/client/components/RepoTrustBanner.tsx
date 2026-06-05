/**
 * RepoTrustBanner — the trust-on-first-use consent surface (docs/178).
 *
 * Cloning a repo never auto-runs its code. A freshly-added remote is
 * "untrusted": ShipIt clones it, renders the file tree and diffs, and lets the
 * agent chat — but defers every repo-declared command it would otherwise
 * auto-execute (`agent.install` and compose `command:`/`build:`) until the user
 * accepts once. This banner is that acceptance, rendered inline above the
 * preview panel (per CLAUDE.md §1–§2 — no link-out, no settings-page bounce).
 *
 * It is a one-time security *consent*, not a shell-shaped action button (§5):
 * the agent still operates the box; the user is granting the box permission to
 * run foreign setup code once. The decision is per-remote and persists in
 * RepoStore, so it does not recur per session — the banner is driven by the
 * repo's `trusted` flag (authoritative, flows over SSE), so it clears for every
 * tab the moment trust is granted.
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
  // `dismissed` is local "keep restricted" state. It resets when the active
  // repo changes because the parent keys this component by `repoUrl`, so a
  // different untrusted remote re-surfaces the consent without a useEffect.
  const [dismissed, setDismissed] = useState(false);
  const [trusting, setTrusting] = useState(false);

  if (!repoUrl || dismissed) return null;
  const key = normalizeRepoUrl(repoUrl);
  const repo = repos.find((r) => normalizeRepoUrl(r.url) === key);
  // Show only once we know the repo AND it is explicitly untrusted. `undefined`
  // (repo still loading, or a hand-built RepoInfo without the flag) is treated
  // as "don't prompt" to avoid a flash of the banner during hydration.
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
      className="flex items-start gap-3 px-3 py-2.5 border-b bg-(--color-warning-subtle) text-(--color-warning) border-(--color-warning)/30"
      data-testid="repo-trust-banner"
    >
      <ShieldWarningIcon size={ICON_SIZE.MD} weight="fill" className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">This repository is not trusted yet</p>
        <p className="text-xs opacity-90 mt-0.5">
          It can run setup commands and services on your machine. Browsing files,
          diffs, and chat work while restricted — setup commands and previews stay
          off until you trust it.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0 self-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDismissed(true)}
          className="text-(--color-text-secondary) hover:text-(--color-text-primary)"
        >
          Keep restricted
        </Button>
        <Button
          size="sm"
          onClick={onTrust}
          disabled={trusting}
          data-testid="repo-trust-accept"
        >
          {trusting ? "Trusting…" : "Trust this repository"}
        </Button>
      </div>
    </div>
  );
}
