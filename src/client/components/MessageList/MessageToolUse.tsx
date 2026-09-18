import { ToolCallGroup, ToolUseItem } from "../message-tools.js";
import { SubagentCall } from "../SubagentCall.js";
import { SUBAGENT_REPORT_TOOL_NAMES } from "../../../server/shared/transcript-slice-tools.js";
import { pluginSkillLabel } from "../../../server/shared/plugin-skill-marker.js";
import type { VisualElement } from "../visual-elements.js";
import type { AnswerQuestionFn } from "../AskUserQuestion.js";
import type { ChatMessage } from "./types.js";

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

  onAnswerQuestion?: AnswerQuestionFn;
  onSendFollowUp?: (text: string) => void;
}) {

  if (el.kind === "tool-group") {
    return (
      <div>
        <ToolCallGroup items={el.items} isStreaming={el.streaming} />
      </div>
    );
  }

  if (el.kind === "subagent") {
    const tool = el.tool;
    const parentMsg = messages[el.messageIndex];

    // the floor, which is why subagent work never appeared in the transcript.
    // `Task` stays in the set because chat history persists tool names

    if (SUBAGENT_REPORT_TOOL_NAMES.has(tool.name)) {
      return (
        <SubagentCall
          tool={tool}
          subagentEvents={parentMsg?.subagentEvents}
          parentToolResults={parentMsg?.toolResults}
          isStreaming={el.streaming}
        />
      );
    }

    const rawSkillName =
      (tool.input.skill as string) ?? (tool.input.name as string) ?? "unknown";
    const skillName = pluginSkillLabel(rawSkillName) ?? rawSkillName;
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
