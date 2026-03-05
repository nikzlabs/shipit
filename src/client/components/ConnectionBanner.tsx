import { useEffect, useRef, useState } from "react";
import type { WsStatus } from "../hooks/useWebSocket.js";

/** Grace period before showing the disconnect banner (ms). */
const DISCONNECT_DELAY_MS = 1500;

/**
 * ConnectionBanner — full-width banner shown when the WebSocket connection
 * is lost, reconnecting, or has just been restored. Provides clear visual
 * feedback so users know their messages won't be delivered until the
 * connection is restored.
 *
 * States:
 *   - "open" with no recent reconnection → hidden
 *   - "open" immediately after reconnection → green "Reconnected" banner (auto-hides)
 *   - "connecting" / "closed" after grace period → yellow/red banner
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
        className="px-4 py-2 text-xs text-center font-medium bg-(--color-success-subtle) text-(--color-success)"
      >
        Reconnected
      </div>
    );
  }

  if (status === "open" || !showDisconnect) return null;

  const isConnecting = status === "connecting";

  return (
    <div
      role="alert"
      className={`px-4 py-2 text-xs text-center font-medium flex items-center justify-center gap-3 ${
        isConnecting
          ? "bg-(--color-warning-subtle) text-(--color-warning)"
          : "bg-(--color-error-subtle) text-(--color-error)"
      }`}
    >
      <span>
        {isConnecting
          ? "Reconnecting to server..."
          : `Connection lost — waiting to reconnect${reconnectAttempt > 1 ? ` (attempt ${reconnectAttempt})` : ""}...`}
      </span>
      {!isConnecting && onReconnect && (
        <button
          onClick={onReconnect}
          className="px-2 py-0.5 rounded text-xs font-medium bg-(--color-error)/20 hover:bg-(--color-error)/30 text-(--color-error) transition-colors"
        >
          Reconnect now
        </button>
      )}
    </div>
  );
}
