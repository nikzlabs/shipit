

import {
  ArrowSquareOutIcon,
  ChatCircleTextIcon,
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

  relation: "child" | "sibling" | "parent" | "proposed";
  /** A report has one. Without it the card shows a message from another session. */
  severity?: "fyi" | "warn" | "blocker";
  subject?: string;
  body: string;

  onOpen?: (fromSessionId: string) => void;
}

const SEVERITY_STYLE = {
  fyi: { color: "text-(--color-text-tertiary)", label: "Report" },
  warn: { color: "text-(--color-warning)", label: "Report — heads up" },
  blocker: { color: "text-(--color-error)", label: "Report — blocker" },
} as const;

const MESSAGE_STYLE = { color: "text-(--color-text-tertiary)", label: "Message" } as const;

const SENDER: Record<SessionReportCardProps["relation"], string> = {
  child: "a child session",
  sibling: "a sibling session",
  parent: "the parent session",
  proposed: "another session, approved by you",
};

function SeverityIcon({ severity }: { severity: SessionReportCardProps["severity"] }) {
  if (severity === "blocker") return <WarningOctagonIcon size={ICON_SIZE.SM} weight="fill" />;
  if (severity === "warn") return <WarningIcon size={ICON_SIZE.SM} weight="fill" />;
  if (severity === "fyi") return <MegaphoneIcon size={ICON_SIZE.SM} weight="fill" />;
  return <ChatCircleTextIcon size={ICON_SIZE.SM} weight="fill" />;
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
  const style = severity ? SEVERITY_STYLE[severity] : MESSAGE_STYLE;

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
      data-severity={severity ?? "message"}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 ${style.color}`}>
          <SeverityIcon severity={severity} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-tertiary) text-[10px] uppercase tracking-wide font-medium">
            {style.label} · from {SENDER[relation]}
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
          aria-label={`Open ${severity ? "reporting" : "sending"} session ${fromTitle}`}
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
        <span>In this session's inbox, where its agent reads it.</span>
      </div>
    </div>
  );
}
