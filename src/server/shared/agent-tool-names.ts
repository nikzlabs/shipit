/**
 * Tool names each agent CLI exposes, for UI mapping.
 *
 * Split out of `agent-registry.ts` (docs/252 phase 1) so the harness catalogue
 * can carry them without importing that module: `agent-registry.ts` now derives
 * its `AGENT_DEFS` from the catalogue, so a catalogue → registry import would
 * close a cycle. `agent-registry.ts` re-exports both constants, so existing
 * import sites are unchanged.
 */

export const CLAUDE_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

// Verified against a live `opencode run` turn (CLI 1.18.15, 2026-08-16);
// docs/268-opencode-harness/plan.md. OpenCode tool ids are lowercase.
export const OPENCODE_TOOL_NAMES = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "write",
] as const;

export const CODEX_TOOL_NAMES = [
  "shell",
  "commandExecution",
  "fileChange",
  "apply_patch",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "spawn_agent",
  "Agent",
  "webSearch",
  "imageView",
  "view_image",
  "tool_search",
  "AskUserQuestion",
] as const;
