import type { AgentId, IssuePriorityLevel, PermissionMode } from "../../server/shared/types.js";
import type { IssueFilters } from "../components/issues-filter.js";
import { DEFAULT_SORT_PREFS, type GroupKey, type SortDir, type SortKey, type SortPrefs } from "../components/issues-sort.js";

const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const RIGHT_TAB_KEY = "shipit-right-tab";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";
const MODEL_PREFERENCE_KEY = "vibe-model-id";
const ACTIVE_REPO_KEY = "vibe-active-repo";
const NOTIFY_ON_FINISH_KEY = "shipit-notify-on-finish";
const SOUND_ON_FINISH_KEY = "shipit-sound-on-finish";
const QUICK_CAPTURE_HOTKEY_KEY = "shipit-quick-capture-hotkey";

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

// NOTE: "services" was removed (docs/175 — Services is now a drawer inside the
// Preview tab, not a standalone tab). A legacy persisted "services" value fails
// the membership check in getSavedRightTab() and falls back to "preview".
const VALID_RIGHT_TABS = ["preview", "docs", "issues", "files", "terminal", "history", "pr", "host", "present"] as const;
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

// `QUICK_CAPTURE_HOTKEY_KEY` is retained for the docs/180 legacy migration in
// getSavedKeybindings(); the per-key getter/setter moved into the keybindings
// blob.

// ---- Voice settings (docs/144) ----

const VOICE_INPUT_ENABLED_KEY = "shipit-voice-input-enabled";
const STT_PROVIDER_KEY = "shipit-stt-provider";
const CLEANUP_ENABLED_KEY = "shipit-voice-cleanup-enabled";
const VOICE_HOTKEY_MODE_A_KEY = "shipit-voice-hotkey-mode-a";
const VOICE_HOTKEY_MODE_B_KEY = "shipit-voice-hotkey-mode-b";
const VOICE_LANGUAGE_KEY = "shipit-voice-language";
const VOICE_PLAYBACK_ENABLED_KEY = "shipit-voice-playback-enabled";
const VOICE_HANDS_FREE_KEY = "shipit-voice-hands-free";
const TTS_PROVIDER_KEY = "shipit-tts-provider";
const TTS_VOICE_KEY = "shipit-tts-voice";
const TTS_SPEED_KEY = "shipit-tts-speed";

export const TTS_VOICE_DEFAULT = "alloy";
export const TTS_SPEED_DEFAULT = 1;

function getSavedBool(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === "true";
  } catch {
    return fallback;
  }
}

function saveBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage may be unavailable
  }
}

function getSavedString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may be unavailable
  }
}

export const getSavedVoiceInputEnabled = (): boolean => getSavedBool(VOICE_INPUT_ENABLED_KEY, false);
export const saveVoiceInputEnabled = (v: boolean): void => saveBool(VOICE_INPUT_ENABLED_KEY, v);
export const getSavedSttProvider = (): string => getSavedString(STT_PROVIDER_KEY, "openai");
export const saveSttProvider = (v: string): void => saveString(STT_PROVIDER_KEY, v);
export const getSavedCleanupEnabled = (): boolean => getSavedBool(CLEANUP_ENABLED_KEY, true);
export const saveCleanupEnabled = (v: boolean): void => saveBool(CLEANUP_ENABLED_KEY, v);
export const getSavedVoiceLanguage = (): string => getSavedString(VOICE_LANGUAGE_KEY, "");
export const saveVoiceLanguage = (v: string): void => saveString(VOICE_LANGUAGE_KEY, v);
export const getSavedVoicePlaybackEnabled = (): boolean => getSavedBool(VOICE_PLAYBACK_ENABLED_KEY, false);
export const saveVoicePlaybackEnabled = (v: boolean): void => saveBool(VOICE_PLAYBACK_ENABLED_KEY, v);

// docs/163 — hands-free voice notes. OFF by default so the no-surprise-audio
// promise holds for users who don't opt in.
export const getSavedVoiceHandsFree = (): boolean => getSavedBool(VOICE_HANDS_FREE_KEY, false);
export const saveVoiceHandsFree = (v: boolean): void => saveBool(VOICE_HANDS_FREE_KEY, v);
export const getSavedTtsProvider = (): string => getSavedString(TTS_PROVIDER_KEY, "openai");
export const saveTtsProvider = (v: string): void => saveString(TTS_PROVIDER_KEY, v);
export const getSavedTtsVoice = (): string => getSavedString(TTS_VOICE_KEY, TTS_VOICE_DEFAULT);
export const saveTtsVoice = (v: string): void => saveString(TTS_VOICE_KEY, v);

export function getSavedTtsSpeed(): number {
  try {
    const raw = localStorage.getItem(TTS_SPEED_KEY);
    if (raw === null) return TTS_SPEED_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : TTS_SPEED_DEFAULT;
  } catch {
    return TTS_SPEED_DEFAULT;
  }
}

export function saveTtsSpeed(value: number): void {
  try {
    localStorage.setItem(TTS_SPEED_KEY, String(value));
  } catch {
    // localStorage may be unavailable
  }
}

// ---- Keybindings (docs/180) ----
//
// A single JSON blob holding only the user's *overrides* (binding id → chord);
// anything absent falls back to the registry default. On first read we migrate
// the legacy per-key entries (quick-capture + voice mode A/B) so existing users
// keep their custom chords when those editors moved into the Keyboard tab.

const KEYBINDINGS_KEY = "shipit-keybindings";

export function getSavedKeybindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v) out[k] = v;
      }
      return out;
    }
    // No blob yet — migrate legacy single-purpose keys if present.
    const migrated: Record<string, string> = {};
    const legacy: [string, string][] = [
      [QUICK_CAPTURE_HOTKEY_KEY, "quick-capture"],
      [VOICE_HOTKEY_MODE_A_KEY, "voice-mode-a"],
      [VOICE_HOTKEY_MODE_B_KEY, "voice-mode-b"],
    ];
    for (const [legacyKey, id] of legacy) {
      const v = localStorage.getItem(legacyKey);
      if (v) migrated[id] = v;
    }
    return migrated;
  } catch {
    return {};
  }
}

export function saveKeybindings(map: Record<string, string>): void {
  try {
    localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable
  }
}

const PERMISSION_MODE_BY_SESSION_KEY = "shipit-permission-mode-by-session";
const VALID_PERMISSION_MODES: readonly PermissionMode[] = ["auto", "plan", "guarded"];

/**
 * Per-session permission-mode overrides, persisted so a page reload restores a
 * session's true mode. Without this the chip fell back to the global "auto"
 * default after a reload, which is sent on the wire as `undefined` and silently
 * left a plan-pinned persistent streaming CLI wedged ("can't exit plan mode").
 * The GLOBAL default is deliberately NOT persisted (plan is a per-conversation
 * choice) — only the per-session map. Unknown modes are dropped defensively.
 */
