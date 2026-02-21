import { useState, useEffect, useRef, useCallback } from "react";
import { formatErrorForMessage } from "../components/PreviewFrame.js";
import type { PreviewError } from "./usePreviewErrors.js";
import type { WsClientMessage } from "../../server/types.js";
import type { ChatMessage } from "../components/MessageList.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { useApi } from "./useApi.js";

export function useAutoFix(params: {
  previewErrors: PreviewError[];
  isLoading: boolean;
  status: string;
  send: (msg: WsClientMessage) => void;
  sessionIdRef: MutableRefObject<string | undefined>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setActivity: Dispatch<SetStateAction<StreamingActivity | undefined>>;
}) {
  const { previewErrors, isLoading, status, send, sessionIdRef, setMessages, setIsLoading, setActivity } = params;
  const { post: apiPost } = useApi();

  const [autoFixEnabled, setAutoFixEnabled] = useState(false);
  const autoFixRetriesRef = useRef(0);
  const [autoFixRetries, setAutoFixRetries] = useState(0);
  const autoFixCooldownRef = useRef(false);
  const autoFixErrorSignatureRef = useRef<string | null>(null);

  // Forward preview errors to the server for terminal log relay
  useEffect(() => {
    if (previewErrors.length === 0 || status !== "open" || !sessionIdRef.current) return;
    // Send the latest error to the server
    const latest = previewErrors[previewErrors.length - 1];
    apiPost(`/api/sessions/${sessionIdRef.current}/preview-errors`, {
      message: latest.message,
      stack: latest.stack,
    }).catch(() => {});
  }, [previewErrors.length, status, apiPost, sessionIdRef, previewErrors]);

  const handleSendAutoFix = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: "user", text }]);
      setIsLoading(true);
      setActivity({ label: "Auto-fixing errors..." });
      send({
        type: "send_message",
        text,
        sessionId: sessionIdRef.current,
      });
    },
    [send, sessionIdRef, setMessages, setIsLoading, setActivity],
  );

  // Auto-fix: when new errors arrive while auto-fix is enabled and Claude is idle,
  // automatically send errors to Claude for fixing (with safety guardrails).
  const prevErrorCountRef = useRef(0);
  useEffect(() => {
    if (!autoFixEnabled || isLoading || previewErrors.length === 0) {
      prevErrorCountRef.current = previewErrors.length;
      return;
    }
    // Only trigger on new errors (count increased)
    if (previewErrors.length <= prevErrorCountRef.current) {
      return;
    }
    prevErrorCountRef.current = previewErrors.length;

    // Check retry limit
    if (autoFixRetriesRef.current >= 3) {
      setAutoFixEnabled(false);
      autoFixRetriesRef.current = 0;
      setAutoFixRetries(0);
      return;
    }

    // Check cooldown
    if (autoFixCooldownRef.current) return;

    // Build the error signature to detect same-error loops
    const sig = previewErrors.map((e) => e.message).join("|");
    if (sig === autoFixErrorSignatureRef.current) {
      autoFixRetriesRef.current += 1;
      setAutoFixRetries(autoFixRetriesRef.current);
    } else {
      autoFixRetriesRef.current = 1;
      setAutoFixRetries(1);
      autoFixErrorSignatureRef.current = sig;
    }

    // Apply 5s cooldown
    autoFixCooldownRef.current = true;
    const timer = setTimeout(() => {
      autoFixCooldownRef.current = false;
    }, 5000);

    // Send errors to Claude
    const text = formatErrorForMessage(previewErrors);
    handleSendAutoFix(text);

    return () => clearTimeout(timer);
  }, [previewErrors.length, autoFixEnabled, isLoading, previewErrors, handleSendAutoFix]);

  const handleToggleAutoFix = useCallback(() => {
    setAutoFixEnabled((prev) => {
      if (!prev) {
        // Enabling auto-fix: reset retry counter
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
    autoFixRetriesRef,
    handleToggleAutoFix,
    disableAutoFix,
  };
}
