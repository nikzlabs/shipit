// Transcript names control field retention and inline rendering. OpenCode 2 renamed
// `bash` to `shell` and `task` to `subagent`, and its file tools take `path`.
export const OPENCODE2_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  read: "Read",
  shell: "Bash",
  skill: "Skill",
  subagent: "Agent",
  webfetch: "WebFetch",
  write: "Write",
};

const INPUT_KEY_RENAMES: Record<string, string> = {
  oldString: "old_string",
  newString: "new_string",
  replaceAll: "replace_all",
};

// Glob and grep keep `path`: there it names a directory, not the file a card renders.
const TOOL_INPUT_RENAMES: Record<string, Record<string, string>> = {
  edit: { path: "file_path" },
  read: { path: "file_path" },
  write: { path: "file_path" },
  skill: { id: "skill" },
  subagent: { agent: "subagent_type" },
};

// Match the final closing tag so tags within the report survive; leave other formats untouched.
const SUBAGENT_RESULT_WRAPPER = /^\s*<subagent\b[^>]*>([\s\S]*)<\/subagent>\s*$/;

export function normalizeOpencode2ToolResult(name: string, output: string): string {
  if (name !== "subagent") return output;
  const match = SUBAGENT_RESULT_WRAPPER.exec(output);
  if (!match) return output;
  return match[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export function normalizeOpencode2ToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  const transcriptName = OPENCODE2_TRANSCRIPT_TOOL_NAMES[name];
  if (!transcriptName) return { name, input };
  const renames = { ...INPUT_KEY_RENAMES, ...(TOOL_INPUT_RENAMES[name] ?? {}) };
  if (!Object.keys(input).some((key) => key in renames)) return { name: transcriptName, input };
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) renamed[renames[key] ?? key] = value;
  return { name: transcriptName, input: renamed };
}
