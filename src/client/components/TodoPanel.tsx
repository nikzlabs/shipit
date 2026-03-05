import { CheckIcon } from "@phosphor-icons/react";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const completed = todos.filter((t) => t.status === "completed").length;

  return (
    <div
      className="text-xs max-h-48 overflow-y-auto border border-(--color-border-secondary) rounded-lg px-3 py-2"
      data-testid="todo-panel"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-(--color-text-primary)">Tasks</span>
        <span className="text-(--color-text-secondary)">
          {completed}/{todos.length} completed
        </span>
      </div>
      <ul className="space-y-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <StatusIcon status={todo.status} />
            <span
              className={
                todo.status === "completed"
                  ? "line-through text-(--color-text-secondary)"
                  : "text-(--color-text-primary)"
              }
            >
              {todo.status === "in_progress" ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: TodoItem["status"] }) {
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
