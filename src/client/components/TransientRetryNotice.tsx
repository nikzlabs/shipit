/**
 * docs/342-transient-provider-retry reqs 9-11 — while ShipIt waits to continue a session after
 * a temporary provider error, no turn runs, so there is no Stop button; this is the cancel.
 * Same card treatment and placement as `RepoTrustNotice`, a sibling of MessageInput in App.tsx.
 */

// eslint-disable-next-line no-restricted-imports -- useEffect: setInterval lifecycle for the countdown (external timer sync)
import { useEffect, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useApi } from "../hooks/useApi.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { Button } from "./ui/button.js";

export function waitText(msLeft: number): string {
  if (msLeft <= 0) return "now";
  const seconds = Math.ceil(msLeft / 1000);
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `in ${minutes} min` : `in ${minutes} min ${rest} s`;
}

/**
 * `rowRetryAt` is the displayed session's row as loaded (App's `bannerSession`); a later
 * `session_transient_retry` event overrides it.
 */
export function TransientRetryNotice({ sessionId, rowRetryAt }: { sessionId: string; rowRetryAt: string | undefined }) {
  const fromEvent = useSessionStore((s) => s.transientRetries[sessionId]);
  const retryAt = fromEvent === undefined ? rowRetryAt : (fromEvent ?? undefined);
  const { post } = useApi();
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- the countdown's clock (external timer sync)
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

  if (!retryAt) return null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/agent/transient-retry/cancel`);
      // Either way nothing waits now; the broadcast would say the same, if it arrives.
      useSessionStore.getState().setTransientRetryAt(sessionId, undefined);
    } catch {
      useUiStore.getState().setToast({ message: "The automatic continuation could not be cancelled. Try again." });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      className="mx-4 mb-2 rounded-xl border border-(--color-border-primary) bg-(--color-bg-secondary)/20 px-4 py-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-2"
      role="status"
      data-testid="transient-retry-notice"
    >
      <span className="flex items-start gap-1.5 text-xs text-center text-(--color-text-secondary)">
        <ArrowClockwiseIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
        <span>
          The model provider had a temporary error. ShipIt will ask the agent to continue{" "}
          {waitText(Date.parse(retryAt) - now)}.
        </span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void cancel()}
        disabled={cancelling}
        data-testid="transient-retry-notice-cancel"
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </Button>
    </div>
  );
}
