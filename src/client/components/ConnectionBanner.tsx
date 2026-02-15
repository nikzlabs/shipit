import { useEffect, useRef, useState } from "react";
import type { WsStatus } from "../hooks/useWebSocket.js";

/**
 * ConnectionBanner — full-width banner shown when the WebSocket connection
 * is lost, reconnecting, or has just been restored. Provides clear visual
 * feedback so users know their messages won't be delivered until the
 * connection is restored.
 *
 * States:
 *   - "open" with no recent reconnection → hidden
 *   - "open" immediately after reconnection → green "Reconnected" banner (auto-hides)
 *   - "connecting" → yellow "Reconnecting..." banner
 *   - "closed" → red "Connection lost" banner with attempt count & Reconnect button
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

  useEffect(() => {
    const wasDisconnected =
      prevStatusRef.current === "closed" || prevStatusRef.current === "connecting";
    prevStatusRef.current = status;

    if (wasDisconnected && status === "open") {
      setShowReconnected(true);
      const timer = setTimeout(() => setShowReconnected(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Success flash — briefly shown after reconnection
  if (status === "open" && showReconnected) {
    return (
      <div
        role="status"
        className="px-4 py-2 text-xs text-center font-medium bg-green-900/70 text-green-200"
      >
        Reconnected
      </div>
    );
  }

  if (status === "open") return null;

  const isConnecting = status === "connecting";

  return (
    <div
      role="alert"
      className={`px-4 py-2 text-xs text-center font-medium flex items-center justify-center gap-3 ${
        isConnecting
          ? "bg-yellow-900/70 text-yellow-200"
          : "bg-red-900/70 text-red-200"
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
          className="px-2 py-0.5 rounded text-xs font-medium bg-red-800 hover:bg-red-700 text-red-100 transition-colors"
        >
          Reconnect now
        </button>
      )}
    </div>
  );
}
