// TaskStop and TaskOutput act on background processes, not this task list.
export const TASK_LIST_TOOL_NAMES = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

export function isTaskListTool(name: string): boolean {
  return TASK_LIST_TOOL_NAMES.has(name);
}

// Keep this set aligned with fields rendered by the task panel.
export const TASK_LIST_SUMMARY_KEYS = new Set([
  "taskId",
  "subject",
  "activeForm",
  "status",
]);
