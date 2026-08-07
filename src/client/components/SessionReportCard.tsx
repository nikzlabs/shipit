/**
 * SessionReportCard — in-chat affordance surfaced into a session when another
 * session in its cohort pushes a report with `shipit session report`
 * (docs/233 / planning#243).
 *
 * Session coordination used to run one way (parent → child), so a child that
 * found something affecting its parent or its siblings had nowhere to put it.
 * This card is the human-facing half of the fix: the machine-facing half is a
 * queued system turn carrying the same text into the recipient's agent.
 *
 * Three tones keyed off `severity`: `fyi` (neutral), `warn`, and `blocker`
 * (danger) — the same ladder the wake-turn uses, so what the user sees and what
 * the agent was told to do about it can't drift.
 *
 * Static card: every value is a baked-in prop (persisted on the message row), so
 * it renders identically live and after a reload with no client store. "Open"
 * switches the active session to the reporter.
 */

import {
  ArrowSquareOutIcon,
  GitBranchIcon,
  InfoIcon,
  MegaphoneIcon,
  WarningIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useSessionStore } from "../stores/session-store.js";

export interface SessionReportCardProps {
  fromSessionId: string;
  fromTitle: string;
  fromBranch?: string;
  /** How the reporter relates to THIS session — drives the header copy. */
  relation: "child" | "sibling";
  severity: "fyi" | "warn" | "blocker";
  subject?: string;
  body: string;
  /** Optional navigation override; falls back to the session store (test-friendly). */
  onOpen?: (fromSessionId: string) => void;
}

/** Per-severity icon, accent color, and header label. */
const SEVERITY_STYLE = {
  fyi: { color: "text-(--color-text-tertiary)", label: "Report" },
  warn: { color: "text-(--color-warning)", label: "Report — heads up" },
  blocker: { color: "text-(--color-error)", label: "Report — blocker" },
} as const;

function SeverityIcon({ severity }: { severity: SessionReportCardProps["severity"] }) {
  if (severity === "blocker") return <WarningOctagonIcon size={ICON_SIZE.SM} weight="fill" />;
  if (severity === "warn") return <WarningIcon size={ICON_SIZE.SM} weight="fill" />;
  return <MegaphoneIcon size={ICON_SIZE.SM} weight="fill" />;
}

export function SessionReportCard({
  fromSessionId,
  fromTitle,
  fromBranch,
  relation,
  severity,
  subject,
  body,
  onOpen,
}: SessionReportCardProps) {
  const reporterRow = useSessionStore((s) => s.sessions.find((row) => row.id === fromSessionId));
  const sessionMissing = !reporterRow;
  const style = SEVERITY_STYLE[severity];

  const handleOpen = () => {
    if (sessionMissing) return;
    if (onOpen) {
      onOpen(fromSessionId);
      return;
    }
    useSessionStore.getState().setSessionId(fromSessionId);
  };

  return (
    <div
      data-testid="session-report-card"
      data-severity={severity}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 ${style.color}`}>
          <SeverityIcon severity={severity} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            {style.label} · from {relation === "child" ? "a child session" : "a sibling session"}
          </div>
          <div className="text-(--color-text-primary) font-medium truncate" title={fromTitle}>
            {fromTitle}
          </div>
          {fromBranch && (
            <div className="mt-1 flex items-center gap-1 text-(--color-text-tertiary) text-[11px]">
              <GitBranchIcon size={ICON_SIZE.XS} className="shrink-0" />
              <span className="truncate font-mono" title={fromBranch}>{fromBranch}</span>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleOpen}
          disabled={sessionMissing}
          className="shrink-0 gap-1"
          aria-label={`Open reporting session ${fromTitle}`}
        >
          <ArrowSquareOutIcon size={ICON_SIZE.XS} />
          Open
        </Button>
      </div>

      <div className="rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1.5">
        {subject && (
          <div className="text-(--color-text-primary) text-[11px] font-medium mb-1">{subject}</div>
        )}
        <div className="text-(--color-text-secondary) text-[11px] whitespace-pre-wrap break-words">
          {body}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary)">
        <InfoIcon size={ICON_SIZE.XS} className="shrink-0" />
        <span>Delivered to this session's agent as a queued turn.</span>
      </div>
    </div>
  );
}
