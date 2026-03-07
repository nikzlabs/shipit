import { CheckCircleIcon, CircleNotchIcon, CircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { StartupStep } from "../stores/preview-store.js";

const STEP_LABELS: Record<string, string> = {
  fetch: "Fetching latest changes",
  install: "Installing dependencies",
  dev_server: "Starting dev server",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StepIcon({ status }: { status: StartupStep["status"] }) {
  switch (status) {
    case "complete":
      return <CheckCircleIcon size={ICON_SIZE.SM} weight="fill" className="text-emerald-400 shrink-0" />;
    case "running":
      return <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin text-(--color-accent) shrink-0" />;
    case "error":
      return <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" className="text-orange-400 shrink-0" />;
    default:
      return <CircleIcon size={ICON_SIZE.SM} className="text-(--color-text-tertiary) shrink-0" />;
  }
}

export function StartupSteps({ steps }: { steps: StartupStep[] }) {
  return (
    <div className="w-full max-w-sm space-y-1.5">
      {steps.map((step) => (
        <div key={step.stepId}>
          {/* Step row */}
          <div className="flex items-center gap-2 text-sm">
            <StepIcon status={step.status} />
            <span className={step.status === "pending" ? "text-(--color-text-tertiary)" : "text-(--color-text-primary)"}>
              {STEP_LABELS[step.stepId] ?? step.stepId}
              {step.status === "running" && "..."}
            </span>
            <span className="ml-auto text-xs text-(--color-text-tertiary) tabular-nums">
              {step.status === "complete" && step.durationMs !== undefined && `(${formatDuration(step.durationMs)})`}
            </span>
          </div>

          {/* Error message */}
          {step.status === "error" && step.message && (
            <p className="ml-6 mt-0.5 text-xs text-orange-400">{step.message}</p>
          )}

          {/* Log lines */}
          {step.logLines.length > 0 && (step.status === "running" || step.status === "error") && (
            <pre className="ml-6 mt-1 text-[10px] leading-tight text-(--color-text-tertiary) bg-(--color-bg-tertiary) rounded px-2 py-1.5 max-h-[5lh] overflow-hidden font-mono whitespace-pre-wrap break-all">
              {step.logLines.join("\n")}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
