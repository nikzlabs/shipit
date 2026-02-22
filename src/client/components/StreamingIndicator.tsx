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

import { sessionRelativePath } from "../path-utils.js";

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
 * Maps both Claude CLI tool names and canonical tool names (from multi-agent
 * support) to short descriptions including relevant parameters (file paths,
 * commands) for at-a-glance status.
 */
export function activityFromTool(toolName: string, input: Record<string, unknown>): StreamingActivity {
  switch (toolName) {
    // Claude CLI names + canonical names
    case "Edit":
    case "file_edit":
      return {
        label: `Editing ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Write":
    case "file_write":
      return {
        label: `Writing ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Read":
    case "file_read":
      return {
        label: `Reading ${shortPath(input.file_path)}`,
        tool: toolName,
      };
    case "Bash":
    case "shell":
      return {
        label: `Running command...`,
        tool: toolName,
      };
    case "Glob":
    case "glob":
      return {
        label: `Searching files...`,
        tool: toolName,
      };
    case "Grep":
    case "grep":
      return {
        label: `Searching code...`,
        tool: toolName,
      };
    case "WebFetch":
    case "web_fetch":
      return {
        label: `Fetching URL...`,
        tool: toolName,
      };
    case "WebSearch":
    case "web_search":
      return {
        label: `Searching web...`,
        tool: toolName,
      };
    case "AskUserQuestion":
    case "ask_user":
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

/** Shorten a file path for display: strip session prefix, keep last 2 segments. */
function shortPath(filePath: unknown): string {
  const relative = sessionRelativePath(filePath);
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 2) return relative;
  return ".../" + parts.slice(-2).join("/");
}
