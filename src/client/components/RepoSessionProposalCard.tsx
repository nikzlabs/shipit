/**
 * docs/303 — work the agent says belongs in a different repository.
 *
 * One click starts an ordinary, independent session on that repository with the
 * prompt already sent. The card is the only link to what it started, so it keeps
 * the new session's id and opens it.
 */

import { useRef, useState } from "react";
import {
  ArrowSquareOutIcon,
  GitForkIcon,
  PlusCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { Spinner } from "./Spinner.js";
import { ICON_SIZE } from "../design-tokens.js";
import type { RepoSessionProposalCard as RepoSessionProposalCardData } from "../../server/shared/types.js";
import { Button } from "./ui/button.js";
import { useSessionStore } from "../stores/session-store.js";

export interface RepoSessionProposalCardProps {
  card: RepoSessionProposalCardData;
  /** Rejects if the start could not be requested; the card then shows why. */
  onStart?: (cardId: string) => Promise<void>;
  onOpenSession?: (sessionId: string) => void;
}

export function RepoSessionProposalCard({
  card,
  onStart,
  onOpenSession,
}: RepoSessionProposalCardProps) {
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  /**
   * A card that is ALREADY `starting` when this mount begins is a leftover: the
   * live `starting` always arrives as an update, so the only way to load one is
   * that the process working on it is gone. Stay clickable rather than showing a
   * spinner that can never resolve; the server refuses a genuine double-start.
   */
  const staleStart = useRef(card.state === "starting");
  // The user approves this text, so it must be readable in full — but a 4,000
  // character prompt would otherwise swamp the transcript.
  const [promptExpanded, setPromptExpanded] = useState(false);

  const startedSession = useSessionStore((s) =>
    card.startedSessionId ? s.sessions.find((row) => row.id === card.startedSessionId) : undefined,
  );

  const liveStarting = card.state === "starting" && !staleStart.current;
  const starting = requesting || liveStarting;
  const started = card.state === "started";

  const handleStart = async () => {
    if (starting || started) return;
    setRequestError(null);
    setRequesting(true);
    try {
      await onStart?.(card.cardId);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  };

  const handleOpen = () => {
    if (!card.startedSessionId) return;
    if (onOpenSession) {
      onOpenSession(card.startedSessionId);
      return;
    }
    useSessionStore.getState().setSessionId(card.startedSessionId);
  };

  const errorMessage = requestError ?? (card.state === "failed" ? card.errorMessage : undefined);

  return (
    <div
      data-testid="repo-session-proposal-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs flex flex-col gap-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-(--color-accent)">
          <GitForkIcon size={ICON_SIZE.SM} />
        </span>
        <span className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
          Work for another repository
        </span>
      </div>

      <div className="pl-0.5 flex flex-col gap-1">
        <div className="text-(--color-text-primary) font-medium">{card.title}</div>
        <div className="font-mono text-(--color-text-secondary)">{card.repo}</div>
        <div
          className={`text-(--color-text-secondary) whitespace-pre-wrap ${promptExpanded ? "" : "line-clamp-6"}`}
          data-testid="repo-session-proposal-prompt"
        >
          {card.prompt}
        </div>
        {card.prompt.length > 280 && (
          <button
            type="button"
            className="self-start text-(--color-text-link) hover:underline"
            onClick={() => setPromptExpanded((v) => !v)}
          >
            {promptExpanded ? "Show less" : "Show the whole prompt"}
          </button>
        )}
      </div>

      {card.readOnly && !started && (
        <div className="flex items-start gap-1.5 text-(--color-warning)">
          <span className="shrink-0 mt-0.5">
            <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
          </span>
          <span>
            The connected GitHub account can read {card.repo} but not push to it, so that session
            will not be able to open a pull request.
          </span>
        </div>
      )}

      {!card.registered && !started && (
        <div className="flex items-start gap-1.5 text-(--color-text-tertiary)">
          <span className="shrink-0 mt-0.5">
            <PlusCircleIcon size={ICON_SIZE.XS} />
          </span>
          <span>{card.repo} is not in ShipIt yet — starting this adds it to the sidebar.</span>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-start gap-1.5 text-(--color-error)" role="status">
          <span className="shrink-0 mt-0.5">
            <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
          </span>
          <span data-testid="repo-session-proposal-error">{errorMessage}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        {started ? (
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={handleOpen}
              aria-label={`Open session ${startedSession?.title ?? card.title}`}
            >
              <ArrowSquareOutIcon size={ICON_SIZE.SM} />
              Open session
            </Button>
            <span className="text-(--color-text-tertiary)" data-testid="repo-session-proposal-status">
              {/* The sidebar list hides archived sessions, so absence is not deletion. */}
              {startedSession ? `Started on ${card.repo}` : `Started on ${card.repo} · not in the sidebar`}
            </span>
          </>
        ) : (
          <>
            <Button variant="primary" size="md" onClick={handleStart} disabled={starting}>
              {starting ? <Spinner size={ICON_SIZE.SM} /> : <GitForkIcon size={ICON_SIZE.SM} />}
              {starting
                ? "Starting…"
                : card.state === "failed"
                  ? "Try again"
                  : `Start in ${card.repo}`}
            </Button>
            <span className="text-(--color-text-tertiary)">
              Runs on its own, separate from this session.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
