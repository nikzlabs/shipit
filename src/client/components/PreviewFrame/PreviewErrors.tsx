import { Button } from "../ui/button.js";
import type { PreviewError } from "../../hooks/usePreviewErrors.js";

/** Formats captured preview errors into an agent-friendly prompt. */
export function formatErrorForMessage(errors: PreviewError[]): string {
  const lines = ["The preview is showing these errors:", ""];
  errors.forEach((err, i) => {
    lines.push(`${i + 1}. ${err.message}`);
    if (err.source && err.line) {
      lines.push(`   at ${err.source}:${err.line}${err.col ? `:${err.col}` : ""}`);
    } else if (err.stack) {
      // Take first line of stack after the message
      const stackLines = err.stack.split("\n").filter((l) => l.trim().startsWith("at "));
      if (stackLines.length > 0) {
        lines.push(`   ${stackLines[0].trim()}`);
      }
    }
    lines.push("");
  });
  lines.push("Please fix these errors.");
  return lines.join("\n");
}

interface PreviewErrorsProps {
  /** Captured preview errors from the iframe. */
  errors: PreviewError[];
  /** Send the given errors to the agent to fix. */
  onSendErrors: (errors: PreviewError[]) => void;
  /** Clear all errors. */
  onClearErrors: () => void;
}

/** Expandable panel listing captured preview errors with send-to-agent actions. */
export function PreviewErrors({ errors, onSendErrors, onClearErrors }: PreviewErrorsProps) {
  return (
    <div className="border-t border-(--color-error) bg-(--color-error-subtle) max-h-[40%] flex flex-col" role="region" aria-label="Preview errors">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-(--color-error) text-xs">
        <span className="font-medium text-(--color-error)">
          {errors.length} error{errors.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            onClick={() => onSendErrors(errors)}
            title="Send all errors to the agent for fixing"
          >
            Send to Agent
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={onClearErrors}
            className="text-(--color-error)"
            title="Clear all errors"
          >
            Clear
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-2 text-xs font-mono">
        {errors.map((err) => (
          <div key={err.id} className="p-2 rounded bg-(--color-error-subtle) border border-(--color-error)">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-(--color-text-primary) font-semibold break-all">
                  {err.type === "console" && err.level && (
                    <span className={`mr-1 ${err.level === "warn" ? "text-(--color-warning)" : ""}`}>
                      [{err.level}]
                    </span>
                  )}
                  {err.message}
                </div>
                {err.source && err.line && (
                  <div className="text-(--color-error) mt-0.5">
                    at {err.source}:{err.line}{err.col ? `:${err.col}` : ""}
                  </div>
                )}
                {err.stack && (
                  <details className="mt-1">
                    <summary className="text-(--color-error) cursor-pointer hover:text-(--color-text-primary)">
                      Stack trace
                    </summary>
                    <pre className="mt-1 text-[10px] text-(--color-error) whitespace-pre-wrap break-all overflow-auto max-h-24">
                      {err.stack}
                    </pre>
                  </details>
                )}
              </div>
              <Button
                variant="ghost"
                size="md"
                onClick={() => onSendErrors([err])}
                className="shrink-0 text-(--color-text-link)"
                title="Send this error to the agent"
              >
                Fix
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
