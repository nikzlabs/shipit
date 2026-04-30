import { useState, useCallback } from "react";
import { CheckCircleIcon, PencilSimpleLineIcon } from "@phosphor-icons/react";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { ICON_SIZE } from "../design-tokens.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { MarkdownContent } from "./message-markdown.js";

interface PlanApprovalProps {
  onSend: (text: string) => void;
  disabled: boolean;
  planContent?: string;
}

export function PlanApproval({ onSend, disabled, planContent }: PlanApprovalProps) {
  const [submitted, setSubmitted] = useState<"accepted" | "feedback" | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  const handleAccept = useCallback(() => {
    if (disabled || submitted) return;
    // Switch this session out of plan mode so the follow-up message runs in
    // auto mode. Scope to the current session only — toggling plan mode here
    // must not affect other sessions.
    const sid = useSessionStore.getState().sessionId;
    useSettingsStore.getState().setPermissionMode(sid, "auto");
    setSubmitted("accepted");
    onSend("Execute the plan you just described.");
  }, [disabled, submitted, onSend]);

  const handleSendFeedback = useCallback(() => {
    if (disabled || submitted || !feedbackText.trim()) return;
    setSubmitted("feedback");
    onSend(feedbackText.trim());
  }, [disabled, submitted, feedbackText, onSend]);

  const isAnswered = !!submitted;

  // Read-only state after submission
  if (isAnswered) {
    return (
      <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3" data-testid="plan-approval">
        {submitted === "accepted" ? (
          <div className="flex items-center gap-2 text-sm text-(--color-success)">
            <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" />
            <span>Plan accepted — executing...</span>
          </div>
        ) : (
          <div className="text-sm">
            <span className="text-(--color-text-secondary)">Feedback sent:</span>
            <span className="ml-1 text-(--color-text-primary)">{feedbackText}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary)/80 overflow-hidden p-3" data-testid="plan-approval">
      {planContent && (
        <div className="mb-3 max-h-80 overflow-y-auto text-sm" data-testid="plan-content">
          <MarkdownContent text={planContent} />
        </div>
      )}
      <Badge variant="info" className="text-[10px] uppercase tracking-wider mb-1.5">
        Plan Ready
      </Badge>
      <p className="text-sm text-(--color-text-secondary) mb-3">
        Review the plan{planContent ? "" : " above"}, then accept or suggest changes.
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          onClick={handleAccept}
          disabled={disabled}
          data-testid="accept-plan"
        >
          <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" className="mr-1" />
          Accept &amp; Execute
        </Button>
        {!showFeedback && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => setShowFeedback(true)}
            disabled={disabled}
            data-testid="suggest-changes"
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
    </div>
  );
}
