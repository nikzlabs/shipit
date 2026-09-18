import {
  usePreviewStore,
  checkDuplicate,
  nextErrorId,
  type PreviewError,
} from "../stores/preview-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useEventListener } from "./useEventListener.js";

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

  fileSrc?: string;
  level?: string;
  args?: string[];
  line?: number;
  col?: number;
  stack?: string;
}

function extractSessionIdFromOrigin(origin: string): string | null {
  try {
    const hostname = new URL(origin).hostname;
    const match = /^(.+?)--\d+\./.exec(hostname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function usePreviewErrors(): UsePreviewErrorsReturn {
  const errors = usePreviewStore((s) => s.errors);
  const clearErrors = usePreviewStore((s) => s.clearErrors);
  const addError = usePreviewStore((s) => s.addError);

  useEventListener(window, "message", (event) => {
    const data = event.data as PostMessageData | undefined;
    if (data?.source !== "shipit-preview") return;

    const originSessionId = extractSessionIdFromOrigin(event.origin);
    if (originSessionId) {
      const activeSessionId = useSessionStore.getState().sessionId;
      if (activeSessionId && originSessionId !== activeSessionId) return;
    }

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
  });

  return {
    errors,
    clearErrors,
    hasErrors: errors.length > 0,
    errorCount: errors.length,
  };
}
