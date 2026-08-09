/**
 * NonTurnFailureCard — the notice ShipIt shows when the work it does *outside*
 * a turn fails: naming a session, writing a pull-request description
 * (docs/252 phase 7, req 9).
 *
 * Two properties the requirement fixes, and both are visible in this component:
 *
 *  - **The operation still completed.** The card leads with the fallback ("the
 *    session kept its placeholder title") rather than with an error, because
 *    nothing is broken from the user's side — background work failed and ShipIt
 *    carried on. It is a notice, not an alert.
 *  - **Dismissal is state, not removal.** Dismissing collapses the card to one
 *    muted line; it does not delete the row. A recurring failure therefore
 *    leaves a visible trail instead of looking like it never happened, and the
 *    state survives a reload because it is persisted server-side.
 *
 * Static payload otherwise — every value is baked onto the message row, so it
 * renders identically live and after a reload with no client store.
 */

import { useState } from "react";
import { CheckIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";

export interface NonTurnFailureCardProps {
  sessionId: string;
  cardId: string;
  purpose: "session-naming" | "pr-description";
  serviceName?: string;
  billingMode?: "sub" | "key";
  modelId?: string;
  /** True when the model came from the user's own pin rather than the derived default. */
  pinned?: boolean;
  fallback: string;
  detail?: string;
  dismissedAt?: string;
  /** Injectable for tests; defaults to the dismiss endpoint. */
  onDismiss?: (cardId: string) => void;
}

const PURPOSE_LABEL: Record<NonTurnFailureCardProps["purpose"], string> = {
  "session-naming": "Session naming",
  "pr-description": "Pull-request description",
};

const MODE_LABEL: Record<"sub" | "key", string> = {
  sub: "subscription",
  key: "API key",
};

export function NonTurnFailureCard({
  sessionId,
  cardId,
  purpose,
  serviceName,
  billingMode,
  modelId,
  pinned,
  fallback,
  detail,
  dismissedAt,
  onDismiss,
}: NonTurnFailureCardProps) {
  const [dismissed, setDismissed] = useState(!!dismissedAt);

  const dismiss = () => {
    setDismissed(true);
    if (onDismiss) {
      onDismiss(cardId);
      return;
    }
    void fetch(`/api/sessions/${sessionId}/non-turn-failure/${cardId}/dismiss`, { method: "POST" })
      .catch((err: unknown) => {
        // The card is already collapsed locally; a failed patch only means it
        // comes back expanded on the next reload, which is the safe direction.
        console.error("[non-turn-failure] dismiss failed:", err);
      });
  };

  if (dismissed) {
    return (
      <div
        data-testid="non-turn-failure-card"
        data-dismissed="true"
        className="flex items-center gap-1.5 text-[11px] text-(--color-text-tertiary) px-1 py-0.5"
      >
        <CheckIcon size={ICON_SIZE.XS} className="shrink-0" />
        <span>
          {PURPOSE_LABEL[purpose]} failed{serviceName ? ` on ${serviceName}` : ""} · dismissed
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="non-turn-failure-card"
      data-purpose={purpose}
      className="rounded-lg border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2.5 text-xs flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5 text-(--color-warning)">
          <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--color-text-primary) font-medium">
            {PURPOSE_LABEL[purpose]} failed
            {serviceName ? <> on <span className="font-normal">{serviceName}</span></> : null}
          </div>
          <div className="text-(--color-text-secondary) mt-0.5">{fallback}</div>
          {(modelId || billingMode) && (
            <div className="mt-1 text-[11px] text-(--color-text-tertiary)">
              {modelId && <span className="font-mono">{modelId}</span>}
              {modelId && billingMode ? " · " : ""}
              {billingMode && MODE_LABEL[billingMode]}
              {pinned
                ? " · chosen in Settings for background work"
                : " · ShipIt's default for background work"}
            </div>
          )}
          {detail && (
            <div className="mt-1.5 rounded border border-(--color-border-secondary) bg-(--color-bg-primary) px-2 py-1 text-[11px] text-(--color-text-tertiary) break-words">
              {detail}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          className="shrink-0 gap-1"
          aria-label="Dismiss this notice"
        >
          <XIcon size={ICON_SIZE.XS} />
          Dismiss
        </Button>
      </div>
    </div>
  );
}
