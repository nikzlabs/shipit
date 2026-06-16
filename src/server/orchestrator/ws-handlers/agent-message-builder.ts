import type { WsServerMessage, ClaudeContentBlockToolUse } from "../../shared/types.js";
import type {
  ChatMessageGroup,
  QueuedMessage,
  SessionRunnerInterface,
  SteeredMessage,
  ToolResultEntry,
} from "../session-runner.js";

/**
 * Chat message-group accumulation extracted from `agent-listeners.ts` (Phase P6
 * split, docs/201). These helpers own the `runner.chatMessageGroups` machinery:
 * subagent group routing (docs/109), the `needsNewMessageGroup` boundary logic
 * (standalone-tool merge), tool-result attachment, and live-steer recording /
 * re-queue (docs/140). No behavior change — the listener delegates to them.
 *
 * `buildTurnMessages` / `persistTurnInProgress` themselves live in
 * `chat-card-persistence.ts` (co-located with `recordChatCard`); this module
 * collaborates with them but does not re-home them.
 */

/**
 * Standalone tools (ExitPlanMode, AskUserQuestion) should merge with the
 * preceding group to keep plan text together with the PlanApproval card.
 * Without this, ExitPlanMode ends up in a separate message group with empty
 * text when the agent does research between writing the plan and calling
 * ExitPlanMode.
 */
const STANDALONE_MERGE = new Set(["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]);

/**
 * Find the chat message group that contains the given tool_use id (either in
 * its top-level toolUse list, or — for nested subagents — in a subagentEvent's
 * toolUse list). Used to attach subagent events to the correct group so they
 * render under the parent Task tool. (109 — subagent transparency)
 */
export function findGroupContainingTool(
  groups: ChatMessageGroup[],
  toolUseId: string,
): ChatMessageGroup | undefined {
  // Iterate newest-first since subagent events typically reference a recent tool.
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.toolUse.some((t) => t.id === toolUseId)) return g;
    // Also handle nested subagents-of-subagents: look inside existing subagentEvents.
    for (const ev of g.subagentEvents ?? []) {
      if (ev.kind === "assistant" && ev.toolUse.some((t) => t.id === toolUseId)) return g;
    }
  }
  return undefined;
}

/**
 * Accumulate an assistant event's text + tool blocks into
 * `runner.chatMessageGroups`, splitting at tool-result boundaries via
 * `runner.needsNewMessageGroup`. Standalone tools (plan/ask) merge into the
 * previous group rather than starting a fresh one. Mirrors the inline logic the
 * listener previously held; callers gate it on `(text || toolBlocks.length > 0)`.
 */
export function accumulateAssistantGroups(
  runner: SessionRunnerInterface,
  text: string,
  toolBlocks: ClaudeContentBlockToolUse[],
): void {
  const groups = runner.chatMessageGroups;
  const isStandaloneOnly = !text && toolBlocks.length > 0
    && toolBlocks.every((t) => STANDALONE_MERGE.has(t.name));
  if (runner.needsNewMessageGroup && isStandaloneOnly && groups.length > 0) {
    // Merge standalone tools with previous group; leave needsNewMessageGroup
    // true so the next non-standalone event starts a fresh group.
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

/**
 * Attach an assistant subagent event (carrying `parentToolUseId`) under the
 * group that holds the parent Task tool, rather than the main flow — otherwise
 * nested tool calls would corrupt the parent conversation. (docs/109)
 * No-op when the parent group can't be found.
 */
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

/**
 * Attach a subagent tool_result event under the parent Task group's
 * subagentEvents, NOT splitting the main message group. (docs/109)
 * No-op when the parent group can't be found.
 */
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

/**
 * Attach tool results to the current (last) message group. No-op when there are
 * no groups yet. Callers set `runner.needsNewMessageGroup = true` separately so
 * the next assistant event starts a fresh group.
 */
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

/**
 * Record a live-steered user message on the runner, anchored after the
 * assistant groups that have produced persistable content so far. The anchor
 * is what `buildTurnMessages` uses to re-interleave the message at its true
 * transcript position on every in-progress rebuild (docs/140).
 */
export function recordSteeredMessage(
  runner: { chatMessageGroups: ChatMessageGroup[]; steeredMessages: SteeredMessage[] },
  text: string,
  extra?: Pick<SteeredMessage, "images" | "files" | "uploadPaths" | "assembledPrompt">,
): void {
  const afterGroupIndex = runner.chatMessageGroups.filter((g) => g.text || g.toolUse.length > 0).length;
  runner.steeredMessages = [
    ...runner.steeredMessages,
    {
      afterGroupIndex,
      text,
      images: extra?.images,
      files: extra?.files,
      uploadPaths: extra?.uploadPaths,
      // docs/140 — record what the CLI will echo so the delivery ack can match
      // it. Absent ⇒ not a streaming live-steer ⇒ never a re-queue candidate.
      assembledPrompt: extra?.assembledPrompt,
    },
  ];
  // docs/140 diag — capture the steered-message inject point. Pairs with the
  // `[persist-user]` logs to confirm whether the same user text was both
  // appended (via persistUserMessage) and injected into the in-progress batch
  // (via this path) during one user-send — the suspected double-bubble cause.
  console.log(
    `[steered] recordSteeredMessage afterGroupIndex=${afterGroupIndex} steered.len=${runner.steeredMessages.length} text=${JSON.stringify(text.slice(0, 60))}`,
  );
}

/**
 * docs/140 — re-queue live steers the CLI never acknowledged. A steer with
 * `assembledPrompt` set but `delivered` still falsy at turn end fell into the
 * turn-end gap: it was written to the resident streaming process's stdin while
 * `running` was still true, but the model had already finished its output and
 * had no decision point left to apply it at, so the turn ended (`result`)
 * without the agent acting on it AND without the CLI echoing it back
 * (`--replay-user-messages`). Such steers are dropped from the rendered set (so
 * they don't double-render) and enqueued; the post-turn drain then runs each as
 * a fresh turn the agent WILL process — turning a silently-lost message into an
 * automatic resend.
 *
 * Must run on `agent_result` BEFORE the turn's rows are finalized
 * (`buildTurnMessages` → `replaceInProgress` → `finalizeInProgress`), so the
 * removed steers are excluded from the finalized turn and don't double-render
 * against the re-queued turn's own user row. The enqueue also happens before
 * the executor's post-turn `tryDrain`, which then runs the re-queued steer as
 * the next turn. Steers without `assembledPrompt` (non-streaming sends, which
 * are never echoed) are never candidates, so this is a no-op off the live-steer
 * path.
 *
 * A steer counts as DELIVERED — and is left alone — when EITHER signal fired:
 *   1. the CLI echoed it (`delivered`, set by the `agent_user_replay` ack), or
 *   2. the turn produced an assistant group AFTER it was injected (the current
 *      persistable-group count exceeds the steer's `afterGroupIndex` snapshot) —
 *      i.e. the model continued past the steer point and acted on it.
 * Only a steer with NEITHER signal fell into the turn-end gap. Requiring both
 * to be absent is deliberately conservative: it never re-queues (and so never
 * double-processes) a steer the agent demonstrably handled, even if the CLI's
 * echo is missing or didn't match.
 *
 * Returns the number of steers re-queued (for diagnostics / tests).
 */
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
  // Remove them from the steered set so the imminent finalize excludes them —
  // the re-queued turn persists its own user row, so leaving them here would
  // double-render the bubble on reload (same reasoning as steer-rejected).
  runner.steeredMessages = steers.filter((s) => !isUndelivered(s));
  for (const s of undelivered) {
    const queued: QueuedMessage = { text: s.text };
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
