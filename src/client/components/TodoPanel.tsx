export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const completed = todos.filter((t) => t.status === "completed").length;

  return (
    <div
      className="text-xs max-h-48 overflow-y-auto border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2"
      data-testid="todo-panel"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-gray-700 dark:text-gray-300">Tasks</span>
        <span className="text-gray-500">
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
                  ? "line-through text-gray-500"
                  : "text-gray-700 dark:text-gray-300"
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
        <svg
          className="w-3.5 h-3.5 text-green-400 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          data-testid="status-completed"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5 13l4 4L19 7"
          />
        </svg>
      );
    case "in_progress":
      return (
        <span
          className="tool-spinner inline-block w-3.5 h-3.5 border border-blue-400 border-t-transparent rounded-full shrink-0"
          data-testid="status-in-progress"
        />
      );
    case "pending":
      return (
        <span
          className="inline-block w-3.5 h-3.5 rounded-full border border-gray-600 shrink-0"
          data-testid="status-pending"
        />
      );
  }
}
