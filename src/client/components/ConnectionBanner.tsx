// eslint-disable-next-line no-restricted-imports -- useEffect: setTimeout for disconnect delay with cleanup (timer-based side effect)
import { useEffect, useRef, useState } from "react";
import { Spinner } from "./Spinner.js";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { WsStatus } from "../hooks/useWebSocket.js";

const DISCONNECT_DELAY_MS = 1500;

export function ConnectionBanner({
  status,
  reconnectAttempt = 0,
  onReconnect,
  compact = false,
}: {
  status: WsStatus;
  reconnectAttempt?: number;
  onReconnect?: () => void;
  compact?: boolean;
}) {
  const prevStatusRef = useRef(status);
  const [showReconnected, setShowReconnected] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const hasConnectedRef = useRef(false);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "open") {
      hasConnectedRef.current = true;
      setShowDisconnect(false);

      if (prevStatus === "closed") {
        setShowReconnected(true);
        const timer = setTimeout(() => setShowReconnected(false), 3000);
        return () => clearTimeout(timer);
      }
      return;
    }

    if (hasConnectedRef.current) {
      const timer = setTimeout(() => setShowDisconnect(true), DISCONNECT_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [status]);

  if (status === "open" && showReconnected) {
    return (
      <div
        role="status"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-(--color-success) bg-(--color-bg-elevated) text-xs font-medium whitespace-nowrap text-(--color-success) shadow-lg"
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-(--color-bg-elevated) text-xs font-medium whitespace-nowrap shadow-lg ${
        isConnecting
          ? "border-(--color-warning) text-(--color-warning)"
          : "border-(--color-error) text-(--color-error)"
      }`}
    >
      {isConnecting ? (
        <Spinner size={ICON_SIZE.XS} />
      ) : (
        <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
      )}
      <span>
        {isConnecting
          ? compact
            ? "Reconnecting…"
            : "Reconnecting to server..."
          : compact
            ? `Connection lost${reconnectAttempt > 1 ? ` (${reconnectAttempt})` : ""}`
            : `Connection lost — waiting to reconnect${reconnectAttempt > 1 ? ` (attempt ${reconnectAttempt})` : ""}...`}
      </span>
      {!isConnecting && onReconnect && (
        <button
          onClick={onReconnect}
          className="ml-0.5 px-1.5 py-0.5 rounded text-xs font-medium bg-(--color-error)/20 hover:bg-(--color-error)/30 text-(--color-error) transition-colors"
        >
          {compact ? "Reconnect" : "Reconnect now"}
        </button>
      )}
    </div>
  );
}
