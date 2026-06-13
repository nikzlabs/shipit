/**
 * EgressPromptCard — inline allow-once card for a blocked egress host (docs/172,
 * SHI-90, Tier C).
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
    const tone = phase === "denied" ? "text-gray-400" : "text-emerald-400";
    return (
      <div
        data-testid="egress-prompt-card"
        className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-sm text-gray-300"
      >
        <span className={`inline-flex items-center gap-1.5 ${tone}`}>
          <Icon size={ICON_SIZE.SM} weight="fill" />
          {label}
          <span className="text-gray-500">· {host}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="egress-prompt-card"
      className="rounded-lg border border-amber-700/50 bg-amber-950/20 px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldWarningIcon size={ICON_SIZE.MD} weight="fill" className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-100">Egress blocked</div>
          <div className="mt-0.5 text-sm text-gray-300">
            The agent tried to reach{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5 text-amber-200">{host}</code>, which is
            not on the egress allowlist.
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
