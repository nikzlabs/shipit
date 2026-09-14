import { ConnectionBannerPill, useConnectionBannerState } from "./ConnectionBanner.js";
import { UpdateAvailableBanner, updateNoticeVisible } from "./UpdateAvailableBanner.js";
import { useUiStore } from "../stores/ui-store.js";
import type { WsStatus } from "../hooks/useWebSocket.js";

/**
 * The top panel's one banner slot, in the two positions it has been iterated
 * into: absolutely centred in the header on desktop, a padded row under the
 * header on mobile (docs/304 req 2). Both occupants live here so neither can
 * drift away from that position.
 *
 * The connection state wins the slot: it is urgent, transient and self-clearing,
 * while an update has been available for days. The hook is called ONCE here —
 * mounting `ConnectionBanner` conditionally instead would restart its
 * disconnect delay on every mount, so the disconnect pill would never appear.
 */
export function TopPanelBanner({
  variant,
  showConnection,
  status,
  reconnectAttempt = 0,
  onReconnect,
}: {
  variant: "desktop" | "mobile";
  /** Whether the connection occupant is relevant here (it reports on a session). */
  showConnection: boolean;
  status: WsStatus;
  reconnectAttempt?: number;
  onReconnect?: () => void;
}) {
  const connection = useConnectionBannerState(status);
  const hasUpdate = useUiStore((s) => updateNoticeVisible(s.updateNotice));
  const compact = variant === "mobile";

  // The mobile wrapper reserves its padding for the whole time a connection
  // could be reported, exactly as it did before this slot gained a second
  // occupant — dropping it while connected would shift the chat by its padding.
  // A screen that never had the row only grows one when there is an update.
  if (!showConnection && !hasUpdate) return null;

  const content = showConnection && connection
    ? (
        <ConnectionBannerPill
          state={connection}
          reconnectAttempt={reconnectAttempt}
          compact={compact}
          {...(onReconnect ? { onReconnect } : {})}
        />
      )
    : <UpdateAvailableBanner compact={compact} />;

  if (variant === "mobile") {
    return (
      <div className="relative z-30 flex justify-center px-3 py-1.5 bg-(--color-bg-primary) pointer-events-none">
        <div className="pointer-events-auto max-w-full">{content}</div>
      </div>
    );
  }

  return (
    <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 max-w-[60vw] pointer-events-none flex justify-center">
      <div className="pointer-events-auto">{content}</div>
    </div>
  );
}
