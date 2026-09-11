

import { useState } from "react";
import { CaretRightIcon, RobotIcon, CheckCircleIcon, WarningCircleIcon, ClockIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { ToolUseItem } from "./message-tools.js";
import { SubagentReport } from "./SubagentReport.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { useLazyToolInput } from "../hooks/useLazyToolInput.js";
import {
  groupEventsByParent,
  findSubagentFinalReport,
  parseSubagentReport,
  isBackgroundLaunchAck,
  type SubagentStep,
} from "../utils/group-events-by-parent.js";
import type { ToolUseBlock, ToolResultBlock, SubagentEvent } from "./MessageList.js";

interface SubagentCallProps {

  tool: ToolUseBlock;

  subagentEvents?: SubagentEvent[];

  parentToolResults?: ToolResultBlock[];

  isStreaming: boolean;
}

export function SubagentCall({ tool, subagentEvents, parentToolResults, isStreaming }: SubagentCallProps) {
  const description = (tool.input.description as string) ?? "Running task...";
  const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
  const subagentType = typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "";

  const grouped = groupEventsByParent(subagentEvents);
  const tree = grouped.get(tool.id);
  const steps: SubagentStep[] = tree?.steps ?? [];
  const finalReport = findSubagentFinalReport(tool.id, parentToolResults);

  // because a result block arriving is otherwise the whole definition of done.
  const backgrounded = !!finalReport
    && !finalReport.isError
    && isBackgroundLaunchAck(parseSubagentReport(finalReport.content).text);

  const [promptExpanded, setPromptExpanded] = useState(false);

  const promptChars = typeof tool.inputChars?.prompt === "number" ? tool.inputChars.prompt : prompt.length;
  const promptDeferred = !prompt && promptChars > 0;
  const lazyPrompt = useLazyToolInput(tool.id, promptExpanded && promptDeferred);
  const fetchedPrompt = typeof lazyPrompt.input?.prompt === "string" ? lazyPrompt.input.prompt : "";
  const promptBody = prompt || fetchedPrompt;

  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const workExpanded = userOverride ?? false;

  const isError = finalReport?.isError ?? false;
  const inProgress = !finalReport && isStreaming;

  return (
    <div data-testid="subagent-call" className="border-l-2 border-(--color-success)/40 pl-3 space-y-1.5">
      {/* Header */}
      <div className="flex items-center gap-2 text-sm">
        <RobotIcon size={ICON_SIZE.SM} className="text-(--color-success)" />
        <span className="font-semibold text-(--color-success)">
          {subagentType ? `Subagent (${subagentType})` : "Subagent"}:
        </span>
        <span className="text-(--color-text-primary)">{description}</span>
        <StatusBadge
          inProgress={inProgress}
          isError={isError}
          hasReport={!!finalReport}
          backgrounded={backgrounded}
        />
      </div>

      {/* Prompt — collapsed by default */}
      {promptChars > 0 && (
        <Disclosure
          label={`Prompt (${promptChars} chars)`}
          open={promptExpanded}
          onToggle={() => setPromptExpanded((v) => !v)}
          testId="subagent-prompt-toggle"
        >
          <div
            data-testid="subagent-prompt"
            className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap rounded bg-(--color-bg-secondary)/60 p-2 max-h-48 overflow-y-auto leading-5"
          >
            {promptBody || (lazyPrompt.error ? "Couldn't load this prompt." : "Loading prompt…")}
          </div>
        </Disclosure>
      )}

      {/* Subagent's work — collapsed by default; the action count ticks up
          live while the subagent runs. Click to toggle. */}
      {steps.length > 0 && (
        <Disclosure
          label={`Subagent's work (${countSteps(steps)} action${countSteps(steps) === 1 ? "" : "s"})`}
          open={workExpanded}
          onToggle={() => setUserOverride(!workExpanded)}
          testId="subagent-work-toggle"
        >
          <div
            data-testid="subagent-work"
            className="space-y-1 rounded bg-(--color-bg-secondary)/40 p-2"
          >
            {steps.map((step, idx) => (
              <SubagentStepView
                key={idx}
                step={step}
                resultsByToolId={collectToolResults(steps)}
                isLast={idx === steps.length - 1}
                isStreaming={inProgress}
              />
            ))}
          </div>
        </Disclosure>
      )}

      {/* Final report — panel, chips, clamp and modal all live in
          `SubagentReport` (docs/109 reqs 1–9). */}
      {finalReport && <SubagentReport result={finalReport} />}
    </div>
  );
}

function Disclosure({
  label,
  open,
  onToggle,
  testId,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        data-testid={testId}
        className="flex items-center gap-1 text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) transition-colors cursor-pointer"
      >
        <CaretRightIcon
          size={ICON_SIZE.XS}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span>{label}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

function StatusBadge({
  inProgress,
  isError,
  hasReport,
  backgrounded,
}: {
  inProgress: boolean;
  isError: boolean;
  hasReport: boolean;
  backgrounded: boolean;
}) {

  if (backgrounded) {
    return (
      <span data-testid="subagent-background" className="ml-auto flex items-center gap-1 text-xs text-(--color-warning)">
        <ClockIcon size={ICON_SIZE.XS} weight="fill" />
        <span>in background</span>
      </span>
    );
  }
  if (inProgress) {
    return (
      <span data-testid="subagent-running" className="ml-auto flex items-center gap-1 text-xs text-(--color-text-tertiary)">
        <ToolSpinner />
        <span>working...</span>
      </span>
    );
  }
  if (isError) {
    return (
      <span data-testid="subagent-failed" className="ml-auto flex items-center gap-1 text-xs text-(--color-error)">
        <WarningCircleIcon size={ICON_SIZE.XS} weight="fill" />
        <span>failed</span>
      </span>
    );
  }
  if (hasReport) {
    return (
      <span data-testid="subagent-done" className="ml-auto flex items-center gap-1 text-xs text-(--color-success)">
        <CheckCircleIcon size={ICON_SIZE.XS} weight="fill" />
        <span>done</span>
      </span>
    );
  }
  return null;
}

function SubagentStepView({
  step,
  resultsByToolId,
  isLast,
  isStreaming,
}: {
  step: SubagentStep;
  resultsByToolId: Map<string, ToolResultBlock>;
  isLast: boolean;
  isStreaming: boolean;
}) {
  if (step.kind === "tool_result") {

    return null;
  }
  return (
    <>
      {step.text && (
        <div className="text-xs text-(--color-text-secondary) whitespace-pre-wrap leading-5 px-1">
          {step.text}
        </div>
      )}
      {step.toolUse.map((t, i) => (
        <ToolUseItem
          key={t.id}
          tool={t}
          result={resultsByToolId.get(t.id)}
          isLast={isLast && i === step.toolUse.length - 1}
          isStreaming={isStreaming}
          isQuestionDisabled
        />
      ))}
    </>
  );
}

function collectToolResults(steps: SubagentStep[]): Map<string, ToolResultBlock> {
  const out = new Map<string, ToolResultBlock>();
  for (const step of steps) {
    if (step.kind === "tool_result") {
      for (const r of step.toolResults) {
        out.set(r.toolUseId, r);
      }
    }
  }
  return out;
}

function countSteps(steps: SubagentStep[]): number {
  let n = 0;
  for (const s of steps) {
    if (s.kind === "assistant") {
      if (s.text.trim()) n++;
      n += s.toolUse.length;
    }
  }
  return n;
}
