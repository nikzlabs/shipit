// eslint-disable-next-line no-restricted-imports -- useEffect: setTimeout for disconnect delay with cleanup (timer-based side effect)
import { useEffect, useRef, useState } from "react";
import { CheckCircleIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { WsStatus } from "../hooks/useWebSocket.js";

/** Grace period before showing the disconnect banner (ms). */
const DISCONNECT_DELAY_MS = 1500;

/**
 * ConnectionBanner — compact inline status pill rendered inside the top bar
 * when the WebSocket connection is lost, reconnecting, or just restored.
 *
 * Designed to sit absolutely-positioned in the center of the header so its
 * appearance/disappearance does NOT shift surrounding layout. Brief reconnect
 * blips no longer push panels around.
 *
 * States:
 *   - "open" with no recent reconnection → hidden
 *   - "open" immediately after reconnection → green "Reconnected" pill (auto-hides)
 *   - "connecting" / "closed" after grace period → yellow/red pill
 *   - First page load (never connected) → hidden
 */
export function ConnectionBanner({
  status,
  reconnectAttempt = 0,
  onReconnect,
}: {
  status: WsStatus;
  reconnectAttempt?: number;
  onReconnect?: () => void;
}) {
  const prevStatusRef = useRef(status);
  const [showReconnected, setShowReconnected] = useState(false);
  // Whether the disconnect banner should be visible (after grace period).
  const [showDisconnect, setShowDisconnect] = useState(false);
  const hasConnectedRef = useRef(false);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "open") {
      hasConnectedRef.current = true;
      setShowDisconnect(false);

      // Show "Reconnected" flash only after a real disconnect
      if (prevStatus === "closed") {
        setShowReconnected(true);
        const timer = setTimeout(() => setShowReconnected(false), 3000);
        return () => clearTimeout(timer);
      }
      return;
    }

    // Connection dropped after having been open — start grace period
    if (hasConnectedRef.current) {
      const timer = setTimeout(() => setShowDisconnect(true), DISCONNECT_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Success flash — briefly shown after reconnection
  if (status === "open" && showReconnected) {
    return (
      <div
        role="status"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap bg-(--color-success-subtle) text-(--color-success) shadow-sm"
      >
        <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
        <span>Reconnected</span>
      </div>
    );
  }

  if (status === "open" || !showDisconnect) return null;

  const isConnecting = status === "connecting";

  return (
    <div
      role="alert"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap shadow-sm ${
        isConnecting
          ? "bg-(--color-warning-subtle) text-(--color-warning)"
          : "bg-(--color-error-subtle) text-(--color-error)"
      }`}
    >
      {isConnecting ? (
        <CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" />
      ) : (
        <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
      )}
      <span>
        {isConnecting
          ? "Reconnecting to server..."
          : `Connection lost — waiting to reconnect${reconnectAttempt > 1 ? ` (attempt ${reconnectAttempt})` : ""}...`}
      </span>
      {!isConnecting && onReconnect && (
        <button
          onClick={onReconnect}
          className="ml-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-(--color-error)/20 hover:bg-(--color-error)/30 text-(--color-error) transition-colors"
        >
          Reconnect now
        </button>
      )}
    </div>
  );
}
