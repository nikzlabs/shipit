/**
 * Rebuilds the agent's to-do list from the transcript's tool calls.
 *
 * The CLI's task tools are incremental (see `shared/task-list-tools.ts`): a
 * `TaskCreate` adds one task, a `TaskUpdate` patches one task by id. No single
 * call carries the list, so the panel's contents are FOLDED out of the whole
 * call sequence, in order, on every render.
 *
 * Derived, never stored — same reasoning as the `TodoWrite` scan it replaces
 * (docs/045): the calls are already in `messages`, which survives a history
 * load, a fork, a thread switch and a session resume. A store holding the
 * folded list would be a second copy to keep in sync with them.
 *
 * The fold is pure and total: the same `messages` always give the same list, so
 * a task created mid-turn (its id not yet known) settles onto its real id as
 * soon as the result lands, with no state to migrate.
 */

import { isTaskListTool } from "../../server/shared/task-list-tools.js";
import type { ChatMessage, ToolResultBlock, ToolUseBlock } from "./MessageList.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  /** The CLI's task id, or a provisional one while the create is in flight. */
  id: string;
  subject: string;
  /** Present-continuous label shown while the task is `in_progress`. */
  activeForm?: string;
  status: TaskStatus;
}

export interface TaskListState {
  tasks: TaskItem[];
  /**
   * Index of the message holding the last call that CHANGED the list — where
   * the panel is drawn. Read-only calls (`TaskList`, `TaskGet`) never move it,
   * so checking the list doesn't drag the panel down the transcript.
   */
  anchorIndex: number;
}

/**
 * A created task's id arrives in the tool RESULT, not the input — the CLI
 * assigns it. The result reads `Task #1 created successfully: <subject>`, and
 * `TaskUpdate.taskId` refers to that number.
 */
const CREATED_TASK_ID = /\btask #([a-z0-9_.-]+)\b/i;

/** Folds every task-list call in `messages` into the list they describe. */
export function foldTaskList(messages: ChatMessage[]): TaskListState | null {
  // Keyed across ALL messages, not just the one carrying the call: a result
  // lands in whichever message group is open when it arrives, which is not
  // always the group that made the call (`agent-listeners.ts` starts a new
  // group at each tool-result boundary).
  const resultsByToolUseId = new Map<string, ToolResultBlock>();
  for (const msg of messages) {
    for (const result of msg.toolResults ?? []) {
      resultsByToolUseId.set(result.toolUseId, result);
    }
  }

  const tasks = new Map<string, TaskItem>();
  let anchorIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    for (const tool of messages[i].toolUse ?? []) {
      if (!isTaskListTool(tool.name)) continue;
      const result = resultsByToolUseId.get(tool.id);
      // A call the CLI rejected changed nothing, so neither may the panel.
      // Without this a denied create leaves a phantom row, and a failed
      // completion or delete is shown as if it had worked.
      if (result?.isError) continue;
      if (applyTaskCall(tasks, tool, result)) anchorIndex = i;
    }
  }

  if (anchorIndex < 0) return null;
  return { tasks: [...tasks.values()], anchorIndex };
}

/** Applies one call to `tasks`. Returns whether it changed the list. */
function applyTaskCall(
  tasks: Map<string, TaskItem>,
  tool: ToolUseBlock,
  result: ToolResultBlock | undefined,
): boolean {
  const input = tool.input;

  // Declarative form — the call carries the whole list, so it replaces
  // whatever came before it. Ids are the items' own when they carry one (Grok's
  // `todo_write` does), positional otherwise (Claude's legacy `TodoWrite` had
  // none). One extension to pure replacement: Grok patches with
  // `merge: true` calls whose items name an id and only the fields that changed
  // (usually `{id, status}`, no `content`) — those patch the matching row
  // instead of clearing the list. The fold sees the whole transcript, so the
  // full-list call that introduced the row is always in scope to patch.
  if (tool.name === "TodoWrite") {
    if (!Array.isArray(input.todos)) return false;
    const merge = input.merge === true;
    if (!merge) tasks.clear();
    let changed = !merge;
    input.todos.forEach((entry, n) => {
      const todo = entry as Record<string, unknown>;
      const id = text(todo?.id) ?? `todo-${n}`;
      const existing = tasks.get(id);
      // A patch for a row we never saw introduced (compacted away) has no
      // subject to show — same stance as `TaskUpdate` below: an id alone
      // renders as a blank line, so skip it.
      const subject = text(todo?.content) ?? existing?.subject;
      if (subject === undefined) return;
      tasks.set(id, {
        id,
        subject,
        ...activeFormOf(todo?.activeForm ?? existing?.activeForm),
        status: statusOf(todo?.status) ?? existing?.status ?? "pending",
      });
      changed = true;
    });
    return changed;
  }

  if (tool.name === "TaskCreate") {
    const subject = text(input.subject);
    // A create still streaming in has no subject yet. Skipping it keeps an
    // unlabelled row out of the panel; the next render folds it in.
    if (!subject) return false;
    const id = createdTaskId(result?.content) ?? `pending-${tool.id}`;
    tasks.set(id, {
      id,
      subject,
      ...activeFormOf(input.activeForm),
      status: "pending",
    });
    return true;
  }

  if (tool.name === "TaskUpdate") {
    const id = text(input.taskId);
    if (!id) return false;
    if (input.status === "deleted") return tasks.delete(id);

    const existing = tasks.get(id);
    // An update for a task we never saw created — the create scrolled out of a
    // compacted transcript. Adopt it when the update names it, so the panel
    // shows a real row instead of silently losing the task; ignore it when it
    // doesn't, since an id alone renders as a blank line.
    const subject = text(input.subject) ?? existing?.subject;
    if (!subject) return false;

    const next: TaskItem = {
      id,
      subject,
      ...activeFormOf(input.activeForm ?? existing?.activeForm),
      status: statusOf(input.status) ?? existing?.status ?? "pending",
    };
    // An update still streaming in has its `taskId` and nothing else yet, so it
    // reads as a no-op. Reporting it as a change would drag the panel down to
    // this message before anything about the list had actually moved.
    if (existing && same(existing, next)) return false;
    tasks.set(id, next);
    return true;
  }

  // `TaskList` / `TaskGet` — read-only.
  return false;
}

function same(a: TaskItem, b: TaskItem): boolean {
  return a.subject === b.subject && a.activeForm === b.activeForm && a.status === b.status;
}

function createdTaskId(resultContent: string | undefined): string | null {
  if (!resultContent) return null;
  const match = CREATED_TASK_ID.exec(resultContent);
  return match ? match[1] : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function activeFormOf(value: unknown): { activeForm?: string } {
  const form = text(value);
  return form ? { activeForm: form } : {};
}

function statusOf(value: unknown): TaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}
