import { ToolCallGroup, ToolUseItem } from "../message-tools.js";
import { MarkdownTooltip } from "../message-markdown.js";
import { SubagentCall } from "../SubagentCall.js";
import type { VisualElement } from "../visual-elements.js";
import type { ChatMessage } from "./types.js";

/**
 * Renders the three tool-derived visual-element kinds extracted from the message
 * stream by `buildVisualElements`: a grouped `tool-group`, a standalone
 * `subagent` (Task / Agent / Skill), and a `standalone-tool` (ExitPlanMode,
 * AskUserQuestion, present cards). The message-bubble kind stays in
 * `MessageList`. Moved verbatim from the old monolithic `MessageList.tsx`
 * render switch — no behavior change.
 */
export function MessageToolElement({
  el,
  messages,
  findPlanContent,
  onAnswerQuestion,
  onSendFollowUp,
}: {
  el: Extract<VisualElement, { kind: "tool-group" | "subagent" | "standalone-tool" }>;
  messages: ChatMessage[];
  findPlanContent: (exitPlanMsgIndex: number) => string | undefined;
  onAnswerQuestion?: (toolUseId: string, answers: Record<string, string>, text: string) => void;
  onSendFollowUp?: (text: string) => void;
}) {
  // ── Tool-group: grouped tool calls from consecutive assistant messages ──
  if (el.kind === "tool-group") {
    return (
      <div>
        <ToolCallGroup items={el.items} isStreaming={el.streaming} />
      </div>
    );
  }

  // ── Subagent: standalone Task/Skill/Agent element with left border ──
  if (el.kind === "subagent") {
    const tool = el.tool;
    const parentMsg = messages[el.messageIndex];
    if (tool.name === "Task") {
      // Full transparency view — prompt, work timeline, final report (109)
      return (
        <SubagentCall
          tool={tool}
          subagentEvents={parentMsg?.subagentEvents}
          parentToolResults={parentMsg?.toolResults}
          isStreaming={el.streaming}
        />
      );
    }
    if (tool.name === "Agent") {
      const description = (tool.input.description as string) ?? "Running agent...";
      const subagentType = typeof tool.input.subagent_type === "string" ? tool.input.subagent_type : "";
      const prompt = typeof tool.input.prompt === "string" ? tool.input.prompt : "";
      const label = subagentType ? `Agent (${subagentType}):` : "Agent:";
      return (
        <div data-testid="subagent-agent" className="border-l-2 border-(--color-success)/40 pl-3 space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-(--color-success)">{label}</span>
            <span className="text-(--color-text-primary)">{description}</span>
          </div>
          {prompt && (
            <MarkdownTooltip content={prompt}>
              <div className="text-xs text-(--color-text-secondary) font-mono whitespace-pre-wrap overflow-hidden max-h-15 leading-5">{prompt}</div>
            </MarkdownTooltip>
          )}
        </div>
      );
    }
    // Skill
    const skillName = (tool.input.skill as string) ?? "unknown";
    const args = tool.input.args ? (tool.input.args as string) : "";
    return (
      <div data-testid="subagent-skill" className="border-l-2 border-(--color-success)/40 pl-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-(--color-success)">Skill:</span>
          <span className="text-(--color-text-primary)">{skillName}</span>
          {args && <span className="text-(--color-text-secondary) truncate max-w-xs">{args}</span>}
        </div>
      </div>
    );
  }

  // ── Standalone tool: ExitPlanMode, AskUserQuestion, or a present card
  //    extracted from an empty-text message so it isn't folded into (and
  //    scrolled away inside) the clipped tool-group container ──
  //
  // AskUserQuestion / ExitPlanMode block the agent waiting for user
  // input, so the surrounding message keeps `streaming`/`isLoading`
  // true while the prompt is on screen — those flags would dismiss
  // every click. We also can't gate on `isLastMessage`: when Claude
  // continues to emit more content (text or other tool_use blocks)
  // alongside the question, or when the user's answer appends a
  // user-message after the question, the question's message stops
  // being last while the prompt has not yet been answered. That
  // would silently drop the user's click.
  //
  // The right gate is whether the tool itself has been resolved —
  // `el.result` is set once the agent emits a tool_result for it.
  // The AskUserQuestion / PlanApproval components track their own
  // submitted state internally, so leaving `disabled=false` here
  // and feeding them `result` lets them render the answered state
  // correctly even after a page reload (where local state is lost).
  const questionDisabled = !!el.result;
  const resolvedPlanContent = el.tool.name === "ExitPlanMode" ? findPlanContent(el.messageIndex) : undefined;
  return (
    <div>
      <ToolUseItem
        tool={el.tool}
        result={el.result}
        isLast
        isStreaming={el.streaming}
        onAnswerQuestion={onAnswerQuestion}
        onSendFollowUp={onSendFollowUp}
        isQuestionDisabled={questionDisabled}
        planContent={resolvedPlanContent}
      />
    </div>
  );
}
