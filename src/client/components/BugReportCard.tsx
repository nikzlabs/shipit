import { useState } from "react";
import {
  ArrowSquareOutIcon,
  BugIcon,
  CheckCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useBugReportStore } from "../stores/bug-report-store.js";

export interface BugReportCardProps {
  cardId: string;
  onSubmit?: (cardId: string, title: string, body: string) => void;
  onDismiss?: (cardId: string) => void;
}

function augmentBodyWithBrowser(body: string): string {
  if (typeof navigator === "undefined" || typeof window === "undefined") return body;
  const ua = navigator.userAgent;
  const family =
    ua.includes("Firefox/") ? "Firefox"
    : ua.includes("Edg/") ? "Edge"
    : ua.includes("Chrome/") ? "Chrome"
    : ua.includes("Safari/") ? "Safari"
    : "Browser";
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  return body.replace(
    /^(Filed via ShipIt · build .+? · source \S+)$/m,
    `$1 · ${family} ${viewport}`,
  );
}

export function BugReportCard({ cardId, onSubmit, onDismiss }: BugReportCardProps) {
  const card = useBugReportStore((s) => s.cards[cardId]);
  const setFiling = useBugReportStore((s) => s.setFiling);
  const setDismissed = useBugReportStore((s) => s.setDismissed);

  const [title, setTitle] = useState(() => card?.title ?? "");
  const [body, setBody] = useState(() => augmentBodyWithBrowser(card?.body ?? ""));

  if (!card) return null;

  const handleDismiss = () => {
    setDismissed(cardId);
    onDismiss?.(cardId);
  };

  if (card.phase === "dismissed") {
    return (
      <div
        data-testid="bug-report-card"
        className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2 text-xs text-(--color-text-tertiary)"
      >
        Bug report dismissed — nothing was sent.
      </div>
    );
  }

  const phase = card.phase;
  const isFiling = phase === "filing";

  if (phase === "filed" && card.issueUrl) {
    return (
      <div
        data-testid="bug-report-card"
        className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex items-center gap-2"
      >
        <span className="shrink-0 text-(--color-success)">
          <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
        <div className="min-w-0 flex-1 text-(--color-text-primary)">
          Bug report filed
          {typeof card.issueNumber === "number" ? ` — #${card.issueNumber}` : ""}
        </div>
        <a
          href={card.issueUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 inline-flex items-center gap-1 text-(--color-text-secondary) hover:text-(--color-text-primary)"
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          View on GitHub
        </a>
      </div>
    );
  }

  const handleSubmit = () => {
    if (!title.trim() || !body.trim() || isFiling) return;
    setFiling(cardId);
    onSubmit?.(cardId, title.trim(), body);
  };

  return (
    <div
      data-testid="bug-report-card"
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) p-3 text-xs flex flex-col gap-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-(--color-accent)">
          <BugIcon size={ICON_SIZE.SM} />
        </span>
        <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
          Report a bug to ShipIt
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-(--color-text-tertiary) text-[11px]">Title</span>
        <input
          type="text"
          value={title}
          disabled={isFiling}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 text-(--color-text-primary) outline-none focus:border-(--color-accent) disabled:opacity-60"
          aria-label="Bug report title"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-(--color-text-tertiary) text-[11px]">
          Body — this is exactly what gets posted. Edit anything (delete anything you don't want public):
        </span>
        <textarea
          value={body}
          disabled={isFiling}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          className="w-full resize-y rounded-md border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5 font-mono text-[11px] leading-5 text-(--color-text-primary) outline-none focus:border-(--color-accent) disabled:opacity-60"
          aria-label="Bug report body"
        />
      </label>

      {!card.stage2Ran && (
        <div className="flex items-start gap-1.5 text-(--color-warning)">
          <span className="shrink-0 mt-0.5">
            <WarningIcon size={ICON_SIZE.XS} weight="fill" />
          </span>
          <span>The deep privacy check didn’t run — review the body carefully before submitting.</span>
        </div>
      )}

      {card.errorMessage && (
        <div className="flex items-start gap-1.5 text-(--color-error)">
          <span className="shrink-0 mt-0.5">
            <WarningIcon size={ICON_SIZE.XS} weight="fill" />
          </span>
          <span>{card.errorMessage}</span>
        </div>
      )}

      <div className="text-(--color-text-tertiary) text-[11px]">
        Filed as {card.filedAs ? `@${card.filedAs}` : "your GitHub account"} · public on the ShipIt
        repo. Nothing is sent until you click Submit.
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="md" onClick={handleDismiss} disabled={isFiling}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSubmit}
          disabled={isFiling || !title.trim() || !body.trim()}
        >
          {isFiling ? "Filing…" : "Submit report"}
        </Button>
      </div>
    </div>
  );
}
