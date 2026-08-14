/**
 * EgressPromptCard — inline allow-once card for a blocked egress host (docs/172,
 * planning#92, Tier C).
 *
 * Rendered at the chat position where the Tier C SNI proxy denied a connection
 * to a non-allowlisted host. Offers the user three choices:
 *   - Allow once — permit the host for this session (the agent's retry succeeds).
 *   - Add to allowlist — same, persisted for the session (durable cross-restart
 *     persistence is the Settings-UI follow-up).
 *   - Deny — leave it blocked.
 *
 * The host + phase come from the egress-prompt store (keyed by cardId) so an
 * `egress_prompt_resolved` update can swap the card to its terminal state.
 */

import {
  ShieldWarningIcon,
  CheckCircleIcon,
  ProhibitIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useEgressPromptStore } from "../stores/egress-prompt-store.js";

export interface EgressPromptCardProps {
  cardId: string;
  onDecide?: (cardId: string, host: string, action: "allow-once" | "add" | "deny") => void;
}

export function EgressPromptCard({ cardId, onDecide }: EgressPromptCardProps) {
  const card = useEgressPromptStore((s) => s.cards[cardId]);
  if (!card) return null;

  const { host, phase } = card;

  if (phase !== "pending") {
    const label =
      phase === "added"
        ? "Added to allowlist"
        : phase === "allowed-once"
          ? "Allowed once"
          : "Denied";
    const Icon = phase === "denied" ? ProhibitIcon : CheckCircleIcon;
    const tone =
      phase === "denied" ? "text-(--color-text-tertiary)" : "text-(--color-success)";
    return (
      <div
        data-testid="egress-prompt-card"
        className="rounded-lg border border-(--color-border-primary) bg-(--color-bg-tertiary) px-3 py-2 text-sm text-(--color-text-secondary)"
      >
        <span className={`inline-flex items-center gap-1.5 ${tone}`}>
          <Icon size={ICON_SIZE.SM} weight="fill" />
          {label}
          <span className="text-(--color-text-tertiary)">· {host}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="egress-prompt-card"
      className="rounded-lg border border-(--color-warning)/40 bg-(--color-warning-subtle) px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldWarningIcon
          size={ICON_SIZE.MD}
          weight="fill"
          className="mt-0.5 shrink-0 text-(--color-warning)"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-(--color-text-primary)">Egress blocked</div>
          <div className="mt-0.5 text-sm text-(--color-text-secondary)">
            The agent tried to reach{" "}
            <code className="rounded bg-(--color-bg-tertiary) px-1 py-0.5 font-mono text-(--color-text-primary)">
              {host}
            </code>
            , which is not on the egress allowlist.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => onDecide?.(cardId, host, "allow-once")}>Allow once</Button>
            <Button variant="secondary" onClick={() => onDecide?.(cardId, host, "add")}>
              Add to allowlist
            </Button>
            <Button variant="ghost" onClick={() => onDecide?.(cardId, host, "deny")}>
              Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
