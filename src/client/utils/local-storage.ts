import type { AgentId, IssuePriorityLevel, PermissionMode } from "../../server/shared/types.js";
import type { IssueFilters } from "../components/issues-filter.js";
import { DEFAULT_SORT_PREFS, type GroupKey, type SortDir, type SortKey, type SortPrefs } from "../components/issues-sort.js";
import type { BillingMode, ModelSelection } from "../../server/shared/catalogue/index.js";
import { parseSelection, resolveModelSelection, selectionExists, serializeSelection } from "../../server/shared/catalogue/index.js";

export function parseJsonWithFallback<T>(
  raw: string | null,
  fallback: T,
  validate?: (parsed: unknown) => T,
): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validate ? validate(parsed) : (parsed as T);
  } catch {
    return fallback;
  }
}

export function getLocalStorageObject<T>(
  key: string,
  fallback: T,
  transform?: (parsed: unknown) => T,
): T {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback;
  }
  return parseJsonWithFallback(raw, fallback, transform);
}

const SIDEBAR_COLLAPSED_KEY = "vibe-sidebar-collapsed";
const SIDEBAR_VIEW_KEY = "shipit-sidebar-view";
const RIGHT_TAB_KEY = "shipit-right-tab";
const AGENT_PREFERENCE_KEY = "vibe-agent-id";
const MODEL_PREFERENCE_KEY = "vibe-model-id";
const PARKED_HARNESS_KEY = "shipit-parked-harness";
const ACTIVE_REPO_KEY = "vibe-active-repo";
const COMPACT_CONVERSATION_KEY = "shipit-compact-conversation";
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

export type SidebarView = "all" | "attention";

export function getSavedSidebarView(): SidebarView {
  try {
    return localStorage.getItem(SIDEBAR_VIEW_KEY) === "attention" ? "attention" : "all";
  } catch {
    return "all";
  }
}

export function saveSidebarView(view: SidebarView): void {
  try {
    localStorage.setItem(SIDEBAR_VIEW_KEY, view);
  } catch {
    // localStorage may be unavailable
  }
}

const VALID_RIGHT_TABS = ["preview", "docs", "issues", "files", "plugins", "terminal", "history", "pr", "host", "present"] as const;
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
    if (saved === "claude" || saved === "codex" || saved === "opencode" || saved === "grok") return saved;
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

/**
 * The harness selection an auth redirect took away from the user, kept so it can
 * be handed back.
 *
 * `resolveAuthedSelection` redirects the picker off a harness with no usable
 * credential and PERSISTS the redirect, because the seed is what the next
 * session is created from (see that file). The redirect was one-way: it
 * overwrote `vibe-agent-id` and `vibe-model-id` in place, so a Claude account
 * that went `auth_failed` for a few minutes — which `ClaudeOAuthRefresher`
 * classifies optimistically and `markProviderAccountReauthenticated` exists to
 * undo — silently and permanently moved every future session to Codex. The user
 * was never told, and nothing could tell afterwards which harness they had
 * chosen.
 *
 * So the displaced selection is parked here first. Two rules keep it honest:
 *
 * - **Only a FORCED move parks.** A deliberate pick writes the seed through
 *   `persistHarnessPick` / the model picker, both of which CLEAR the park — a
 *   user who chooses Codex while Claude is down means it, and must not be
 *   yanked back when Claude recovers.
 * - **Only the first forced move parks.** A second redirect while something is
 *   already parked would overwrite the user's own choice with the machine's, so
 *   the park is written only when empty.
 */
export interface ParkedHarness {
  agentId: AgentId;

  model?: { modelId: string; serviceId?: string; billingMode?: BillingMode };
}

export function getParkedHarness(): ParkedHarness | undefined {
  return getLocalStorageObject<ParkedHarness | undefined>(
    PARKED_HARNESS_KEY,
    undefined,
    (parsed) => {
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const value = parsed as Partial<ParkedHarness>;
      if (
        // eslint-disable-next-line no-restricted-syntax -- runtime input validation: localStorage is user-writable and outlives a build, so a value that is not a known harness id must be rejected before it is handed back as one (same check as `getSavedAgentId`)
        value.agentId !== "claude" && value.agentId !== "codex"
        // eslint-disable-next-line no-restricted-syntax -- same validation, continued across the wrapped condition
        && value.agentId !== "opencode" && value.agentId !== "grok"
      ) return undefined;
      return { agentId: value.agentId, ...(value.model ? { model: value.model } : {}) };
    },
  );
}

export function saveParkedHarness(parked: ParkedHarness): void {
  try {
    localStorage.setItem(PARKED_HARNESS_KEY, JSON.stringify(parked));
  } catch {
    // localStorage may be unavailable
  }
}

