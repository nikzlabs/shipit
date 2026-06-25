import { useState, useCallback } from "react";
import {
  ArrowsOutSimpleIcon,
  CheckCircleIcon,
  PencilSimpleLineIcon,
  ShieldCheckIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { ICON_SIZE } from "../design-tokens.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { MarkdownContent } from "./message-markdown.js";

interface PlanApprovalProps {
  onSend: (text: string) => void;
  disabled: boolean;
  planContent?: string;
  /**
   * True when the agent has already emitted a tool_result for this
   * ExitPlanMode call (i.e. the plan has been accepted or feedback was
   * already sent in a prior turn). Used to render the read-only
   * confirmation after a page reload, where the component's local
   * `submitted` state is gone but the tool_result is persisted in chat
   * history.
   */
  resolved?: boolean;
}

export function PlanApproval({ onSend, disabled, planContent, resolved }: PlanApprovalProps) {
  const [submitted, setSubmitted] = useState<"accepted" | "feedback" | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  // On a phone the inline plan card is a tiny scroll box. The expand button
  // opens a fullscreen dialog (the shared Dialog is fullscreen on mobile, see
  // ui/dialog.tsx) showing the whole plan with the action buttons pinned to
  // the bottom so they're always reachable.
  const [expanded, setExpanded] = useState(false);

  // docs/138 — offer "Approve in guarded mode" alongside the plain approve when
  // the active agent supports guarded. This mirrors Claude's own plan-approval
  // menu (a variant of the existing approve choice, not a new shell affordance).
  const agentList = useUiStore((s) => s.agentList);
  const activeAgentId = useUiStore((s) => s.activeAgentId);
  const guardedSupported = !!agentList
    .find((a) => a.id === activeAgentId)
    ?.supportedPermissionModes?.includes("guarded");

  const acceptInMode = useCallback(
    (mode: "auto" | "guarded") => {
      if (disabled || submitted) return;
      // Switch this session out of plan mode so the follow-up message runs in
      // the chosen execution mode. Scope to the current session only — toggling
      // mode here must not affect other sessions.
      const sid = useSessionStore.getState().sessionId;
      useSettingsStore.getState().setPermissionMode(sid, mode);
      setSubmitted("accepted");
      onSend("Execute the plan you just described.");
    },
    [disabled, submitted, onSend],
  );

  const handleAccept = useCallback(() => acceptInMode("auto"), [acceptInMode]);
  const handleAcceptGuarded = useCallback(() => acceptInMode("guarded"), [acceptInMode]);

  const handleSendFeedback = useCallback(() => {
    if (disabled || submitted || !feedbackText.trim()) return;
    setSubmitted("feedback");
    onSend(feedbackText.trim());
  }, [disabled, submitted, feedbackText, onSend]);

  // Treat the plan as answered if the user just submitted, OR if the
  // server-persisted tool_result indicates it's already resolved. Without
  // the latter case, a reloaded chat would show the action buttons for a
  // plan that's already been accepted, inviting a duplicate response.
  const isAnswered = !!submitted || !!resolved;

  // Read-only state after submission. When the local `submitted` state is
  // set we know which path the user took; on a reload we only know the
  // plan was resolved (via `resolved`), so we show a generic "Plan
  // resolved" line instead of guessing accept-vs-feedback.
  if (isAnswered) {
    return (
      <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3" data-testid="plan-approval">
        {submitted === "accepted" ? (
          <div className="flex items-center gap-2 text-sm text-(--color-success)">
            <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
            <span>Plan accepted — executing...</span>
          </div>
        ) : submitted === "feedback" ? (
          <div className="text-sm">
            <span className="text-(--color-text-secondary)">Feedback sent:</span>
            <span className="ml-1 text-(--color-text-primary)">{feedbackText}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-(--color-success)">
            <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
            <span>Plan resolved.</span>
          </div>
        )}
      </div>
    );
  }

  // The accept / guarded / suggest-changes controls plus the feedback input.
  // Shared verbatim between the inline card and the fullscreen dialog footer so
  // the two surfaces never drift. Only one of the two renders at a time (the
  // dialog mounts only while `expanded`), so there are never duplicate testids.
  const actionControls = (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={handleAccept}
          disabled={disabled}
          data-testid="accept-plan"
          className="w-full sm:w-auto"
        >
          <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" className="mr-1" />
          Accept &amp; Execute
        </Button>
        {guardedSupported && (
          <Button
            variant="ghost"
            size="md"
            onClick={handleAcceptGuarded}
            disabled={disabled}
            data-testid="accept-plan-guarded"
            className="w-full sm:w-auto"
          >
            <ShieldCheckIcon size={ICON_SIZE.SM} weight="fill" className="mr-1" />
            Accept in Guarded Mode
          </Button>
        )}
        {!showFeedback && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => setShowFeedback(true)}
            disabled={disabled}
            data-testid="suggest-changes"
            className="w-full sm:w-auto"
          >
            <PencilSimpleLineIcon size={ICON_SIZE.SM} className="mr-1" />
            Suggest Changes
          </Button>
        )}
      </div>

      {showFeedback && (
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && feedbackText.trim()) {
                handleSendFeedback();
              }
            }}
            placeholder="Describe what to change..."
            className="flex-1 rounded-md bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-1.5 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) focus:outline-none focus:border-(--color-border-focus)"
            data-testid="feedback-input"
            autoFocus
            disabled={disabled}
          />
          <Button
            variant="primary"
            size="md"
            onClick={handleSendFeedback}
            disabled={disabled || !feedbackText.trim()}
            data-testid="send-feedback"
          >
            Send
          </Button>
        </div>
      )}
    </>
  );

  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3" data-testid="plan-approval">
      {planContent && (
        <div className="relative mb-3">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute top-1 right-1 z-10 p-1 rounded bg-(--color-bg-secondary)/90 text-(--color-text-secondary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors"
            aria-label="Expand plan"
            title="Expand plan"
            data-testid="expand-plan"
          >
            <ArrowsOutSimpleIcon size={ICON_SIZE.SM} />
          </button>
          <div className="max-h-80 overflow-y-auto text-sm pr-8" data-testid="plan-content">
            <MarkdownContent text={planContent} />
          </div>
        </div>
      )}
      <Badge variant="info" className="text-[10px] uppercase tracking-wider mb-1.5">
        Plan Ready
      </Badge>
      <p className="text-sm text-(--color-text-secondary) mb-3">
        Review the plan{planContent ? "" : " above"}, then accept or suggest changes.
      </p>

      {!expanded && actionControls}

      {expanded && (
        <Dialog open onOpenChange={(open) => { if (!open) setExpanded(false); }}>
          <DialogContent className="w-[90vw] max-w-2xl h-[85vh] flex flex-col p-0" data-testid="plan-expanded" hideClose>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-(--color-border-secondary) shrink-0">
              <DialogTitle className="text-sm font-medium">Plan</DialogTitle>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="p-1 rounded hover:bg-(--color-bg-hover) text-(--color-text-secondary) hover:text-(--color-text-primary) transition-colors"
                aria-label="Close"
              >
                <XIcon size={ICON_SIZE.MD} />
              </button>
            </div>
            {/* Scrollable plan content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-sm">
              <MarkdownContent text={planContent ?? ""} />
            </div>
            {/* Action buttons pinned to the bottom */}
            <div className="border-t border-(--color-border-secondary) px-5 py-3 shrink-0">
              {actionControls}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
