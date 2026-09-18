// Transcript names control field retention and inline rendering.
// Glob is the closest available name for a directory listing.
export const GROK_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  grep: "Grep",
  list_dir: "Glob",
  monitor: "Monitor",
  read_file: "Read",
  run_terminal_command: "Bash",
  scheduler_create: "CronCreate",
  scheduler_delete: "CronDelete",
  scheduler_list: "CronList",
  search_replace: "Edit",
  search_tool: "ToolSearch",
  spawn_subagent: "Agent",
  todo_write: "TodoWrite",
  web_search: "WebSearch",
  workflow: "Workflow",
  write: "Write",
};

// Keep unobserved interactive input shapes off cards that require a known schema.
export const GROK_UNNORMALIZED_INTERACTIVE_TOOLS = new Set([
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
]);

const INPUT_KEY_RENAMES: Record<string, string> = {
  target_file: "file_path",
  target_directory: "path",
};

export function normalizeGrokToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const transcriptName = GROK_TRANSCRIPT_TOOL_NAMES[name];
  if (!transcriptName) return { name, input };
  if (!Object.keys(input).some((key) => key in INPUT_KEY_RENAMES)) {
    return { name: transcriptName, input };
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    renamed[INPUT_KEY_RENAMES[key] ?? key] = value;
  }
  return { name: transcriptName, input: renamed };
}

// The Agent card needs report text. The full envelope remains in the result modal.
export function normalizeGrokToolResult(name: string, output: string): string {
  if (name !== "spawn_subagent") return output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (typeof parsed !== "object" || parsed === null) return output;
  const envelope = parsed as { type?: unknown; output?: unknown; text?: unknown };
  if (envelope.type === "SubagentCompleted" && typeof envelope.output === "string") {
    return envelope.output;
  }
  if (envelope.type === "Text" && typeof envelope.text === "string") {
    return envelope.text;
  }
  return output;
}
