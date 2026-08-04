/**
 * RepoTrustNotice — the trust consent inline above the composer.
 *
 * The docs/243 messaging gate is fail-closed: an untrusted remote can't start
 * an agent turn, so the composer is disabled and the server rejects dispatch.
 * The consent that lifts it (docs/178) used to live *only* in the Preview tab's
 * restricted empty state — and modes that render no Preview tab render no
 * `RepoTrustBanner` either. In local mode (`RUNTIME_MODE=local`, what the
 * dogfood `dev` service runs) the Preview tab is omitted entirely and the
 * preview wrapper is permanently `invisible pointer-events-none`, so every
 * repo-backed session was a dead end: no messages, and no reachable way to
 * grant trust. The old copy here even pointed at that missing tab.
 *
 * So the consent lives where the block is felt. This renders in the chat
 * column, which exists in every mode, and shares its state and grant action
 * with the banner via `useRepoTrust` so the two can't drift.
 *
 * Per docs/178 this stays a one-time security *consent*, not a shell-shaped
 * action button (CLAUDE.md §5): the user is granting the box permission to run
 * foreign setup code once, not operating the box.
 *
 * The caller decides *whether* the block applies (App's `agentMessagingBlocked`
 * mirrors the server rule); this component owns explaining it and offering the
 * grant. When the remote doesn't resolve to a tracked repo there is nothing the
 * trust endpoint would accept, so the explanation renders without the button
 * rather than the whole notice vanishing — a blocked composer with no
 * explanation at all is the worse failure.
 */

import { useRepoTrust } from "../hooks/useRepoTrust.js";
import { Button } from "./ui/button.js";

export function RepoTrustNotice({ repoUrl }: { repoUrl: string | undefined }) {
  const { untrusted, trusting, trust } = useRepoTrust(repoUrl);

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 pb-2 text-xs text-center text-(--color-warning)"
      role="status"
      data-testid="repo-trust-notice"
    >
      <span>This repository isn&rsquo;t trusted yet, so messages to the agent are blocked.</span>
      {untrusted && (
        <Button
          size="sm"
          onClick={() => void trust()}
          disabled={trusting}
          data-testid="repo-trust-notice-accept"
        >
          {trusting ? "Trusting…" : "Trust this repository"}
        </Button>
      )}
    </div>
  );
}
