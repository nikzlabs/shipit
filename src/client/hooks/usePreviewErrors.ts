import { useEffect } from "react";
import {
  usePreviewStore,
  checkDuplicate,
  nextErrorId,
  type PreviewError,
} from "../stores/preview-store.js";

// Re-export for consumers that import the type from here.
export type { PreviewError } from "../stores/preview-store.js";

export interface UsePreviewErrorsReturn {
  errors: PreviewError[];
  clearErrors: () => void;
  hasErrors: boolean;
  errorCount: number;
}

interface PostMessageData {
  source?: string;
  type?: string;
  message?: string;
  /** File source URL from window.onerror — uses fileSrc to avoid collision with postMessage source identifier. */
  fileSrc?: string;
  level?: string;
  args?: string[];
  line?: number;
  col?: number;
  stack?: string;
}

/**
 * Hook that listens for `postMessage` events from the preview iframe's
 * error-capture script and writes errors into the Zustand preview store.
 * Deduplication and rolling-buffer logic live in the store.
 */
export function usePreviewErrors(): UsePreviewErrorsReturn {
  const errors = usePreviewStore((s) => s.errors);
  const clearErrors = usePreviewStore((s) => s.clearErrors);
  const addError = usePreviewStore((s) => s.addError);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as PostMessageData | undefined;
      if (data?.source !== "shipit-preview") return;

      let errorEntry: PreviewError | null = null;

      if (data.type === "error") {
        const msg = data.message ?? "Unknown error";
        const fileSrc = data.fileSrc;
        if (checkDuplicate("error", msg, fileSrc, data.line)) return;

        errorEntry = {
          id: nextErrorId(),
          type: "error",
          message: msg,
          source: fileSrc,
          line: data.line,
          col: data.col,
          stack: data.stack,
          timestamp: new Date().toISOString(),
        };
      }

      if (data.type === "console" && (data.level === "error" || data.level === "warn")) {
        const msg = data.args?.join(" ") ?? "";
        if (!msg) return;
        if (checkDuplicate("console", msg)) return;

        errorEntry = {
          id: nextErrorId(),
          type: "console",
          level: data.level,
          message: msg,
          timestamp: new Date().toISOString(),
        };
      }

      if (errorEntry) {
        addError(errorEntry);
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [addError]);

  return {
    errors,
    clearErrors,
    hasErrors: errors.length > 0,
    errorCount: errors.length,
  };
}
