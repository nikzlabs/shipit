/**
 * BugReportCard — inline consent card for filing a ShipIt bug (docs/164).
 *
 * Rendered at the chat-history position where the agent's `report_shipit_bug`
 * tool landed. Shows the EXACT redacted payload the user is about to file: an
 * editable title and a single editable body (WYSIWYG — what's in the box is
 * what gets posted). Nothing is sent until the user clicks "Submit report".
 *
 * The body is load-bearing for consent: the redacted transcript, evidence, and
 * the build/source footer are all pre-filled into the one editable field, so
 * if the user spots a redaction miss they delete it right here before
 * submitting. The author identity (`@you`) is the one thing NOT in the body —
 * it's inherent to filing as the user, shown for transparency.
 *
 * Lifecycle (from the bug-report store, keyed by cardId): draft → filing →
 * filed | (failed drops back to draft with an error banner so the user can fix
 * their token / edit and retry).
 */

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
}

/**
 * Augment the server-stamped footer with coarse, client-only browser context
 * (UA family + viewport). The server can't know these — they live only in the
 * browser — so we splice them into the editable body on first render. Coarse
 * by design: no fingerprinting, and the user can edit or delete the line.
 */
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
  // Append to the server's "Filed via ShipIt · build … · source …" line.
  return body.replace(
    /^(Filed via ShipIt · build .+? · source \S+)$/m,
    `$1 · ${family} ${viewport}`,
  );
}

export function BugReportCard({ cardId, onSubmit }: BugReportCardProps) {
  const card = useBugReportStore((s) => s.cards[cardId]);
  const setFiling = useBugReportStore((s) => s.setFiling);

  // Local editable copies, seeded once from the store payload.
  const [title, setTitle] = useState(() => card?.title ?? "");
  const [body, setBody] = useState(() => augmentBodyWithBrowser(card?.body ?? ""));
  // Cancel discards locally — nothing was ever sent, so there's no server
  // round-trip; we just collapse the card so the user can't submit it.
  const [dismissed, setDismissed] = useState(false);

  if (!card) return null;

  if (dismissed && card.phase !== "filed") {
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

  // ── Terminal success ──
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
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)} disabled={isFiling}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={isFiling || !title.trim() || !body.trim()}
        >
          {isFiling ? "Filing…" : "Submit report"}
        </Button>
      </div>
    </div>
  );
}
