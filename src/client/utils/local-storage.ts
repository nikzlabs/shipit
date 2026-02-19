import type { PermissionMode, AgentId } from "../../server/types.js";

const PERMISSION_MODE_KEY = "vibe-permission-mode";
const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";

export function getSavedPermissionMode(): PermissionMode {
  try {
    const saved = localStorage.getItem(PERMISSION_MODE_KEY);
    if (saved === "plan" || saved === "normal" || saved === "auto") return saved;
  } catch {
    // localStorage may be unavailable
  }
  return "auto";
}

export function savePermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(PERMISSION_MODE_KEY, mode);
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedAgentId(): AgentId {
  try {
    const saved = localStorage.getItem(AGENT_PREFERENCE_KEY);
    if (saved === "claude" || saved === "codex") return saved;
  } catch {
    // localStorage may be unavailable
  }
  return "claude";
}

export function saveAgentId(agentId: AgentId): void {
  try {
    localStorage.setItem(AGENT_PREFERENCE_KEY, agentId);
  } catch {
    // localStorage may be unavailable
  }
}

export { PERMISSION_MODE_KEY, SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY };
