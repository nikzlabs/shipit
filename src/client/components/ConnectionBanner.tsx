// eslint-disable-next-line no-restricted-imports -- useEffect: setTimeout for disconnect delay with cleanup (timer-based side effect)
import { useEffect, useRef, useState } from "react";
import { Spinner } from "./Spinner.js";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { WsStatus } from "../hooks/useWebSocket.js";

const DISCONNECT_DELAY_MS = 1500;

export type ConnectionBannerState = "reconnected" | "connecting" | "lost";

/**
 * Whether the connection pill should be showing, and as what. Owns the 1.5 s
 * delay before a disconnect is announced and the 3 s "Reconnected" flash, so a
 * caller that shares the slot (`TopPanelBanner`) can ask once rather than
 * mounting a second copy whose timers would start from scratch.
 */
export function useConnectionBannerState(status: WsStatus): ConnectionBannerState | null {
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

  if (status === "open") return showReconnected ? "reconnected" : null;
  if (!showDisconnect) return null;
  return status === "connecting" ? "connecting" : "lost";
}

export function ConnectionBannerPill({
  state,
  reconnectAttempt = 0,
  onReconnect,
  compact = false,
}: {
  state: ConnectionBannerState;
  reconnectAttempt?: number;
  onReconnect?: () => void;
  compact?: boolean;
}) {
  if (state === "reconnected") {
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

  const isConnecting = state === "connecting";

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

