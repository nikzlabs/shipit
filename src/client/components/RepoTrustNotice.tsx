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
 *
 * **Layout.** It takes the same card treatment as `QueueIndicator` — `mx-4` so
 * it lines up with the MessageInput box below rather than stretching the full
 * panel width, plus the shared rounded border and tinted fill — because it
 * plays the same role: a standing state attached to the composer. Contents are
 * centered rather than pushed to the edges: at the panel's width the sentence
 * plus the button rarely share a line, so `justify-between` would strand the
 * button hard against the right edge on its own row.
 *
 * It is deliberately rendered as a sibling of MessageInput in `App.tsx`, NOT
 * inside the bottom stack. The empty-state rocket is anchored to the bottom of
 * the flex-1 wrapper that holds the message list *and* that stack, so anything
 * placed in the stack gets the rocket flying over it. Staying outside the
 * wrapper makes this panel's top edge the wrapper's bottom edge, so the rocket
 * launches from the top of this card exactly as it launches from the top of the
 * input when the card isn't there.
 */

import { ShieldWarningIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useRepoTrust } from "../hooks/useRepoTrust.js";
import { Button } from "./ui/button.js";

export function RepoTrustNotice({ repoUrl }: { repoUrl: string | undefined }) {
  const { untrusted, trusting, trust } = useRepoTrust(repoUrl);

  return (
    <div
      className="mx-4 mb-2 rounded-xl border border-(--color-border-primary) bg-(--color-bg-secondary)/20 px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-2"
      role="status"
      data-testid="repo-trust-notice"
    >
      {/* `items-start` + `mt-0.5` pins the icon to the first line instead of
          letting it float to the vertical middle of a wrapped two-line
          sentence; 2px is the offset that centers a 12px glyph on a 16px line
          box (the same idiom as the card's warning rows in OpenPhase). */}
      <span className="flex items-start gap-1.5 text-xs text-center text-(--color-warning)">
        <ShieldWarningIcon size={ICON_SIZE.XS} weight="fill" className="mt-0.5 shrink-0" />
        <span>This repository isn&rsquo;t trusted yet, so messages to the agent are blocked.</span>
      </span>
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
