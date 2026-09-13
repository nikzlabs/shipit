// Transcript names control field retention and inline rendering.
// Glob is the closest available name for a directory listing.
export const ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  browser_subagent: "Agent",
  command_status: "Bash",
  define_subagent: "Agent",
  find_by_name: "Glob",
  grep_search: "Grep",
  invoke_subagent: "Agent",
  list_dir: "Glob",
  manage_task: "TodoWrite",
  multi_replace_file_content: "Edit",
  notebook_edit: "NotebookEdit",
  read_url_content: "WebFetch",
  replace_file_content: "Edit",
  run_command: "Bash",
  schedule: "CronCreate",
  search_web: "WebSearch",
  sed_file: "Edit",
  send_command_input: "Bash",
  view_file: "Read",
  write_to_file: "Write",
};

// Keep unobserved interactive input shapes off cards that require a known schema.
export const ANTIGRAVITY_UNNORMALIZED_INTERACTIVE_TOOLS = new Set([
  "ask_custom_permission",
  "ask_permission",
  "ask_question",
]);

// The CLI's parameter keys are PascalCase; transcript cards read Claude's names.
const INPUT_KEY_RENAMES: Record<string, string> = {
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  SearchDirectory: "path",
  DirectoryPath: "path",
  Query: "pattern",
  SearchTerm: "pattern",
  CommandLine: "command",
  Command: "command",
  Url: "url",
};

/** `call_mcp_tool` names the server and tool in its parameters (planning#437 pattern). */
export function antigravityMcpLabel(input: Record<string, unknown>): string | undefined {
  const server = input.ServerName;
  const tool = input.ToolName;
  if (typeof server !== "string" || typeof tool !== "string") return undefined;
  return `mcp__${server}__${tool}`;
}

export function normalizeAntigravityToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (name === "call_mcp_tool") {
    const label = antigravityMcpLabel(input);
    const args = input.Arguments;
    const inner = typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : input;
    return label ? { name: label, input: inner } : { name, input };
  }
  const transcriptName = ANTIGRAVITY_TRANSCRIPT_TOOL_NAMES[name];
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
