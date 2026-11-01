import type { AgentEvent, PermissionMode } from "./types.js";

export function cliPermissionModeToApplied(
  cliMode: string | undefined,
): PermissionMode | undefined | "unrecognized" {
  switch (cliMode) {
    case "plan":
      return "plan";
    case "auto":
      return "guarded";
    case "default":
      return undefined;
    default:
      return "unrecognized";
  }
}

/**
 * The permission mode a Claude process reports it changed to by itself: an init's mode, or a
 * main-thread `EnterPlanMode`. Null when the event says nothing about it.
 */
export function reportedPermissionMode(event: AgentEvent): { mode: PermissionMode | undefined } | null {
  if (event.type === "agent_init") {
    const mode = cliPermissionModeToApplied(event.permissionMode);
    return mode === "unrecognized" ? null : { mode };
  }
  if (event.type === "agent_assistant" && !event.parentToolUseId
    && (event.content ?? []).some((b) => b.type === "tool_use" && b.name === "EnterPlanMode")) {
    return { mode: "plan" };
  }
  return null;
}
