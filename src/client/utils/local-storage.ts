import type { AgentId } from "../../server/shared/types.js";

const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const RIGHT_TAB_KEY = "shipit-right-tab";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";
const MODEL_PREFERENCE_KEY = "vibe-model-id";
const ACTIVE_REPO_KEY = "vibe-active-repo";
const NOTIFY_ON_FINISH_KEY = "shipit-notify-on-finish";
const SOUND_ON_FINISH_KEY = "shipit-sound-on-finish";
const SHOW_SESSION_COST_KEY = "shipit-show-session-cost";

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

const VALID_RIGHT_TABS = ["preview", "docs", "files", "terminal", "history", "services"] as const;
export type SavedRightTab = typeof VALID_RIGHT_TABS[number];

export function getSavedRightTab(): SavedRightTab {
  try {
    const saved = localStorage.getItem(RIGHT_TAB_KEY);
    if (saved && (VALID_RIGHT_TABS as readonly string[]).includes(saved)) {
      return saved as SavedRightTab;
    }
  } catch {
    // localStorage may be unavailable
  }
  return "preview";
}

export function saveRightTab(tab: SavedRightTab): void {
  try {
    localStorage.setItem(RIGHT_TAB_KEY, tab);
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

export function getSavedShowSessionCost(): boolean {
  try {
    const saved = localStorage.getItem(SHOW_SESSION_COST_KEY);
    return saved === null ? true : saved === "true";
  } catch {
    return true;
  }
}

export function saveShowSessionCost(enabled: boolean): void {
  try {
    localStorage.setItem(SHOW_SESSION_COST_KEY, String(enabled));
  } catch {
    // localStorage may be unavailable
  }
}

const COLLAPSED_REPOS_KEY = "shipit-collapsed-repos";

export function getSavedCollapsedRepos(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_REPOS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

export function saveCollapsedRepos(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_REPOS_KEY, JSON.stringify([...collapsed]));
  } catch { /* ignore */ }
}

const DEVICE_PRESET_KEY = "shipit:devicePreset";

export function getSavedDevicePresetId(): string | null {
  try {
    return localStorage.getItem(DEVICE_PRESET_KEY);
  } catch {
    return null;
  }
}

export function saveDevicePresetId(presetId: string | null): void {
  try {
    if (presetId) {
      localStorage.setItem(DEVICE_PRESET_KEY, presetId);
    } else {
      localStorage.removeItem(DEVICE_PRESET_KEY);
    }
  } catch { /* ignore */ }
}

export { SIDEBAR_COLLAPSED_KEY, RIGHT_TAB_KEY, AGENT_PREFERENCE_KEY, MODEL_PREFERENCE_KEY, ACTIVE_REPO_KEY, NOTIFY_ON_FINISH_KEY, SOUND_ON_FINISH_KEY, SHOW_SESSION_COST_KEY, COLLAPSED_REPOS_KEY, DEVICE_PRESET_KEY };
