import type { WsServerMessage, ClaudeContentBlockToolUse } from "../../shared/types.js";
import type {
  ChatMessageGroup,
  QueuedMessage,
  SessionRunnerInterface,
  SteeredMessage,
  ToolResultEntry,
} from "../session-runner.js";

// Keep plan and question cards with the preceding text.
const STANDALONE_MERGE = new Set(["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]);

export function findGroupContainingTool(
  groups: ChatMessageGroup[],
  toolUseId: string,
): ChatMessageGroup | undefined {
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.toolUse.some((t) => t.id === toolUseId)) return g;
    for (const ev of g.subagentEvents ?? []) {
      if (ev.kind === "assistant" && ev.toolUse.some((t) => t.id === toolUseId)) return g;
    }
  }
  return undefined;
}

export function accumulateAssistantGroups(
  runner: SessionRunnerInterface,
  text: string,
  toolBlocks: ClaudeContentBlockToolUse[],
): void {
  const groups = runner.chatMessageGroups;
  const isStandaloneOnly = !text && toolBlocks.length > 0
    && toolBlocks.every((t) => STANDALONE_MERGE.has(t.name));
  if (runner.needsNewMessageGroup && isStandaloneOnly && groups.length > 0) {
    // Leave the boundary armed for the next non-standalone event.
    const last = groups[groups.length - 1];
    last.toolUse.push(...toolBlocks);
  } else if (runner.needsNewMessageGroup || groups.length === 0) {
    groups.push({ text, toolUse: [...toolBlocks] });
    runner.needsNewMessageGroup = false;
  } else {
    const last = groups[groups.length - 1];
    last.text += text;
    last.toolUse.push(...toolBlocks);
  }
  runner.chatMessageGroups = groups;
}

export function attachSubagentAssistant(
  runner: SessionRunnerInterface,
  parentToolUseId: string,
  text: string,
  toolBlocks: ClaudeContentBlockToolUse[],
): void {
  const groups = runner.chatMessageGroups;
  const parentGroup = findGroupContainingTool(groups, parentToolUseId);
  if (parentGroup) {
    parentGroup.subagentEvents = [
      ...(parentGroup.subagentEvents ?? []),
      { kind: "assistant", parentToolUseId, text, toolUse: toolBlocks },
    ];
    runner.chatMessageGroups = groups;
  }
}

export function attachSubagentToolResults(
  runner: SessionRunnerInterface,
  parentToolUseId: string,
  toolResults: ToolResultEntry[],
): void {
  const groups = runner.chatMessageGroups;
  const parentGroup = findGroupContainingTool(groups, parentToolUseId);
  if (parentGroup) {
    parentGroup.subagentEvents = [
      ...(parentGroup.subagentEvents ?? []),
      { kind: "tool_result", parentToolUseId, toolResults },
    ];
    runner.chatMessageGroups = groups;
  }
}

export function attachToolResultsToGroup(
  runner: SessionRunnerInterface,
  toolResults: ToolResultEntry[],
): void {
  const groups = runner.chatMessageGroups;
  if (groups.length > 0) {
    const last = groups[groups.length - 1];
    last.toolResults = [...(last.toolResults ?? []), ...toolResults];
    runner.chatMessageGroups = groups;
  }
}

export function recordSteeredMessage(
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[] },
  text: string,
  extra?: Pick<SteeredMessage, "images" | "files" | "uploadPaths" | "assembledPrompt" | "agentInterface">,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.steeredMessages = [
    ...runner.steeredMessages,
    {
      afterGroupIndex,
      text,
      agentInterface: extra?.agentInterface,
      images: extra?.images,
      files: extra?.files,
      uploadPaths: extra?.uploadPaths,
      assembledPrompt: extra?.assembledPrompt,
    },
  ];
  console.log(
    `[steered] recordSteeredMessage afterGroupIndex=${afterGroupIndex} steered.len=${runner.steeredMessages.length} text=${JSON.stringify(text.slice(0, 60))}`,
  );
}

// Run before finalization and queue drain so resends do not leave duplicate user rows.
export function requeueUndeliveredSteers(
  runner: SessionRunnerInterface,
  emit: (msg: WsServerMessage) => void,
): number {
  const steers = runner.steeredMessages;
  const persistableGroups = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  const isUndelivered = (s: SteeredMessage): boolean =>
    s.assembledPrompt !== undefined && !s.delivered && persistableGroups <= s.afterGroupIndex;
  const undelivered = steers.filter(isUndelivered);
  if (undelivered.length === 0) return 0;
  runner.steeredMessages = steers.filter((s) => !isUndelivered(s));
  for (const s of undelivered) {
    const queued: QueuedMessage = {
      text: s.text,
      execution: s.agentInterface ? "dispatched" : "interactive",
      ...(s.agentInterface ? { agentInterface: s.agentInterface } : {}),
    };
    if (s.images && s.images.length > 0) queued.images = s.images;
    if (s.files && s.files.length > 0) queued.files = s.files.map((f) => ({ path: f.path }));
    const position = runner.enqueue(queued);
    emit({ type: "message_queued", text: s.text, position });
    console.log(
      `[steer-requeue] runner=${runner.sessionId} un-acked steer re-queued at pos=${position} text=${JSON.stringify(s.text.slice(0, 60))}`,
    );
  }
  return undelivered.length;
}
