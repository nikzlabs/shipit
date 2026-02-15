import type { WsStatus } from "../hooks/useWebSocket.js";

/**
 * ConnectionBanner — full-width banner shown when the WebSocket connection
 * is lost or reconnecting. Provides clear visual feedback so users know
 * their messages won't be delivered until the connection is restored.
 *
 * Only renders when status is "closed" or "connecting" (not "open").
 */
export function ConnectionBanner({ status }: { status: WsStatus }) {
  if (status === "open") return null;

  const isConnecting = status === "connecting";

  return (
    <div
      role="alert"
      className={`px-4 py-2 text-xs text-center font-medium ${
        isConnecting
          ? "bg-yellow-900/70 text-yellow-200"
          : "bg-red-900/70 text-red-200"
      }`}
    >
      {isConnecting
        ? "Reconnecting to server..."
        : "Connection lost — waiting to reconnect..."}
    </div>
  );
}
