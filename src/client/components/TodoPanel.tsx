import { CheckIcon } from "@phosphor-icons/react";
import type { TaskItem } from "./task-list.js";

/**
 * The agent's to-do list, drawn from the folded task list (`task-list.ts`).
 *
 * Presentational only: it never reads a tool call. Which calls produce the list
 * — and how the CLI's incremental task tools fold into it — is the fold's job.
 */
export function TodoPanel({ tasks }: { tasks: TaskItem[] }) {
  const completed = tasks.filter((t) => t.status === "completed").length;

  return (
    <div
      className="text-xs max-h-48 overflow-y-auto border border-(--color-border-secondary) rounded-lg px-3 py-2"
      data-testid="todo-panel"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-(--color-text-primary)">Tasks</span>
        <span className="text-(--color-text-secondary)">
          {completed}/{tasks.length} completed
        </span>
      </div>
      <ul className="space-y-1">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-1.5">
            <StatusIcon status={task.status} />
            <span
              className={
                task.status === "completed"
                  ? "line-through text-(--color-text-secondary)"
                  : "text-(--color-text-primary)"
              }
            >
              {task.status === "in_progress" ? task.activeForm ?? task.subject : task.subject}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "completed":
      return (
        <CheckIcon size={14} className="text-(--color-success) shrink-0" data-testid="status-completed" />
      );
    case "in_progress":
      return (
        <span
          className="tool-spinner inline-block w-3.5 h-3.5 border border-(--color-accent) border-t-transparent rounded-full shrink-0"
          data-testid="status-in-progress"
        />
      );
    case "pending":
      return (
        <span
          className="inline-block w-3.5 h-3.5 rounded-full border border-(--color-border-secondary) shrink-0"
          data-testid="status-pending"
        />
      );
  }
}
