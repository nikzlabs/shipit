/**
 * StreamingIndicator — animated typing indicator and activity status display.
 *
 * Shows a bouncing three-dot animation alongside a contextual status message
 * describing what Claude is currently doing (thinking, editing files, running
 * commands, etc.). Used in the chat when waiting for or receiving Claude responses.
 *
 * Activity labels are derived from Claude CLI NDJSON event types:
 * - No events yet → "Thinking..."
 * - assistant event with tool_use → tool-specific label (e.g., "Editing src/foo.ts")
 * - user event (tool result) → "Processing..."
 * - Between tool executions → "Thinking..."
 */

export interface StreamingActivity {
  /** Human-readable label for current activity (e.g., "Editing src/app.ts") */
  label: string;
  /** The tool name if a tool is actively running, undefined otherwise */
  tool?: string;
}

/** Bouncing three-dot animation shown while Claude is responding. */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-blue-400" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-blue-400" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-blue-400" />
    </span>
  );
}

/**
 * Full thinking indicator with dots and activity label.
 * Shown when Claude is processing but no assistant message has arrived yet.
 */
export function ThinkingIndicator({ activity }: { activity?: StreamingActivity }) {
  return (
    <div className="flex justify-start">
      <div className="bg-gray-100 dark:bg-gray-800 rounded-lg px-4 py-3 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <TypingDots />
        <span>{activity?.label ?? "Thinking..."}</span>
      </div>
    </div>
  );
}

/** Small spinner icon for in-progress tool executions. */
export function ToolSpinner() {
  return (
    <span className="tool-spinner inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full" />
  );
}

/**
 * Derive a human-readable activity label from a tool_use event.
 *
 * Maps Claude CLI tool names to short descriptions including relevant
 * parameters (file paths, commands) for at-a-glance status.
 */
export function activityFromTool(toolName: string, input: Record<string, unknown>): StreamingActivity {
  switch (toolName) {
    case "Edit":
      return {
        label: `Editing ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Write":
      return {
        label: `Writing ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Read":
      return {
        label: `Reading ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Bash":
      return {
        label: `Running command...`,
        tool: toolName,
      };
    case "Glob":
      return {
        label: `Searching files...`,
        tool: toolName,
      };
    case "Grep":
      return {
        label: `Searching code...`,
        tool: toolName,
      };
    case "WebFetch":
      return {
        label: `Fetching URL...`,
        tool: toolName,
      };
    case "WebSearch":
      return {
        label: `Searching web...`,
        tool: toolName,
      };
    case "AskUserQuestion":
      return {
        label: "Waiting for your answer...",
        tool: toolName,
      };
    default:
      return {
        label: `Using ${toolName}...`,
        tool: toolName,
      };
  }
}

/** Shorten a file path for display: keep the last 2 segments. */
function shortPath(filePath: unknown): string {
  if (typeof filePath !== "string") return "file";
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 2) return filePath;
  return ".../" + parts.slice(-2).join("/");
}
