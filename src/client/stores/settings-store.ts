import type { LoginIntegrationId } from "../../server/shared/catalogue/types.js";
import { create } from "zustand";
import type { CredentialRoute, PermissionMode, FileContextRef } from "../../server/shared/types.js";
import type { ReviewerSlotView, RoleView } from "../../server/shared/types/agent-types.js";
import {
  getSavedNotifyOnFinish, saveNotifyOnFinish,
  getSavedSoundOnFinish, saveSoundOnFinish,
  getSavedVoiceInputEnabled, saveVoiceInputEnabled,
  getSavedSttProvider, saveSttProvider,
  getSavedCleanupEnabled, saveCleanupEnabled,
  getSavedVoiceLanguage, saveVoiceLanguage,
  getSavedVoicePlaybackEnabled, saveVoicePlaybackEnabled,
  getSavedVoiceHandsFree, saveVoiceHandsFree,
  getSavedTtsProvider, saveTtsProvider,
  getSavedTtsVoice, saveTtsVoice,
  getSavedTtsSpeed, saveTtsSpeed,
  getSavedKeybindings, saveKeybindings,
  getSavedPermissionModeBySession, savePermissionModeBySession,
} from "../utils/local-storage.js";
import { isValidVoice, defaultVoiceFor, providerSpeeds } from "../../server/shared/voice-catalog.js";
import { getKeybindingDef, type KeybindingId } from "../keybindings/registry.js";
import type { AgentAuthPhase } from "../../server/shared/types/ws-server-messages/auth.js";

/**
 * An in-flight sign-in challenge for one connected account.
 *
 * docs/150-multiple-provider-subscriptions req 19 — this replaced a pair of provider-wide slots
 * (`codexDeviceAuth` for Codex's device code, `sessionStore.authUrl` for
 * Claude's paste URL) that could only ever describe *one* sign-in per
 * provider. Two rows connecting at once overwrote each other, and neither slot
 * could say which account it belonged to. Both are gone; every challenge is
 * keyed by {@link providerAccountAuthKey}.
 *
 * The server still pushes them as `agent_auth_pending` with `details.kind`
 * `"device-code"` (Codex) or `"code-paste-url"` (Claude), cleared on
 * `agent_auth_complete` / `agent_auth_failed`. See
 * docs/119-codex-subscription-auth/plan.md and docs/155 Phase 2b.
 */
/**
 * Keyed by the LOGIN FLOW that produced the challenge, not by the harness that
 * will consume the credential — matching the `agent_auth_*` wire shape. The
 * writer (the SSE handler) and the readers (the Settings rows) must agree on
 * this key or a challenge silently renders nowhere, which is why the parameter
 * is typed rather than a bare string.
 */
export interface ProviderAccountAuth {
  loginId: LoginIntegrationId;
  accountId: string;
  verificationUri: string;
  userCode?: string;
}

/**
 * docs/150-multiple-provider-subscriptions req 16 — key for the per-account sign-in maps below.
 *
 * Sign-in state used to live in a single slot, which was only ever correct
 * because exactly one account could be connecting at a time. Once every
 * account (including the first) connects through its own row, two rows can be
 * mid-challenge simultaneously — and a single slot silently shows account B's
 * device code on account A's row. Keying by provider *and* account id keeps
 * each row's challenge, error, and completion independent.
 */
export function providerAccountAuthKey(loginId: LoginIntegrationId, accountId: string): string {
  return `${loginId}:${accountId}`;
}

/** Immutably set `key` to `value`, or drop it entirely when `value` is null. */
function withKey<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  if (value === null) return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
  return { ...map, [key]: value };
}

export interface ClaudeAuthDiagnosticEntry {
  id: string;
  attemptId: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  source: "shipit" | "claude_stdout" | "claude_stderr" | "claude_control";
  message: string;
}

export interface ClaudeAuthDiagnostics {
  attemptId: string | null;
  active: boolean;
  phase: AgentAuthPhase | null;
  message: string | null;
  elapsedMs?: number;
  failedMessage?: string;
  entries: ClaudeAuthDiagnosticEntry[];
}

/**
 * The empty diagnostics an account with no sign-in attempt yet reads as.
 *
 * A module-level frozen constant, not an object literal in the selector: a
 * fresh object every render would give `useSyncExternalStore` a new snapshot
 * each time and loop forever.
 */
