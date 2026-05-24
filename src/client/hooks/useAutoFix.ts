// eslint-disable-next-line no-restricted-imports -- useEffect: relay errors to server API, auto-fix timer with cooldown/retry (external system sync + cleanup)
import { useEffect, useRef, useCallback } from "react";
import { formatErrorForMessage } from "../components/PreviewFrame.js";
import type { PreviewError } from "./usePreviewErrors.js";
import { useApi } from "./useApi.js";
import { useSessionStore } from "../stores/session-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { dispatchAgentMessage } from "../utils/dispatch-agent-message.js";

export function useAutoFix(params: {
  previewErrors: PreviewError[];
  isLoading: boolean;
  status: string;
}) {
  const { previewErrors, isLoading, status } = params;
  const { post: apiPost } = useApi();

  const autoFixEnabled = usePreviewStore((s) => s.autoFixEnabled);
  const autoFixRetries = usePreviewStore((s) => s.autoFixRetries);
  const autoFixRetriesRef = useRef(0);
  const autoFixCooldownRef = useRef(false);
  const autoFixErrorSignatureRef = useRef<string | null>(null);

  // Forward preview errors to the server for terminal log relay
  // eslint-disable-next-line no-restricted-syntax -- existing usage
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
      const sid = useSessionStore.getState().sessionId;
      if (!sid) return;
      // docs/150 — auto-fix POSTs to the dispatch route, same as the manual
      // "Send to Agent" button. `requestPermission` is intentionally NOT
      // called here (auto-fire shouldn't pop a notification prompt at the
      // user out of nowhere — preserves the asymmetry of the previous WS
      // path, which also skipped it).
      void dispatchAgentMessage({
        sessionId: sid,
        text,
        activity: "Fixing preview errors…",
        apiPost,
      }).catch(() => { /* helper surfaces toast */ });
    },
    [apiPost],
  );

  // Auto-fix logic
  const prevErrorCountRef = useRef(0);
  // eslint-disable-next-line no-restricted-syntax -- existing usage
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
      usePreviewStore.getState().disableAutoFix();
      autoFixRetriesRef.current = 0;
      return;
    }

    if (autoFixCooldownRef.current) return;

    const sig = previewErrors.map((e) => e.message).join("|");
    if (sig === autoFixErrorSignatureRef.current) {
      autoFixRetriesRef.current += 1;
      usePreviewStore.getState().setAutoFixRetries(autoFixRetriesRef.current);
    } else {
      autoFixRetriesRef.current = 1;
      usePreviewStore.getState().setAutoFixRetries(1);
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
    const store = usePreviewStore.getState();
    if (!store.autoFixEnabled) {
      autoFixRetriesRef.current = 0;
      autoFixErrorSignatureRef.current = null;
      autoFixCooldownRef.current = false;
    }
    store.toggleAutoFix();
  }, []);

  const disableAutoFix = useCallback(() => {
    usePreviewStore.getState().disableAutoFix();
    autoFixRetriesRef.current = 0;
  }, []);

  return {
    autoFixEnabled,
    autoFixRetries,
    handleToggleAutoFix,
    disableAutoFix,
  };
}
