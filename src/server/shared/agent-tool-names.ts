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

/**
 * Grok Build's advertised tool set, read verbatim off the `system`/`init` event
 * of a real headless turn (CLI 1.0.1, 2026-08-18 — identical across the
 * `grok-4.20-0309-non-reasoning` and `grok-4.6` captures;
 * docs/274-grok-build-harness/plan.md). Grok tool ids are lower_snake_case.
 *
 * This is the CLI's whole advertised list, not the subset ShipIt's transcript
 * gives dedicated treatment — the docs/272 recognition matrix is what decides
 * that, and it is a separate exercise from declaring what the CLI can call.
 */
export const GROK_TOOL_NAMES = [
  "ask_user_question",
  "enter_plan_mode",
  "exit_plan_mode",
  "get_command_or_subagent_output",
  "grep",
  "image_edit",
  "image_gen",
  "image_to_video",
  "kill_command_or_subagent",
  "list_dir",
  "monitor",
  "read_file",
  "reference_to_video",
  "run_terminal_command",
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "search_replace",
  "search_tool",
  "spawn_subagent",
  "todo_write",
  "use_tool",
  "web_search",
  "workflow",
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
  "wait",
  "closeAgent",
  "webSearch",
  "imageView",
  "view_image",
  "tool_search",
  "AskUserQuestion",
] as const;