export function clearParkedHarness(): void {
  try {
    localStorage.removeItem(PARKED_HARNESS_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

function readRawModelPreference(): string | undefined {
  try {
    return localStorage.getItem(MODEL_PREFERENCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeRawModelPreference(value: string | undefined): void {
  try {
    if (value) localStorage.setItem(MODEL_PREFERENCE_KEY, value);
    else localStorage.removeItem(MODEL_PREFERENCE_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * The saved selection as a full triple, migrating a legacy bare id in place.
 *
 * Returns `undefined` when nothing is saved OR when the saved value is a bare id
 * the catalogue cannot place (a versioned slug, a model since retired) — the
 * caller still gets that raw id from {@link getSavedModelId}, so an
 * unrecognisable seed degrades to today's behaviour rather than being dropped.
 */
export function getSavedModelSelection(): ModelSelection | undefined {
  const raw = readRawModelPreference();
  const parsed = parseSelection(raw);

  // (rather than at every reader) is what keeps the invariant "a selection names

  if (parsed) return selectionExists(parsed) ? parsed : undefined;
  const migrated = resolveModelSelection(raw);
  if (migrated) writeRawModelPreference(serializeSelection(migrated));
  return migrated;
}

/**
 * The saved model id alone. Still a bare id, because that is what the composer
 * picker and the WebSocket's `?model=` seed take; the service and mode ride
 * alongside rather than inside it.
 */
export function getSavedModelId(): string | undefined {
  const raw = readRawModelPreference();
  return parseSelection(raw)?.modelId ?? raw;
}

/**
 * Save a full selection. Preferred over {@link saveModelId} once one is known.
 *
 * A selection naming no catalogue row is refused rather than stored: the seed
 * would parse on the next read and resolve to nothing, which is a worse failure
 * than never having been saved.
 */
export function saveModelSelection(selection: ModelSelection | undefined): void {
  if (selection && !selectionExists(selection)) return;
  writeRawModelPreference(selection ? serializeSelection(selection) : undefined);
}

/**
 * Save a bare model id, resolving it to a selection when the catalogue can place
 * it. An id it cannot place is stored as-is, which is what an older build wrote
 * and what the reader above still understands.
 */
export function saveModelId(modelId: string | undefined): void {
  if (!modelId) {
    writeRawModelPreference(undefined);
    return;
  }
  const selection = resolveModelSelection(modelId);
  writeRawModelPreference(selection ? serializeSelection(selection) : modelId);
}

const REASONING_BY_AGENT_KEY = "shipit-reasoning-by-agent";

function readReasoningByAgent(): Record<string, string> {
  return getLocalStorageObject<Record<string, string>>(REASONING_BY_AGENT_KEY, {}, (parsed) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  });
}

export function getSavedReasoning(agentId: string): string | undefined {
  return readReasoningByAgent()[agentId];
}

export function saveReasoning(agentId: string, effort: string | null): void {
  try {
    const map = readReasoningByAgent();

    const next: Record<string, string> = {};
    for (const [id, v] of Object.entries(map)) {
      if (id !== agentId) next[id] = v;
    }
    if (effort) next[agentId] = effort;
    localStorage.setItem(REASONING_BY_AGENT_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable
  }
}

const LAST_QUICK_SESSION_REPO_KEY = "shipit-last-quick-session-repo";

export function getSavedQuickSessionRepo(): string | undefined {
  try {
    return localStorage.getItem(LAST_QUICK_SESSION_REPO_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveQuickSessionRepo(url: string | undefined): void {
  try {
    if (url) {
      localStorage.setItem(LAST_QUICK_SESSION_REPO_KEY, url);
    } else {
      localStorage.removeItem(LAST_QUICK_SESSION_REPO_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

const ROLE_PREFERENCE_KEY = "shipit-role-name";

export function getSavedRoleName(): string | undefined {
  try {
    return localStorage.getItem(ROLE_PREFERENCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveRoleName(roleName: string | undefined): void {
  try {
    if (roleName) {
      localStorage.setItem(ROLE_PREFERENCE_KEY, roleName);
    } else {
      localStorage.removeItem(ROLE_PREFERENCE_KEY);
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

export function getSavedCompactConversation(): boolean {
  try { return localStorage.getItem(COMPACT_CONVERSATION_KEY) === "true"; }
  catch { return false; }
}

export function saveCompactConversation(enabled: boolean): void {
  try { localStorage.setItem(COMPACT_CONVERSATION_KEY, String(enabled)); }
  catch { /* Display preferences still work when storage is unavailable. */ }
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

const KEYBINDINGS_KEY = "shipit-keybindings";

export function getSavedKeybindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_KEY);
    if (raw) {
      return parseJsonWithFallback<Record<string, string>>(raw, {}, (parsed) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && v) out[k] = v;
        }
        return out;
      });
    }

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

export function getSavedPermissionModeBySession(): Record<string, PermissionMode> {
  return getLocalStorageObject<Record<string, PermissionMode>>(PERMISSION_MODE_BY_SESSION_KEY, {}, (parsed) => {
    const result: Record<string, PermissionMode> = {};
    for (const [id, mode] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof mode === "string" && (VALID_PERMISSION_MODES as readonly string[]).includes(mode)) {
        result[id] = mode as PermissionMode;
      }
    }
    return result;
  });
}

export function savePermissionModeBySession(map: Record<string, PermissionMode>): void {
  try {
    localStorage.setItem(PERMISSION_MODE_BY_SESSION_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable
  }
}

const ACTIVE_PRESENT_BY_SESSION_KEY = "shipit-active-present-by-session";

export function getSavedActivePresentBySession(): Record<string, string> {
  return getLocalStorageObject<Record<string, string>>(ACTIVE_PRESENT_BY_SESSION_KEY, {}, (parsed) => {
    const out: Record<string, string> = {};
    for (const [id, presentId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof presentId === "string" && presentId) out[id] = presentId;
    }
    return out;
  });
}

export function saveActivePresentBySession(map: Record<string, string>): void {
  try {
    localStorage.setItem(ACTIVE_PRESENT_BY_SESSION_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable
  }
}

const CHANGED_DOCS_EXPANDED_KEY = "shipit-changed-docs-expanded-by-session";

function readChangedDocsMap(): Record<string, boolean> {
  return getLocalStorageObject<Record<string, boolean>>(CHANGED_DOCS_EXPANDED_KEY, {}, (parsed) => {
    const out: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[id] = v;
    }
    return out;
  });
}

export function getSavedChangedDocsExpanded(
  sessionId: string,
  defaultExpanded = false,
): boolean {
  return readChangedDocsMap()[sessionId] ?? defaultExpanded;
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

const COLLAPSED_RESOLVED_KEY = "shipit-collapsed-resolved";

export function getSavedCollapsedResolved(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_RESOLVED_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

export function saveCollapsedResolved(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_RESOLVED_KEY, JSON.stringify([...collapsed]));
  } catch { /* ignore */ }
}

// are hidden by DEFAULT (absence = collapsed), because a big feature can spawn

const EXPANDED_RESOLVED_CHILDREN_KEY = "shipit-expanded-resolved-children";

export function getSavedExpandedResolvedChildren(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_RESOLVED_CHILDREN_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr);
    }
  } catch { /* ignore */ }
  return new Set();
}

export function saveExpandedResolvedChildren(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_RESOLVED_CHILDREN_KEY, JSON.stringify([...expanded]));
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

const SANDBOX_COLLAPSED_KEY = "shipit-sandbox-collapsed";

export function getSavedSandboxCollapsed(): boolean {
  try {
    return localStorage.getItem(SANDBOX_COLLAPSED_KEY) === "1";
  } catch { /* ignore */ }
  return false;
}

export function saveSandboxCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SANDBOX_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

const HIDDEN_REPOS_COLLAPSED_KEY = "shipit-hidden-repos-collapsed";

export function getSavedHiddenReposCollapsed(): boolean {
  try {

    return localStorage.getItem(HIDDEN_REPOS_COLLAPSED_KEY) !== "0";
  } catch { /* ignore */ }
  return true;
}

export function saveHiddenReposCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(HIDDEN_REPOS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch { /* ignore */ }
}

const DRAFT_MESSAGE_KEY_PREFIX = "shipit-draft-message:";

export function getSavedDraftMessage(sessionKey: string): string | undefined {
  try {
    const value = localStorage.getItem(DRAFT_MESSAGE_KEY_PREFIX + sessionKey);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

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

const DRAFT_UPLOADS_KEY_PREFIX = "shipit-draft-uploads:";

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

export function addDraftUpload(sessionKey: string, path: string): void {
  const paths = getSavedDraftUploads(sessionKey);
  if (paths.includes(path)) return;
  paths.push(path);
  saveDraftUploads(sessionKey, paths);
}

export function removeDraftUploads(sessionKey: string, toRemove: string[]): void {
  if (toRemove.length === 0) return;
  const remove = new Set(toRemove);
  const paths = getSavedDraftUploads(sessionKey);
  const next = paths.filter((p) => !remove.has(p));
  if (next.length !== paths.length) saveDraftUploads(sessionKey, next);
}

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

// prefs are validated field-by-field on read so a malformed/old blob can never

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

export function getSavedIssueCollapsed(): Record<string, boolean> {
  return getLocalStorageObject<Record<string, boolean>>(ISSUE_COLLAPSED_KEY, {}, (parsed) => {
    if (Array.isArray(parsed)) {

      const out: Record<string, boolean> = {};
      for (const x of parsed) if (typeof x === "string") out[x] = true;
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
    return {};
  });
}

export function saveIssueCollapsed(collapsed: Record<string, boolean>): void {
  try {
    localStorage.setItem(ISSUE_COLLAPSED_KEY, JSON.stringify(collapsed));
  } catch {
    // localStorage may be unavailable
  }
}

// facets because it's a fetch-scope control (re-fetches with a wider state set),

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

export { SIDEBAR_COLLAPSED_KEY, SIDEBAR_VIEW_KEY, RIGHT_TAB_KEY, AGENT_PREFERENCE_KEY, MODEL_PREFERENCE_KEY, ACTIVE_REPO_KEY, LAST_QUICK_SESSION_REPO_KEY, NOTIFY_ON_FINISH_KEY, SOUND_ON_FINISH_KEY, COLLAPSED_REPOS_KEY, COLLAPSED_PARENTS_KEY, ISSUE_FILTERS_KEY, ISSUE_INCLUDE_DONE_KEY };

