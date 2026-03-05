import { useState, useEffect, useRef, useCallback } from "react";
import { formatErrorForMessage } from "../components/PreviewFrame.js";
import type { PreviewError } from "./usePreviewErrors.js";
import type { WsClientMessage } from "../../server/shared/types.js";
import { useApi } from "./useApi.js";
import { useSessionStore } from "../stores/session-store.js";

export function useAutoFix(params: {
  previewErrors: PreviewError[];
  isLoading: boolean;
  status: string;
  send: (msg: WsClientMessage) => void;
}) {
  const { previewErrors, isLoading, status, send } = params;
  const { post: apiPost } = useApi();

  const [autoFixEnabled, setAutoFixEnabled] = useState(false);
  const autoFixRetriesRef = useRef(0);
  const [autoFixRetries, setAutoFixRetries] = useState(0);
  const autoFixCooldownRef = useRef(false);
  const autoFixErrorSignatureRef = useRef<string | null>(null);

  // Forward preview errors to the server for terminal log relay
  useEffect(() => {
    const sessionId = useSessionStore.getState().sessionId;
    if (previewErrors.length === 0 || status !== "open" || !sessionId) return;
    const latest = previewErrors[previewErrors.length - 1];
    apiPost(`/api/sessions/${sessionId}/preview-errors`, {
      message: latest.message,
      stack: latest.stack,
    }).catch((err: unknown) => console.warn("[preview-error-relay]", err));
  }, [previewErrors.length, status, apiPost, previewErrors]);

  const handleSendAutoFix = useCallback(
    (text: string) => {
      const session = useSessionStore.getState();
      session.setMessages((prev) => [...prev, { role: "user", text }]);
      session.setIsLoading(true);
      session.setActivity({ label: "Auto-fixing errors..." });
      send({
        type: "send_message",
        text,
        sessionId: useSessionStore.getState().sessionId,
      });
    },
    [send],
  );

  // Auto-fix logic
  const prevErrorCountRef = useRef(0);
  useEffect(() => {
    if (!autoFixEnabled || isLoading || previewErrors.length === 0) {
      prevErrorCountRef.current = previewErrors.length;
      return;
    }
    if (previewErrors.length <= prevErrorCountRef.current) {
      return;
    }
    prevErrorCountRef.current = previewErrors.length;

    if (autoFixRetriesRef.current >= 3) {
      setAutoFixEnabled(false);
      autoFixRetriesRef.current = 0;
      setAutoFixRetries(0);
      return;
    }

    if (autoFixCooldownRef.current) return;

    const sig = previewErrors.map((e) => e.message).join("|");
    if (sig === autoFixErrorSignatureRef.current) {
      autoFixRetriesRef.current += 1;
      setAutoFixRetries(autoFixRetriesRef.current);
    } else {
      autoFixRetriesRef.current = 1;
      setAutoFixRetries(1);
      autoFixErrorSignatureRef.current = sig;
    }

    autoFixCooldownRef.current = true;
    const timer = setTimeout(() => {
      autoFixCooldownRef.current = false;
    }, 5000);

    const text = formatErrorForMessage(previewErrors);
    handleSendAutoFix(text);

    return () => clearTimeout(timer);
  }, [previewErrors.length, autoFixEnabled, isLoading, previewErrors, handleSendAutoFix]);

  const handleToggleAutoFix = useCallback(() => {
    setAutoFixEnabled((prev) => {
      if (!prev) {
        autoFixRetriesRef.current = 0;
        setAutoFixRetries(0);
        autoFixErrorSignatureRef.current = null;
        autoFixCooldownRef.current = false;
      }
      return !prev;
    });
  }, []);

  const disableAutoFix = useCallback(() => {
    setAutoFixEnabled(false);
    autoFixRetriesRef.current = 0;
    setAutoFixRetries(0);
  }, []);

  return {
    autoFixEnabled,
    autoFixRetries,
    handleToggleAutoFix,
    disableAutoFix,
  };
}
