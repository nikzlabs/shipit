/**
 * docs/314 — a message the agent wants delivered to a session it cannot
 * address. `shipit session message` reaches only the sessions that agent
 * spawned; approving here is the only way anything else receives it, and the
 * approval covers this one message.
 */

import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  PaperPlaneTiltIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Spinner } from "./Spinner.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { SessionMessageProposalCard as SessionMessageProposalCardData } from "../../server/shared/types.js";
import { Button } from "./ui/button.js";
import { useSessionStore } from "../stores/session-store.js";

export interface SessionMessageProposalCardProps {
  card: SessionMessageProposalCardData;
  /** Rejects if the delivery could not be requested; the card then shows why. */
  onDeliver?: (cardId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}

export function SessionMessageProposalCard({
  card,
  onDeliver,
  onOpenSession,
}: SessionMessageProposalCardProps) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  /**
   * A card mounted as `delivering` stays clickable rather than spinning on a
   * state nothing here will ever resolve — a reload or a session switch can
   * mount one while the request is genuinely still running, and an orchestrator
   * that stopped mid-delivery leaves one behind forever. Clicking is safe in
   * both: the server refuses a concurrent delivery and refuses a delivered one.
   */
  const staleDelivery = useRef(card.state === "delivering");
  /**
   * The user approves this exact text, so any part of it the clamp hides must be
   * reachable. Measured rather than guessed from the length: six short lines, or
   * a narrow column that wraps, overflow a message well under any character cap.
   */
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    setClipped(el.scrollHeight > el.clientHeight);
  }, [card.message, expanded]);

  const targetSession = useSessionStore((s) =>
    s.sessions.find((row) => row.id === card.targetSessionId),
  );

  const liveDelivering = card.state === "delivering" && !staleDelivery.current;
  const delivering = requesting || liveDelivering;
  const delivered = card.state === "delivered";

  const handleDeliver = async () => {
    if (delivering || delivered) return;
    setRequestError(null);
    setRequesting(true);
    try {
      await onDeliver?.(card.cardId);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  const handleOpen = () => {
    if (onOpenSession) {
      onOpenSession(card.targetSessionId);
      return;
    }
    useSessionStore.getState().setSessionId(card.targetSessionId);
  };

  const errorMessage = requestError ?? (card.state === "failed" ? card.errorMessage : undefined);

  return (
    <div
      data-testid="session-message-proposal-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs flex flex-col gap-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-(--color-accent)">
          <PaperPlaneTiltIcon size={ICON_SIZE.SM} />
        </span>
        <span className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
          Message for another session
        </span>
      </div>

      <div className="pl-0.5 flex flex-col gap-1">
        <div className="text-(--color-text-primary) font-medium">
          {targetSession?.title ?? card.targetTitle}
        </div>
        <div
          ref={bodyRef}
          className={`text-(--color-text-secondary) whitespace-pre-wrap ${expanded ? "" : "line-clamp-6"}`}
          data-testid="session-message-proposal-body"
        >
          {card.message}
        </div>
        {(clipped || expanded) && (
          <button
            type="button"
            className="self-start text-(--color-text-link) hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Show less" : "Show the whole message"}
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="flex items-start gap-1.5 text-(--color-error)" role="status">
          <span className="shrink-0 mt-0.5">
            <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
          </span>
          <span data-testid="session-message-proposal-error">{errorMessage}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        {delivered ? (
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={handleOpen}
              aria-label={`Open session ${targetSession?.title ?? card.targetTitle}`}
            >
              <ArrowSquareOutIcon size={ICON_SIZE.SM} />
              Open session
            </Button>
            <span
              className="text-(--color-text-tertiary)"
              data-testid="session-message-proposal-status"
            >
              {card.queued
                ? `Queued behind the turn ${card.targetTitle} is running`
                : `Delivered to ${card.targetTitle}`}
            </span>
          </>
        ) : (
          <>
            <Button variant="primary" size="md" onClick={handleDeliver} disabled={delivering}>
              {delivering ? <Spinner size={ICON_SIZE.SM} /> : <PaperPlaneTiltIcon size={ICON_SIZE.SM} />}
              {delivering
                ? "Sending…"
                : card.state === "failed"
                  ? "Try again"
                  : `Send to ${card.targetTitle}`}
            </Button>
            <span className="text-(--color-text-tertiary)">
              Starts a turn there. This message only.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
