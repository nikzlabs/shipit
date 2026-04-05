import type { PermissionMode, AgentId } from "../../server/shared/types.js";

const PERMISSION_MODE_KEY = "vibe-permission-mode";
const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";
const MODEL_PREFERENCE_KEY = "vibe-model-id";
const ACTIVE_REPO_KEY = "vibe-active-repo";
const NOTIFY_ON_FINISH_KEY = "shipit-notify-on-finish";
const SOUND_ON_FINISH_KEY = "shipit-sound-on-finish";

export function getSavedPermissionMode(): PermissionMode {
  try {
    const saved = localStorage.getItem(PERMISSION_MODE_KEY);
    if (saved === "plan") return "plan";
    if (saved === "auto" || saved === "normal") return "auto";
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

export function getSavedModelId(): string | undefined {
  try {
    return localStorage.getItem(MODEL_PREFERENCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveModelId(modelId: string | undefined): void {
  try {
    if (modelId) {
      localStorage.setItem(MODEL_PREFERENCE_KEY, modelId);
    } else {
      localStorage.removeItem(MODEL_PREFERENCE_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedActiveRepo(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_REPO_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveActiveRepo(url: string | undefined): void {
  try {
    if (url) {
      localStorage.setItem(ACTIVE_REPO_KEY, url);
    } else {
      localStorage.removeItem(ACTIVE_REPO_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedNotifyOnFinish(): boolean {
  try {
    const saved = localStorage.getItem(NOTIFY_ON_FINISH_KEY);
    return saved === null ? true : saved === "true";
  } catch {
    return true;
  }
}

export function saveNotifyOnFinish(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_ON_FINISH_KEY, String(enabled));
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedSoundOnFinish(): boolean {
  try {
    const saved = localStorage.getItem(SOUND_ON_FINISH_KEY);
    return saved === null ? true : saved === "true";
  } catch {
    return true;
  }
}

export function saveSoundOnFinish(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_ON_FINISH_KEY, String(enabled));
  } catch {
    // localStorage may be unavailable
  }
}

export { PERMISSION_MODE_KEY, SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY, MODEL_PREFERENCE_KEY, ACTIVE_REPO_KEY, NOTIFY_ON_FINISH_KEY, SOUND_ON_FINISH_KEY };