export const EMPTY_CLAUDE_AUTH_DIAGNOSTICS: ClaudeAuthDiagnostics = Object.freeze({
  attemptId: null,
  active: false,
  phase: null,
  message: null,
  entries: [] as ClaudeAuthDiagnosticEntry[],
});

const MAX_CLAUDE_AUTH_DIAGNOSTIC_ENTRIES = 200;

/**
 * docs/257 req 5 — an inline result or failure on a provider's accounts card.
 *
 * Two kinds, because req 5 moves both halves of what used to be a toast: a
 * failure to report, and the *result* of a successful disconnect ("moved N
 * sessions", "N sessions have no connected account").
 */
export interface ProviderAccountNotice {
  kind: "error" | "info";
  message: string;
}

interface SettingsState {
  /**
   * docs/257 req 8 — whether this install can actually run a turn, as computed
   * by the server (`computeCanRunTurns`). Never re-derived here from
   * `agentList`: the composer, the starter-prompts gate and (from phase 2) the
   * onboarding panel must read one fact, and a second derivation in the browser
   * is exactly how they come to disagree.
   *
   * Hydrated from `GET /api/bootstrap` and pushed on every `agent_list` SSE.
   * The `false` default is only ever read before bootstrap lands, which is why
   * consumers gate on `bootstrapLoaded` (see `utils/chat-runnable.ts`) rather
   * than trusting it — a pre-bootstrap `false` would otherwise flash a disabled
   * composer at an install that is perfectly runnable.
   */
  canRunTurns: boolean;
  /**
   * docs/257 req 9 — when harness onboarding was first completed (ISO), or
   * `null` for never.
   *
   * The onboarding panel's presence is this being `null` (and the GitHub gate
   * not being up). It is a HISTORICAL fact, computed and persisted server-side:
   * removing every credential later leaves it set, so the panel does not come
   * back for a user who is not new. Hydrated from `GET /api/bootstrap` and
   * pushed on every `agent_list` SSE.
   */
  harnessOnboardingCompletedAt: string | null;
  /**
   * docs/257 req 5 — a CARD-level result or failure for one provider's
   * accounts, keyed by provider.
   *
   * **In the store rather than in component state, because every notice that
   * lands here outlives the thing that produced it.** Three cases, and each one
   * would be lost in local state:
   *
   *  - A refused *duplicate* account arrives as an `agent_auth_failed` SSE, and
   *    a handler outside React has no other channel into a component it does
   *    not render (docs/150-multiple-provider-subscriptions req 22).
   *  - A **successful** disconnect of the LAST account removes the account, and
   *    `ServicesPanel` then stops rendering that service's card entirely — so a
   *    notice held in the card's own state unmounts in the same commit that
   *    sets it, and the user never learns which sessions were stranded. The
   *    panel keeps a card mounted while it has a notice to show, which is what
   *    makes this durable rather than merely relocated.
   *  - A failover cutoff is flushed from an **unmount cleanup**, where the
   *    component's state and setters are already gone.
   */
  providerAccountNotices: Partial<Record<LoginIntegrationId, ProviderAccountNotice>>;
  hasSystemPrompt: boolean;
  systemPromptContent: string;
  /**
   * Default permission mode used by the pre-session (new-session) view and
   * as a fallback for any session that hasn't made an explicit choice yet.
   * Plan mode is a per-conversation choice, so this is intentionally NOT
   * persisted to localStorage — it resets to "auto" on page reload.
   */
  permissionMode: PermissionMode;
  /**
   * Per-session permission mode overrides. Keyed by session id. A session
   * without an entry inherits `permissionMode`. This map is what prevents
   * plan-mode state from leaking between sessions. Unlike the global default
   * above, this IS persisted to localStorage (via `setPermissionMode`) so a
   * page reload restores a session's true mode instead of falling back to
   * "auto" — the silent-drift that wedged plan-pinned streaming sessions.
   */
  permissionModeBySession: Record<string, PermissionMode>;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  /**
   * GitHub API rate-limit state, pushed by the server via SSE
   * (`gh_rate_limited` / `gh_rate_limited_cleared`). `resetAt` is epoch ms;
   * `null` means the limit is active but the server didn't get a reset
   * timestamp back from GitHub. `null` whole field means "not limited."
   */
  githubRateLimit: { resetAt: number | null } | null;
  pendingFiles: FileContextRef[];
  maxIdleContainers: number;
  agentSystemInstructionsEnabled: boolean;
  agentSystemInstructions: string;
  notifyOnFinish: boolean;
  soundOnFinish: boolean;
  /**
   * docs/180 — keyboard-shortcut overrides (binding id → chord). Only entries
   * the user has customized are stored; everything else falls back to the
   * registry default. Resolve with `getKeybinding(id)` or the `useKeybinding`
   * hook.
   */
  keybindings: Record<string, string>;
  /** docs/144 — voice dictation + playback settings (non-credential; the API key is server-side only). */
  voiceInputEnabled: boolean;
  sttProvider: string;
  cleanupEnabled: boolean;
  voiceLanguage: string;
  voicePlaybackEnabled: boolean;
  ttsProvider: string;
  ttsVoice: string;
  ttsSpeed: number;
  /**
   * docs/163 — voice-note delivery mode (native / external / both). Persisted
   * server-side (it drives the router); mirrored here from global settings.
   */
  voiceDeliveryMode: "native" | "external" | "both";
  /** docs/163 — whether an external voice-note webhook is configured (server-side). */
  voiceWebhookConfigured: boolean;
  /**
   * docs/163 — hands-free mode. OFF by default. When ON, native voice notes
   * autoplay (with a debounced chime). Client-only (localStorage); the server
   * always produces the note, the client decides whether to autoplay.
   */
  voiceHandsFree: boolean;
  autoCreatePr: boolean;
  liveSteering: boolean;
  /** docs/146 — global gate for the auto-resolve-conflicts loop. */
  autoResolveConflicts: boolean;
  /** docs/169 — global gate for the auto-fix-CI loop. */
  autoFixCi: boolean;
  /** docs/218 — global gate for auto-resetting a merged session's branch on continue. */
  autoResetMergedBranch: boolean;
  /** docs/144 — global gate for sub-agent spawning. */
  enableSubAgents: boolean;
  /**
   * docs/150-multiple-provider-subscriptions reqs 4-6 — per-provider proactive failover cutoffs, keyed by agent
   * id. Reaching either window's cutoff moves new work to the next eligible
   * credential. docs/252 phase 2 — keyed by `credentialModeKey(serviceId,
   * billingMode)`, with one entry per SUBSCRIPTION mode in the catalogue (keys
   * do not fail over, so they get none). The server always sends every entry,
   * so the client never has to know the 90% default.
   */
  failoverCutoffs: Record<string, { session: number; weekly: number }>;
  /**
   * docs/150-multiple-provider-subscriptions req 21 — selection mode. Same key and the same contract as
   * `failoverCutoffs`, so the client never encodes the "strict" default.
   */
  accountSelectionMode: Record<string, "strict" | "balanced">;
  /**
   * Claude CLI sign-in diagnostics, keyed by provider account id (docs/150).
   *
   * One buffer per provider was correct only for as long as two things held at
   * once: `startAccountAuth` refuses a second concurrent per-provider sign-in
   * (409), and the buffer clears whenever `attemptId` changes. Under those, at
   * most one Claude row is ever mid-challenge. Keying by account makes the
   * scoping a property of the DATA instead of a consequence of that
   * serialization guard, so a row can only render its own attempt's output.
   */
  claudeAuthDiagnostics: Record<string, ClaudeAuthDiagnostics>;
  /**
   * Which accounts' output buffers the user has opened, keyed by account id.
   *
   * Here rather than left to the `<details>` element because the disclosure is
   * rendered by two different components across one sign-in — the waiting panel
   * and then the challenge — so the element itself is destroyed and rebuilt at
   * the moment the code arrives. Uncontrolled, the buffer a user had open
   * snapped shut under them, and the panel jumped by the height of it.
   */
  claudeAuthOutputOpen: Record<string, boolean>;
  providerAccounts: CredentialRoute[];
  /**
   * docs/252 phase 2 — every credential the user holds, keyed by
   * `(serviceId, billingMode)` and in selection order within each group.
   * Carries no secret. A superset of `providerAccounts`, which stays while the
   * docs/150 account flow still speaks the account shape.
   */
  credentialRoutes: CredentialRoute[];
  /**
   * docs/252 req 9 — the model non-turn work (session naming, pull-request
   * descriptions) runs on.
   *
   * `null` only before the server has ever written one — it seeds the setting
   * the first time the install can run something, so on any configured install
   * this holds a triple. It stopped meaning "follow the install" on 2026-08-13:
   * that was a second state, and no wording for it survived contact with a
   * reader.
   */
  nonTurnModel: { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
  /**
   * docs/252 phase 7 (req 9) — what non-turn work resolves to right now, pin or
   * no pin, plus the derived harness. Computed server-side so the client never
   * re-derives req 9's rule and drifts from what actually runs. `null` when
   * nothing on this install is runnable.
   */
  nonTurnModelResolved:
    | {
        serviceId: string;
        billingMode: "sub" | "key";
        modelId: string;
        serviceName: string;
        label: string;
        harnessId: string;
        source: "pinned" | "default";
      }
    | null;
  /**
   * docs/261 phase 3 (reqs 1, 5, 8) — both reviewer slots, in the user's order,
   * each labelled pinned or auto-configured and carrying what it resolves to.
   *
   * Computed server-side and never re-derived here. Which harness runs a model,
   * which level it reviews at, and which of the two slots is furthest from the
   * implementer are reqs 3/4/5's rules; a second implementation in the browser
   * would let the Reviewer tab promise something other than what reviews.
   *
   * Hydrated from `GET /api/bootstrap` and pushed on every `agent_list` SSE —
   * that second channel is req 8's re-derivation made visible: adding a service
   * has to improve an auto-configured reviewer while the tab is open, not on
   * the next reload. Empty only before bootstrap lands.
   */
  reviewers: ReviewerSlotView[];
  /**
   * docs/264 phase 2 (req 5) — every agent role this install has, sorted by
   * name, each carrying what it resolves to or why it cannot run.
   *
   * Resolved server-side and never re-derived here, for the reason `reviewers`
   * is: which harness can carry a model and which levels it declares are
   * catalogue rules, and a second implementation in the browser is how the
   * Settings screen starts promising something other than what runs.
   *
   * Hydrated from `GET /api/bootstrap` and pushed on every `agent_list` SSE —
   * that second channel is what makes a role go `disconnected` in an open tab
   * when its service loses its credential, rather than on the next reload.
   * Empty only before bootstrap lands: the reviewer is always among them.
   */
  roles: RoleView[];
  /**
   * In-flight account-scoped sign-in challenges, keyed by
   * {@link providerAccountAuthKey} so concurrent row sign-ins stay independent.
   */
  providerAccountAuths: Record<string, ProviderAccountAuth>;
  /** Last sign-in failure per account, same key space as `providerAccountAuths`. */
  providerAccountAuthErrors: Record<string, string>;

  /** docs/257 — replace the server-computed runnable signal. */
  setCanRunTurns: (canRun: boolean) => void;
  /** docs/257 req 9 — replace the server-persisted onboarding-completed stamp. */
  setHarnessOnboardingCompletedAt: (at: string | null) => void;
  /** docs/257 req 5 — set or clear a provider's card-level notice. */
  setProviderAccountNotice: (loginId: LoginIntegrationId, notice: ProviderAccountNotice | null) => void;
  setHasSystemPrompt: (has: boolean) => void;
  setSystemPromptContent: (content: string) => void;
  setMaxIdleContainers: (n: number) => void;
  setAgentSystemInstructionsEnabled: (enabled: boolean) => void;
  setAgentSystemInstructions: (text: string) => void;
  setNotifyOnFinish: (enabled: boolean) => void;
  setSoundOnFinish: (enabled: boolean) => void;
  /** Resolve a binding to its chord (override or registry default). */
  getKeybinding: (id: KeybindingId) => string;
  /** Set a custom chord for a binding (persisted). */
  setKeybinding: (id: KeybindingId, chord: string) => void;
  /** Clear a binding's override, reverting to the registry default. */
  resetKeybinding: (id: KeybindingId) => void;
  setVoiceInputEnabled: (enabled: boolean) => void;
  setSttProvider: (provider: string) => void;
  setCleanupEnabled: (enabled: boolean) => void;
  setVoiceLanguage: (language: string) => void;
  setVoicePlaybackEnabled: (enabled: boolean) => void;
  setTtsProvider: (provider: string) => void;
  setTtsVoice: (voice: string) => void;
  setTtsSpeed: (speed: number) => void;
  setVoiceDeliveryMode: (mode: "native" | "external" | "both") => void;
  setVoiceWebhookConfigured: (configured: boolean) => void;
  setVoiceHandsFree: (enabled: boolean) => void;
  setAutoCreatePr: (enabled: boolean) => void;
  setLiveSteering: (enabled: boolean) => void;
  setAutoResolveConflicts: (enabled: boolean) => void;
  setAutoFixCi: (enabled: boolean) => void;
  /** `modeKey` is `credentialModeKey(serviceId, billingMode)` — docs/252 phase 2. */
  setFailoverCutoffs: (modeKey: string, cutoffs: { session: number; weekly: number }) => void;
  setAccountSelectionMode: (modeKey: string, mode: "strict" | "balanced") => void;
  setAutoResetMergedBranch: (enabled: boolean) => void;
  setEnableSubAgents: (enabled: boolean) => void;
  setClaudeAuthProgress: (accountId: string, progress: {
    attemptId: string;
    phase: AgentAuthPhase;
    message: string;
    elapsedMs?: number;
  }) => void;
  appendClaudeAuthLog: (accountId: string, entry: Omit<ClaudeAuthDiagnosticEntry, "id">) => void;
  finishClaudeAuthDiagnostics: (
    accountId: string,
    status: "complete" | "failed",
    message?: string,
  ) => void;
  setClaudeAuthOutputOpen: (accountId: string, open: boolean) => void;
  setProviderAccounts: (accounts: CredentialRoute[]) => void;
  setCredentialRoutes: (routes: CredentialRoute[]) => void;
  /** docs/252 phase 7 — apply a `/api/settings` response's non-turn fields. */
  setNonTurnModel: (
    pinned: SettingsState["nonTurnModel"],
    resolved: SettingsState["nonTurnModelResolved"],
  ) => void;
  /**
   * docs/261 phase 3 — replace both reviewer slots with the server's answer.
   *
   * Whole-array replacement rather than a per-slot merge, and deliberately so:
   * the two slots are resolved together (slot 2 is ranked against slot 1), so a
   * partial update could leave the tab showing a pair the server never
   * produced.
   */
  setReviewers: (reviewers: ReviewerSlotView[]) => void;
  /**
   * docs/264 phase 2 — replace the whole role list.
   *
   * Whole-array replacement, like {@link SettingsState.setReviewers}: the server
   * resolves every role together against one credential snapshot, so a per-role
   * merge could leave the tab showing a set the server never produced.
   */
  setRoles: (roles: RoleView[]) => void;
  /** Set (or clear, with `null`) one account's in-flight sign-in challenge. */
  setProviderAccountAuth: (loginId: LoginIntegrationId, accountId: string, auth: ProviderAccountAuth | null) => void;
  /** Set (or clear, with `null`) one account's last sign-in failure message. */
  setProviderAccountAuthError: (loginId: LoginIntegrationId, accountId: string, message: string | null) => void;
  /**
   * Update the permission mode. When `sessionId` is provided, the change is
   * scoped to that session only. When `sessionId` is undefined (e.g. on the
   * pre-session new-session view), the default mode is updated.
   */
  setPermissionMode: (sessionId: string | undefined, mode: PermissionMode) => void;
  /** Resolve the effective permission mode for a session (or the default). */
  getPermissionMode: (sessionId: string | undefined) => PermissionMode;
  setGithubStatus: (status: { authenticated: boolean; username?: string; avatarUrl?: string }) => void;
  setGithubRateLimit: (state: { resetAt: number | null } | null) => void;
  addPendingFile: (filePath: string) => void;
  removePendingFile: (index: number) => void;
  clearPendingFiles: () => void;
  setPendingFiles: (files: FileContextRef[]) => void;
  reset: () => void;

  saveInstructions: (content: string) => Promise<void>;
  submitGitHubToken: (token: string) => Promise<{
    repos: {
      fullName: string;
      description: string | null;
      private: boolean;
      defaultBranch: string;
      cloneUrl: string;
    }[];
  } | null>;
  gitHubLogout: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  canRunTurns: false,
  harnessOnboardingCompletedAt: null,
  providerAccountNotices: {},
  hasSystemPrompt: false,
  systemPromptContent: "",
  permissionMode: "auto",
  permissionModeBySession: getSavedPermissionModeBySession(),
  githubStatus: { authenticated: false },
  githubRateLimit: null,
  pendingFiles: [],
  maxIdleContainers: 5,
  agentSystemInstructionsEnabled: true,
  agentSystemInstructions: "",
  notifyOnFinish: getSavedNotifyOnFinish(),
  soundOnFinish: getSavedSoundOnFinish(),
  keybindings: getSavedKeybindings(),
  voiceInputEnabled: getSavedVoiceInputEnabled(),
  sttProvider: getSavedSttProvider(),
  cleanupEnabled: getSavedCleanupEnabled(),
  voiceLanguage: getSavedVoiceLanguage(),
  voicePlaybackEnabled: getSavedVoicePlaybackEnabled(),
  ttsProvider: getSavedTtsProvider(),
  ttsVoice: getSavedTtsVoice(),
  ttsSpeed: getSavedTtsSpeed(),
  voiceDeliveryMode: "native",
  voiceWebhookConfigured: false,
  voiceHandsFree: getSavedVoiceHandsFree(),
  autoCreatePr: false,
  liveSteering: true,
  autoResolveConflicts: false,
  autoFixCi: false,
  autoResetMergedBranch: true,
  enableSubAgents: false,
  failoverCutoffs: {},
  accountSelectionMode: {},
  claudeAuthDiagnostics: {},
  claudeAuthOutputOpen: {},
  providerAccounts: [],
  credentialRoutes: [],
  nonTurnModel: null,
  nonTurnModelResolved: null,
  reviewers: [],
  roles: [],
  providerAccountAuths: {},
  providerAccountAuthErrors: {},

  setCanRunTurns: (canRun) => set({ canRunTurns: canRun }),

  setHarnessOnboardingCompletedAt: (at) => set({ harnessOnboardingCompletedAt: at }),

  setProviderAccountNotice: (loginId, notice) =>
    set((state) => ({
      providerAccountNotices: notice === null
        ? Object.fromEntries(
            Object.entries(state.providerAccountNotices).filter(([id]) => id !== loginId),
          )
        : { ...state.providerAccountNotices, [loginId]: notice },
    })),

  setHasSystemPrompt: (has) => set({ hasSystemPrompt: has }),

  setSystemPromptContent: (content) => set({ systemPromptContent: content }),

  setMaxIdleContainers: (n) => set({ maxIdleContainers: n }),

  setAgentSystemInstructionsEnabled: (enabled) => set({ agentSystemInstructionsEnabled: enabled }),

  setAgentSystemInstructions: (text) => set({ agentSystemInstructions: text }),

  setNotifyOnFinish: (enabled) => {
    saveNotifyOnFinish(enabled);
    set({ notifyOnFinish: enabled });
  },

  setSoundOnFinish: (enabled) => {
    saveSoundOnFinish(enabled);
    set({ soundOnFinish: enabled });
  },

  getKeybinding: (id) => get().keybindings[id] ?? getKeybindingDef(id).defaultBinding,

  setKeybinding: (id, chord) => {
    const next = { ...get().keybindings, [id]: chord };
    saveKeybindings(next);
    set({ keybindings: next });
  },

  resetKeybinding: (id) => {
    const next = { ...get().keybindings };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by keybinding id
    delete next[id];
    saveKeybindings(next);
    set({ keybindings: next });
  },

  setVoiceInputEnabled: (enabled) => {
    saveVoiceInputEnabled(enabled);
    set({ voiceInputEnabled: enabled });
  },

  setSttProvider: (provider) => {
    saveSttProvider(provider);
    set({ sttProvider: provider });
  },

  setCleanupEnabled: (enabled) => {
    saveCleanupEnabled(enabled);
    set({ cleanupEnabled: enabled });
  },

  setVoiceLanguage: (language) => {
    saveVoiceLanguage(language);
    set({ voiceLanguage: language });
  },

  setVoicePlaybackEnabled: (enabled) => {
    saveVoicePlaybackEnabled(enabled);
    set({ voicePlaybackEnabled: enabled });
  },

  setTtsProvider: (provider) => {
    saveTtsProvider(provider);
    // The saved voice/speed may not exist for the new provider — snap them
    // back to that provider's defaults so playback requests stay valid.
    const { ttsVoice, ttsSpeed } = get();
    const updates: { ttsProvider: string; ttsVoice?: string; ttsSpeed?: number } = { ttsProvider: provider };
    if (!isValidVoice(provider, ttsVoice)) {
      const nextVoice = defaultVoiceFor(provider);
      saveTtsVoice(nextVoice);
      updates.ttsVoice = nextVoice;
    }
    const speeds = providerSpeeds(provider);
    if (!speeds.includes(ttsSpeed)) {
      const nextSpeed = speeds.includes(1) ? 1 : speeds[0];
      saveTtsSpeed(nextSpeed);
      updates.ttsSpeed = nextSpeed;
    }
    set(updates);
  },

  setTtsVoice: (voice) => {
    saveTtsVoice(voice);
    set({ ttsVoice: voice });
  },

  setTtsSpeed: (speed) => {
    saveTtsSpeed(speed);
    set({ ttsSpeed: speed });
  },

  setVoiceDeliveryMode: (mode) => set({ voiceDeliveryMode: mode }),

  setVoiceWebhookConfigured: (configured) => set({ voiceWebhookConfigured: configured }),

  setVoiceHandsFree: (enabled) => {
    saveVoiceHandsFree(enabled);
    set({ voiceHandsFree: enabled });
  },

  setAutoCreatePr: (enabled) => set({ autoCreatePr: enabled }),

  setLiveSteering: (enabled) => set({ liveSteering: enabled }),

  setAutoResolveConflicts: (enabled) => set({ autoResolveConflicts: enabled }),

  setAutoFixCi: (enabled) => set({ autoFixCi: enabled }),
  setFailoverCutoffs: (modeKey, cutoffs) =>
    set((s) => ({ failoverCutoffs: { ...s.failoverCutoffs, [modeKey]: cutoffs } })),
  setAccountSelectionMode: (modeKey, mode) =>
    set((s) => ({ accountSelectionMode: { ...s.accountSelectionMode, [modeKey]: mode } })),
  setAutoResetMergedBranch: (enabled) => set({ autoResetMergedBranch: enabled }),
  setEnableSubAgents: (enabled) => set({ enableSubAgents: enabled }),

  setClaudeAuthProgress: (accountId, progress) =>
    set((state) => {
      const current = state.claudeAuthDiagnostics[accountId] ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;
      const isNewAttempt = current.attemptId !== progress.attemptId;
      return {
        claudeAuthDiagnostics: {
          ...state.claudeAuthDiagnostics,
          [accountId]: {
            attemptId: progress.attemptId,
            active: progress.phase !== "complete" && progress.phase !== "failed",
            phase: progress.phase,
            message: progress.message,
            ...(progress.elapsedMs !== undefined ? { elapsedMs: progress.elapsedMs } : {}),
            entries: isNewAttempt ? [] : current.entries,
          },
        },
      };
    }),
  appendClaudeAuthLog: (accountId, entry) =>
    set((state) => {
      const current = state.claudeAuthDiagnostics[accountId] ?? EMPTY_CLAUDE_AUTH_DIAGNOSTICS;
      const isNewAttempt = current.attemptId !== entry.attemptId;
      const kept = isNewAttempt ? [] : current.entries;
      const entries = [
        ...kept,
        { ...entry, id: `${entry.attemptId}:${entry.timestamp}:${kept.length}` },
      ].slice(-MAX_CLAUDE_AUTH_DIAGNOSTIC_ENTRIES);
      return {
        claudeAuthDiagnostics: {
          ...state.claudeAuthDiagnostics,
          [accountId]: {
            ...current,
            attemptId: entry.attemptId,
            active: isNewAttempt ? true : current.active,
            entries,
          },
        },
      };
    }),
  finishClaudeAuthDiagnostics: (accountId, status, message) =>
    set((state) => {
      const current = state.claudeAuthDiagnostics[accountId];
      // Nothing was recorded for this account, so there is no attempt to
      // finish — inventing one would render an empty diagnostics block on a row
      // that never ran a challenge.
      if (!current) return {};
      return {
        claudeAuthDiagnostics: {
          ...state.claudeAuthDiagnostics,
          [accountId]: {
            ...current,
            active: false,
            phase: status,
            message: message ?? (status === "complete" ? "Claude sign-in completed." : "Claude sign-in failed."),
            ...(status === "failed" && message ? { failedMessage: message } : {}),
          },
        },
      };
    }),
  setClaudeAuthOutputOpen: (accountId, open) =>
    set((state) => ({
      claudeAuthOutputOpen: { ...state.claudeAuthOutputOpen, [accountId]: open },
    })),

  setProviderAccounts: (accounts) => set({ providerAccounts: accounts }),
  setCredentialRoutes: (routes) => set({ credentialRoutes: routes }),
  setNonTurnModel: (pinned, resolved) => set({ nonTurnModel: pinned, nonTurnModelResolved: resolved }),
  setReviewers: (reviewers) => set({ reviewers }),
  setRoles: (roles) => set({ roles }),
  setProviderAccountAuth: (loginId, accountId, auth) =>
    set((state) => ({
      providerAccountAuths: withKey(
        state.providerAccountAuths,
        providerAccountAuthKey(loginId, accountId),
        auth,
      ),
    })),
  setProviderAccountAuthError: (loginId, accountId, message) =>
    set((state) => ({
      providerAccountAuthErrors: withKey(
        state.providerAccountAuthErrors,
        providerAccountAuthKey(loginId, accountId),
        message,
      ),
    })),

  setPermissionMode: (sessionId, mode) => {
    if (sessionId) {
      set((state) => {
        const next = { ...state.permissionModeBySession, [sessionId]: mode };
        // Persist per-session overrides so a reload restores the session's true
        // mode. Without this the chip fell back to the global "auto" default on
        // reload, sent on the wire as `undefined`, which silently left a
        // plan-pinned persistent streaming CLI wedged ("can't exit plan mode").
        // The global default (the `else` branch) stays unpersisted by design.
        savePermissionModeBySession(next);
        return { permissionModeBySession: next };
      });
    } else {
      set({ permissionMode: mode });
    }
  },

  getPermissionMode: (sessionId) => {
    const state = get();
    if (sessionId && sessionId in state.permissionModeBySession) {
      return state.permissionModeBySession[sessionId];
    }
    return state.permissionMode;
  },

  setGithubStatus: (status) => set({ githubStatus: status }),
  setGithubRateLimit: (state) => set({ githubRateLimit: state }),

  addPendingFile: (filePath) =>
    set((state) => {
      if (state.pendingFiles.some((f) => f.path === filePath)) {
        return state;
      }
      return { pendingFiles: [...state.pendingFiles, { path: filePath }] };
    }),

  removePendingFile: (index) =>
    set((state) => ({
      pendingFiles: state.pendingFiles.filter((_, i) => i !== index),
    })),

  clearPendingFiles: () => set({ pendingFiles: [] }),

  setPendingFiles: (files) => set({ pendingFiles: files }),

  reset: () => set({ pendingFiles: [] }),

  saveInstructions: async (content) => {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: content }),
    });
    if (!res.ok) {
      throw new Error(`Failed to save instructions: ${res.status}`);
    }
    const result = await res.json() as { systemPrompt: string };
    set({
      systemPromptContent: result.systemPrompt,
      hasSystemPrompt: !!result.systemPrompt,
    });
  },

  submitGitHubToken: async (token) => {
    const res = await fetch("/api/github/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      return null;
    }
    const result = await res.json() as { status: { authenticated: boolean; username?: string; avatarUrl?: string }; repos: { fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[] };
    set({ githubStatus: result.status });
    return result;
  },

  gitHubLogout: async () => {
    const res = await fetch("/api/github/logout", {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(`Failed to logout from GitHub: ${res.status}`);
    }
    const result = await res.json() as { status: { authenticated: boolean; username?: string; avatarUrl?: string } };
    set({ githubStatus: result.status });
  },
}));
