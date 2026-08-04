/**
 * SubagentCall — renders a Task tool invocation as a collapsible nested
 * message group showing the subagent's prompt, work timeline, and final
 * report. Replaces the legacy opaque "Task: <description>" line so users
 * can see what their subagents are actually doing. (109 — subagent
 * transparency)
 *
 * Disclosure layers:
 *   1. Header (always visible): description + status indicator
 *   2. Prompt (collapsed; click to expand): the prompt sent to the subagent.
 *      The transcript carries only its character count — a subagent prompt is
 *      routinely kilobytes and is behind a click, so docs/244's projection drops
 *      it and expanding fetches it (SHI-296).
 *   3. Subagent's work (collapsed; click to expand): nested tool calls in
 *      order, with a live action count on the toggle
 *   4. Final report (always visible when present): the markdown the
 *      subagent returned to the parent agent
 */

import { useState } from "react";
import { CaretRightIcon, RobotIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { ToolUseItem } from "./message-tools.js";
import { MarkdownContent } from "./message-markdown.js";
import { ToolSpinner } from "./StreamingIndicator.js";
import { useLazyToolInput } from "../hooks/useLazyToolInput.js";
import {
  groupEventsByParent,
  findSubagentFinalReport,
  parseSubagentReport,
  type SubagentStep,
} from "../utils/group-events-by-parent.js";
import type { ToolUseBlock, ToolResultBlock, SubagentEvent } from "./MessageList.js";

interface SubagentCallProps {
  /** The Task tool's tool_use block (carries the description and prompt). */
  tool: ToolUseBlock;
  /** All subagent events from the parent message (filtered internally by tool.id). */
  subagentEvents?: SubagentEvent[];
  /** Tool results from the parent message — used to find the final report. */
  parentToolResults?: ToolResultBlock[];
  /** True while the parent assistant message is still streaming. */
  isStreaming: boolean;
}

export function SubagentCall({ tool, subagentEvents, parentToolResults, isStreaming }: SubagentCallProps) {
  const description = (tool.input.description as string) ?? "Running task...";
  const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
  const subagentType = typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "";

  // Find this Task's nested events and final report. groupEventsByParent
  // handles filtering by parentToolUseId for us.
  const grouped = groupEventsByParent(subagentEvents);
  const tree = grouped.get(tool.id);
  const steps: SubagentStep[] = tree?.steps ?? [];
  const finalReport = findSubagentFinalReport(tool.id, parentToolResults);
  const report = finalReport ? parseSubagentReport(finalReport.content) : null;

  const [promptExpanded, setPromptExpanded] = useState(false);
  // docs/244 — the prompt may have been dropped on the serve path, leaving only
  // its length behind. The toggle's label is drawn from that length so the
  // header is identical either way; the body arrives when the user expands.
  const promptChars = typeof tool.inputChars?.prompt === "number" ? tool.inputChars.prompt : prompt.length;
  const promptDeferred = !prompt && promptChars > 0;
  const lazyPrompt = useLazyToolInput(tool.id, promptExpanded && promptDeferred);
  const fetchedPrompt = typeof lazyPrompt.input?.prompt === "string" ? lazyPrompt.input.prompt : "";
  const promptBody = prompt || fetchedPrompt;
  // "Work" is collapsed by default — while streaming AND after the final
  // report arrives. A subagent's timeline is long and mostly uninteresting to
  // the reader (it's the *parent's* conversation they're following), and two
  // or three concurrent subagents expanded at once bury the main transcript.
  // The toggle carries a live action count, so the collapsed state still
  // shows that something is happening; the caret opens it on demand. Earlier
  // revisions defaulted to expanded (and before that, auto-collapsed on the
  // final report) — both traded the transcript's readability for detail
  // nobody had asked to see yet.
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
        <StatusBadge inProgress={inProgress} isError={isError} hasReport={!!finalReport} />
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

      {/* Final report — always visible once present. Renders as markdown.
          The CLI wraps it in a JSON block array whenever it appends its own
          accounting footer, which is most of the time, so parse before
          rendering (SHI-287) — otherwise the user reads escaped JSON. */}
      {report && (
        <div data-testid="subagent-final-report" className="mt-1">
          <div className="text-xs text-(--color-text-tertiary) mb-1 uppercase tracking-wide">
            {isError ? "Subagent error" : "Final report"}
          </div>
          <div
            className={
              isError
                ? "text-sm text-(--color-error) bg-(--color-error-subtle) border border-(--color-error)/40 rounded p-2"
                : "text-sm text-(--color-text-primary)"
            }
          >
            <MarkdownContent text={report.text} />
          </div>
          {report.meta && (
            <div
              data-testid="subagent-report-meta"
              className="mt-1 text-xs text-(--color-text-tertiary) font-mono whitespace-pre-wrap leading-5"
            >
              {report.meta}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact disclosure caret + label + slot for content. */
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

/** Status indicator on the header — spinner / check / error. */
function StatusBadge({
  inProgress,
  isError,
  hasReport,
}: {
  inProgress: boolean;
  isError: boolean;
  hasReport: boolean;
}) {
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

/** Render a single step in the subagent's work timeline. */
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
    // Tool results render inline next to their tool calls (via resultsByToolId)
    // — we don't show a standalone bubble for them.
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

/** Build a map of toolUseId → result across all steps. */
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

/** Count the user-visible actions (assistant text or tool calls) in the timeline. */
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
