// Transcript names control field retention and inline rendering.
export const OPENCODE_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  skill: "Skill",
  task: "Agent",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  write: "Write",
};

const INPUT_KEY_RENAMES: Record<string, string> = {
  filePath: "file_path",
  oldString: "old_string",
  newString: "new_string",
};

const TOOL_INPUT_RENAMES: Record<string, Record<string, string>> = {
  skill: { name: "skill" },
};

// The wrapper becomes an HTML block hidden by skipHtml. Match the final closing
// pair so tags within the report survive; leave unknown formats untouched.
const TASK_RESULT_WRAPPER =
  /^\s*<task\b[^>]*>\s*<task_result>([\s\S]*)<\/task_result>\s*<\/task>\s*$/;

export function normalizeOpencodeToolResult(name: string, output: string): string {
  if (name !== "task") return output;
  const match = TASK_RESULT_WRAPPER.exec(output);
  if (!match) return output;
  // Remove only wrapper newlines, preserving Markdown indentation.
  return match[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export function normalizeOpencodeToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const transcriptName = OPENCODE_TRANSCRIPT_TOOL_NAMES[name];
  if (!transcriptName) return { name, input };
  const renames = { ...INPUT_KEY_RENAMES, ...(TOOL_INPUT_RENAMES[name] ?? {}) };
  if (!Object.keys(input).some((key) => key in renames)) {
    return { name: transcriptName, input };
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    renamed[renames[key] ?? key] = value;
  }
  return { name: transcriptName, input: renamed };
}