export function getSavedPermissionModeBySession(): Record<string, PermissionMode> {
  try {
    const raw = localStorage.getItem(PERMISSION_MODE_BY_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, PermissionMode> = {};
    for (const [id, mode] of Object.entries(parsed)) {
      if (typeof mode === "string" && (VALID_PERMISSION_MODES as readonly string[]).includes(mode)) {
        result[id] = mode as PermissionMode;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function savePermissionModeBySession(map: Record<string, PermissionMode>): void {
  try {
    localStorage.setItem(PERMISSION_MODE_BY_SESSION_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable
  }
}

// ---- Changed-docs strip collapse state (docs/205) ----
//
// Per-session expanded/collapsed state for the PR card's changed-docs strip.
// Pure view state, so it lives in localStorage (not server-persisted) and can
// differ between desktop and mobile. Default is COLLAPSED — a session with no
// stored preference reads as collapsed, keeping the header height unchanged
// until the user opts in.

const CHANGED_DOCS_EXPANDED_KEY = "shipit-changed-docs-expanded-by-session";

function readChangedDocsMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHANGED_DOCS_EXPANDED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (typeof v === "boolean") out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function getSavedChangedDocsExpanded(sessionId: string): boolean {
  return readChangedDocsMap()[sessionId] ?? false;
}

export function saveChangedDocsExpanded(sessionId: string, expanded: boolean): void {
  try {
    const map = readChangedDocsMap();
    map[sessionId] = expanded;
    localStorage.setItem(CHANGED_DOCS_EXPANDED_KEY, JSON.stringify(map));
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

const COLLAPSED_PARENTS_KEY = "shipit-collapsed-parents";

export function getSavedCollapsedParents(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PARENTS_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

export function saveCollapsedParents(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PARENTS_KEY, JSON.stringify([...collapsed]));
  } catch { /* ignore */ }
}

const OPS_COLLAPSED_KEY = "shipit-ops-collapsed";

export function getSavedOpsCollapsed(): boolean {
  try {
    return localStorage.getItem(OPS_COLLAPSED_KEY) === "1";
  } catch { /* ignore */ }
  return false;
}

export function saveOpsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(OPS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

const DRAFT_MESSAGE_KEY_PREFIX = "shipit-draft-message:";

/** Read the saved draft message text for a session (or `"new"` for the new-session view). */
export function getSavedDraftMessage(sessionKey: string): string | undefined {
  try {
    const value = localStorage.getItem(DRAFT_MESSAGE_KEY_PREFIX + sessionKey);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/** Persist (or clear, if `text` is empty) the draft message text for a session. */
export function saveDraftMessage(sessionKey: string, text: string): void {
  try {
    if (text) {
      localStorage.setItem(DRAFT_MESSAGE_KEY_PREFIX + sessionKey, text);
    } else {
      localStorage.removeItem(DRAFT_MESSAGE_KEY_PREFIX + sessionKey);
    }
  } catch {
    // localStorage may be unavailable
  }
}

// Paths of uploads that have been attached to the composer but not yet sent —
// the durable half of a "draft." Draft *text* survives a reload/session-switch
// via the key above; this is the matching record for the attachment chips so
// they survive too. The default for a file on disk is NOT a chip (see
// `hydrateUploads`), so only paths explicitly listed here are restored as
// chips, and the set self-heals against chat history on hydrate — this is what
// keeps the resurrection bug (an already-sent file reappearing as a chip) from
// returning.
const DRAFT_UPLOADS_KEY_PREFIX = "shipit-draft-uploads:";

/** Read the saved draft (attached-but-unsent) upload paths for a session. */
export function getSavedDraftUploads(sessionKey: string): string[] {
  try {
    const raw = localStorage.getItem(DRAFT_UPLOADS_KEY_PREFIX + sessionKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Persist (or clear, if empty) the draft upload paths for a session. */
export function saveDraftUploads(sessionKey: string, paths: string[]): void {
  try {
    if (paths.length > 0) {
      localStorage.setItem(DRAFT_UPLOADS_KEY_PREFIX + sessionKey, JSON.stringify(paths));
    } else {
      localStorage.removeItem(DRAFT_UPLOADS_KEY_PREFIX + sessionKey);
    }
  } catch {
    // localStorage may be unavailable
  }
}

/** Add a path to a session's draft uploads (attached, not yet sent). */
export function addDraftUpload(sessionKey: string, path: string): void {
  const paths = getSavedDraftUploads(sessionKey);
  if (paths.includes(path)) return;
  paths.push(path);
  saveDraftUploads(sessionKey, paths);
}

/** Remove paths from a session's draft uploads (sent, or chip removed). */
export function removeDraftUploads(sessionKey: string, toRemove: string[]): void {
  if (toRemove.length === 0) return;
  const remove = new Set(toRemove);
  const paths = getSavedDraftUploads(sessionKey);
  const next = paths.filter((p) => !remove.has(p));
  if (next.length !== paths.length) saveDraftUploads(sessionKey, next);
}

// ---- Issues-tab filters (docs/173) ----
//
// The Issues filter bar (search + priority/status/assignee/label facets) is
// workspace-scoped reference state, not per-session, so it persists in
// localStorage and survives a page reload. The facets are `Set`s, so we
// serialize them to arrays and rehydrate. Priorities are validated against the
// fixed enum on read; freeform status/assignee/label values are pruned to the
// loaded list by the store after each fetch, so a stale value here is harmless.

const ISSUE_FILTERS_KEY = "shipit-issue-filters";

const VALID_PRIORITY_LEVELS: readonly IssuePriorityLevel[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

interface SerializedIssueFilters {
  query?: string;
  priorities?: string[];
  statuses?: string[];
  assignees?: string[];
  labels?: string[];
}

export function getSavedIssueFilters(): IssueFilters {
  const empty: IssueFilters = {
    query: "",
    priorities: new Set(),
    statuses: new Set(),
    assignees: new Set(),
    labels: new Set(),
  };
  try {
    const raw = localStorage.getItem(ISSUE_FILTERS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as SerializedIssueFilters;
    const validPriorities = new Set<string>(VALID_PRIORITY_LEVELS);
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      priorities: new Set(
        (parsed.priorities ?? []).filter((p): p is IssuePriorityLevel => validPriorities.has(p)),
      ),
      statuses: new Set((parsed.statuses ?? []).filter((s) => typeof s === "string")),
      assignees: new Set((parsed.assignees ?? []).filter((a) => typeof a === "string")),
      labels: new Set((parsed.labels ?? []).filter((l) => typeof l === "string")),
    };
  } catch {
    return empty;
  }
}

export function saveIssueFilters(filters: IssueFilters): void {
  try {
    const payload: SerializedIssueFilters = {
      query: filters.query,
      priorities: [...filters.priorities],
      statuses: [...filters.statuses],
      assignees: [...filters.assignees],
      labels: [...filters.labels],
    };
    localStorage.setItem(ISSUE_FILTERS_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable
  }
}

// ---- Issues-tab sort/group prefs + collapse state (docs/206) ----
//
// Both are workspace-scoped reference state (the issue list isn't per-session or
// per-repo), so they persist in localStorage globally and survive reloads. Sort
// prefs are validated field-by-field on read so a malformed/old blob can never
// crash the panel — anything unrecognized falls back to the default.

const ISSUE_SORT_KEY = "shipit-issue-sort";
const ISSUE_COLLAPSED_KEY = "shipit-issue-collapsed";

const VALID_SORT_KEYS = ["priority", "status", "title", "updated", "assignee"] as const;
const VALID_GROUP_KEYS = ["none", "priority", "status", "assignee"] as const;

export function getSavedSortPrefs(): SortPrefs {
  try {
    const raw = localStorage.getItem(ISSUE_SORT_KEY);
    if (!raw) return { ...DEFAULT_SORT_PREFS };
    const p = JSON.parse(raw) as Record<string, unknown>;
    const sortKeys: readonly string[] = VALID_SORT_KEYS;
    const groupKeys: readonly string[] = VALID_GROUP_KEYS;
    const dir = (v: unknown): SortDir => (v === -1 ? -1 : 1);
    return {
      primary: typeof p.primary === "string" && sortKeys.includes(p.primary) ? (p.primary as SortKey) : DEFAULT_SORT_PREFS.primary,
      primaryDir: dir(p.primaryDir),
      secondary:
        p.secondary === "none"
          ? "none"
          : typeof p.secondary === "string" && sortKeys.includes(p.secondary)
            ? (p.secondary as SortKey)
            : DEFAULT_SORT_PREFS.secondary,
      secondaryDir: dir(p.secondaryDir),
      group: typeof p.group === "string" && groupKeys.includes(p.group) ? (p.group as GroupKey) : DEFAULT_SORT_PREFS.group,
    };
  } catch {
    return { ...DEFAULT_SORT_PREFS };
  }
}

export function saveSortPrefs(prefs: SortPrefs): void {
  try {
    localStorage.setItem(ISSUE_SORT_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable
  }
}

export function getSavedIssueCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(ISSUE_COLLAPSED_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    /* ignore */
  }
  return new Set();
}

export function saveIssueCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(ISSUE_COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // localStorage may be unavailable
  }
}

// "Show done" toggle for the Issues tab. Persisted separately from the filter
// facets because it's a fetch-scope control (re-fetches with a wider state set),
// not a client-side facet over the already-loaded list.
const ISSUE_INCLUDE_DONE_KEY = "shipit-issue-include-done";

export function getSavedIncludeDone(): boolean {
  try {
    return localStorage.getItem(ISSUE_INCLUDE_DONE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveIncludeDone(includeDone: boolean): void {
  try {
    localStorage.setItem(ISSUE_INCLUDE_DONE_KEY, includeDone ? "true" : "false");
  } catch {
    // localStorage may be unavailable
  }
}

export { SIDEBAR_COLLAPSED_KEY, RIGHT_TAB_KEY, AGENT_PREFERENCE_KEY, MODEL_PREFERENCE_KEY, ACTIVE_REPO_KEY, NOTIFY_ON_FINISH_KEY, SOUND_ON_FINISH_KEY, COLLAPSED_REPOS_KEY, COLLAPSED_PARENTS_KEY, ISSUE_FILTERS_KEY, ISSUE_INCLUDE_DONE_KEY };
