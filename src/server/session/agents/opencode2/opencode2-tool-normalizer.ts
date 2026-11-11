import type { OpencodeToolPart, OpencodeToolState } from "../../../shared/opencode-stream.js";
import type { AgentEvent } from "../agent-process.js";

// Transcript names control field retention and inline rendering. OpenCode 2 renamed
// `bash` to `shell` and `task` to `subagent`, and its file tools take `path`.
export const OPENCODE2_TRANSCRIPT_TOOL_NAMES: Record<string, string> = {
  edit: "Edit",
  execute: "execute",
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
  return name === "subagent" ? unwrapOpencode2SubagentReport(output) : output;
}

export function unwrapOpencode2SubagentReport(output: string): string {
  const match = SUBAGENT_RESULT_WRAPPER.exec(output);
  if (!match) return output;
  return match[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

const IMAGE_DATA_URI = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

export interface ToolResultImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

/**
 * A tool's images, in the block shape the transcript renders for Claude. The `run` stream
 * carries them only in `state.metadata.content`, as `file` parts with a data URI (2.2.5).
 */
export function opencode2ToolResultImages(metadata: Record<string, unknown> | undefined): ToolResultImageBlock[] {
  const content = metadata?.content;
  if (!Array.isArray(content)) return [];
  const images: ToolResultImageBlock[] = [];
  for (const part of content as unknown[]) {
    if (typeof part !== "object" || part === null) continue;
    const { type, uri } = part as { type?: unknown; uri?: unknown };
    if (type !== "file" || typeof uri !== "string") continue;
    const match = IMAGE_DATA_URI.exec(uri);
    if (match) images.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
  }
  return images;
}

// Code Mode reports a throw or an unknown tool inside the code as `completed`, flagged in metadata.
export function isOpencode2ToolError(name: string, state: OpencodeToolState | undefined): boolean {
  if (state?.status === "error") return true;
  if (name !== "execute") return false;
  const inner = state?.metadata?.metadata;
  return typeof inner === "object" && inner !== null && (inner as { error?: unknown }).error === true;
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

/** `parentToolUseId` files the call under the subagent call that made it. */
export function opencode2ToolUseEvent(
  callId: string,
  tool: string,
  rawInput: Record<string, unknown>,
  parentToolUseId?: string,
): AgentEvent {
  const { name, input } = normalizeOpencode2ToolCall(tool, rawInput);
  return {
    type: "agent_assistant",
    content: [{ type: "tool_use", id: callId, name, input }],
    ...(parentToolUseId ? { parentToolUseId } : {}),
  };
}

export function opencode2ToolResultEvent(callId: string, part: OpencodeToolPart, parentToolUseId?: string): AgentEvent {
  const tool = part.tool ?? "unknown";
  const isError = isOpencode2ToolError(tool, part.state);
  const output = normalizeOpencode2ToolResult(tool, part.state?.output ?? part.state?.error ?? "");
  const images = opencode2ToolResultImages(part.state?.metadata);
  const content = images.length > 0 ? [{ type: "text", text: output }, ...images] : output;
  return {
    type: "agent_tool_result",
    content: [{ type: "tool_result", tool_use_id: callId, content, ...(isError ? { is_error: true } : {}) }],
    ...(parentToolUseId ? { parentToolUseId } : {}),
  };
}
