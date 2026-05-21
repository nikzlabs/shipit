/**
 * StreamingIndicator — animated typing indicator and activity status display.
 *
 * Shows a bouncing three-dot animation alongside a contextual status message
 * describing what the agent is currently doing (thinking, editing files,
 * running commands, etc.). Used in the chat when waiting for or receiving
 * agent responses.
 *
 * Activity labels are derived from the agent CLI's NDJSON event types:
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

/** Bouncing three-dot animation shown while the agent is responding. */
export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-(--color-info)" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-(--color-info)" />
      <span className="typing-dot inline-block w-1.5 h-1.5 rounded-full bg-(--color-info)" />
    </span>
  );
}

/** Small spinner icon for in-progress tool executions. */
export function ToolSpinner() {
  return (
    <span className="tool-spinner inline-block w-3 h-3 border border-(--color-info) border-t-transparent rounded-full" />
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
    case "TodoWrite":
      return {
        label: "Updating tasks...",
        tool: toolName,
      };
    case "Task": {
      const desc = typeof input.description === "string" ? input.description : "";
      return {
        label: desc ? `Task: ${desc}` : "Running task...",
        tool: toolName,
      };
    }
    case "Skill": {
      const skill = typeof input.skill === "string" ? input.skill : "unknown";
      return {
        label: `Running skill: ${skill}...`,
        tool: toolName,
      };
    }
    default: {
      // Generic MCP tool handling — works for any MCP server
      if (toolName.startsWith("mcp__")) {
        const BROWSER_LABELS: Record<string, string> = {
          "mcp__playwright__browser_navigate": "Navigating to page",
          "mcp__playwright__browser_snapshot": "Reading page content",
          "mcp__playwright__browser_click": "Clicking element",
          "mcp__playwright__browser_type": "Typing text",
          "mcp__playwright__browser_take_screenshot": "Taking screenshot",
          "mcp__playwright__browser_scroll": "Scrolling page",
          "mcp__playwright__browser_hover": "Hovering element",
          "mcp__playwright__browser_select_option": "Selecting option",
        };
        const label = BROWSER_LABELS[toolName];
        if (label) {
          return { label, tool: toolName };
        }
        // Fallback for unknown MCP tools: "mcp__foo__bar_baz" → "Using bar baz..."
        const parts = toolName.split("__");
        const toolPart = parts.length >= 3 ? parts.slice(2).join(" ").replace(/_/g, " ") : toolName;
        return { label: `Using ${toolPart}...`, tool: toolName };
      }
      return {
        label: `Using ${toolName}...`,
        tool: toolName,
      };
    }
  }
}

/** Shorten a file path for display: strip session prefix, keep last 2 segments. */
function shortPath(filePath: unknown): string {
  const relative = sessionRelativePath(filePath);
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 2) return relative;
  return `.../${  parts.slice(-2).join("/")}`;
}
