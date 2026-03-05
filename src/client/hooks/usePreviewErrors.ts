import { useState, useEffect, useCallback, useRef } from "react";

export interface PreviewError {
  id: string;
  type: "error" | "console";
  level?: "error" | "warn";
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  timestamp: string;
}

/** Maximum number of errors to keep in the rolling buffer. */
const MAX_ERRORS = 50;

/** Time window in ms for deduplication — same error within this window is dropped. */
const DEDUP_WINDOW_MS = 1000;

/**
 * Build a dedup key from an error's core fields so rapid-fire identical errors
 * are collapsed into one.
 */
function dedupKey(type: string, message: string, source?: string, line?: number): string {
  return `${type}:${message}:${source ?? ""}:${line ?? ""}`;
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

export interface UsePreviewErrorsReturn {
  errors: PreviewError[];
  clearErrors: () => void;
  hasErrors: boolean;
  errorCount: number;
}

/**
 * Hook that listens for `postMessage` events from the preview iframe's
 * error-capture script. Deduplicates rapid-fire errors and maintains
 * a rolling buffer of up to MAX_ERRORS entries.
 */
export function usePreviewErrors(): UsePreviewErrorsReturn {
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const recentKeysRef = useRef<Map<string, number>>(new Map());
  const idCounterRef = useRef(0);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as PostMessageData | undefined;
      if (data?.source !== "shipit-preview") return;

      let errorEntry: PreviewError | null = null;

      if (data.type === "error") {
        const msg = data.message ?? "Unknown error";
        const fileSrc = data.fileSrc;
        const key = dedupKey("error", msg, fileSrc, data.line);
        const now = Date.now();
        const lastSeen = recentKeysRef.current.get(key);
        if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
          return; // Deduplicate
        }
        recentKeysRef.current.set(key, now);

        errorEntry = {
          id: `pe-${++idCounterRef.current}`,
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
        const key = dedupKey("console", msg);
        const now = Date.now();
        const lastSeen = recentKeysRef.current.get(key);
        if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
          return;
        }
        recentKeysRef.current.set(key, now);

        errorEntry = {
          id: `pe-${++idCounterRef.current}`,
          type: "console",
          level: data.level,
          message: msg,
          timestamp: new Date().toISOString(),
        };
      }

      if (errorEntry) {
        setErrors((prev) => {
          const next = [...prev, errorEntry];
          return next.length > MAX_ERRORS ? next.slice(-MAX_ERRORS) : next;
        });
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Clean up old dedup keys periodically to prevent memory leaks
  useEffect(() => {
    const cleanup = setInterval(() => {
      const now = Date.now();
      const keys = recentKeysRef.current;
      for (const [key, ts] of keys) {
        if (now - ts > DEDUP_WINDOW_MS * 2) {
          keys.delete(key);
        }
      }
    }, 5000);
    return () => clearInterval(cleanup);
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
    recentKeysRef.current.clear();
  }, []);

  return {
    errors,
    clearErrors,
    hasErrors: errors.length > 0,
    errorCount: errors.length,
  };
}
