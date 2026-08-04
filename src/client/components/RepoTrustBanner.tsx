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
 *
 * It is NOT the only consent surface, and must not be treated as one: modes
 * that render no Preview tab at all (local/dogfood — see `RepoTrustNotice`)
 * would otherwise have no reachable way to grant trust.
 */

import { ShieldWarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useRepoTrust } from "../hooks/useRepoTrust.js";
import { Button } from "./ui/button.js";

export function RepoTrustBanner({ repoUrl }: { repoUrl: string | undefined }) {
  const { untrusted, trusting, trust } = useRepoTrust(repoUrl);

  if (!untrusted) return null;

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
          Agent messages, the preview, setup commands, and services stay blocked
          until you trust it. You can still browse files and diffs while the
          repository is restricted.
        </p>
        <Button
          size="md"
          onClick={() => void trust()}
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
