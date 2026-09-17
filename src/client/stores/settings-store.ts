import type { LoginIntegrationId } from "../../server/shared/catalogue/types.js";
import { create } from "zustand";
import type { CredentialRoute, PermissionMode, FileContextRef } from "../../server/shared/types.js";
import type { ReviewerSlotView, RoleView } from "../../server/shared/types/agent-types.js";
import type { EligibleModelOption } from "../agent-types.js";
import {
  getSavedKeybindings, saveKeybindings,
  getSavedPermissionModeBySession, savePermissionModeBySession,
} from "../utils/local-storage.js";
import {
  initialSettingValues,
  mirrorFieldOf,
  recordHolds,
  sameSettingValue,
  settingRequest,
  writeBrowserValue,
} from "./setting-values.js";
import { findSetting, type SettingKey } from "../../server/shared/settings-catalogue/index.js";
import { getKeybindingDef, type KeybindingId } from "../keybindings/registry.js";
import type { AgentAuthPhase, WsAgentAuthLog } from "../../server/shared/types/ws-server-messages/auth.js";

/** An uncommitted edit, and the stored value it started from. */
export interface SettingDraft {
  seed: unknown;
  value: unknown;
}

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

function withKey<T>(map: Record<string, T>, key: string, value: T | null): Record<string, T> {
  if (value === null) return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
  return { ...map, [key]: value };
}

/**
 * One line of a sign-in's record, for **any** harness — the panel and these
 * types carried a `claude` prefix until every other harness's login needed the
 * same panel. `level` and `source` are taken from the wire message rather than
 * restated, so a new source on the server cannot silently fail to arrive here.
 */
export interface AuthDiagnosticEntry {
  id: string;
  attemptId: string;
  timestamp: string;
  level: WsAgentAuthLog["level"];
  source: WsAgentAuthLog["source"];
  message: string;
}

export interface AuthDiagnostics {
  attemptId: string | null;
  active: boolean;
  phase: AgentAuthPhase | null;
  message: string | null;
  elapsedMs?: number;
  failedMessage?: string;
  entries: AuthDiagnosticEntry[];
}

export const EMPTY_AUTH_DIAGNOSTICS: AuthDiagnostics = Object.freeze({
  attemptId: null,
  active: false,
  phase: null,
  message: null,
  entries: [] as AuthDiagnosticEntry[],
});

const MAX_AUTH_DIAGNOSTIC_ENTRIES = 200;

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
   * docs/308-data-driven-settings — every generated row's value, keyed by
   * `SettingKey`, hydrated from the settings payload by `wire` and from
   * `localStorage` by `localStorageKey`.
   *
   * The named fields below are a view over it: {@link SettingsState.setSettingValue}
   * writes both, and every setter for a generated setting goes through it, so
   * the two cannot disagree (inventory.md P1, P18).
   */
  settingValues: Record<string, unknown>;
  /**
   * docs/308-data-driven-settings — what the user has typed into an
   * explicit-commit row and not saved yet, keyed by `SettingKey`.
   *
   * It lives beside the values rather than inside the control because the Save
   * that commits it is not the control's: one button commits every edited row
   * on its tab in a single write, which is what the catalogue's own
   * `instructions.commit` exclusion says the instruction boxes do.
   *
   * A draft exists from the first keystroke until the write carrying it lands or
   * the dialog closes, and is never dropped for looking unchanged — so a box
   * that was typed in always shows what was typed. `seed` is the stored value it
   * started from, and it is what says whether a value that moved underneath the
   * dialog moved because of somebody else (inventory.md P14).
   */
  settingDrafts: Record<string, SettingDraft>;
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
  /**
   * Whether the user has instructions of their own — the only thing outside the
   * Instructions tab that cares, and it only tints the settings button. The
   * instruction TEXT is a generated row's value and lives in the record.
   */
  hasSystemPrompt: boolean;
  /**
   * Default permission mode used by the pre-session (new-session) view and
   * as a fallback for any session that hasn't made an explicit choice yet.
   * Plan mode is a per-conversation choice, so this is intentionally NOT
   * persisted to localStorage — it resets to "auto" on page reload.
   */
  permissionMode: PermissionMode;

  permissionModeBySession: Record<string, PermissionMode>;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };

  githubRateLimit: { resetAt: number | null } | null;
  pendingFiles: FileContextRef[];
  memoryBudgetMb: number | null;
  agentSystemInstructions: string;
  compactConversation: boolean;
  notifyOnFinish: boolean;
  soundOnFinish: boolean;

  keybindings: Record<string, string>;

  voiceInputEnabled: boolean;
  sttProvider: string;
  cleanupEnabled: boolean;
  voiceLanguage: string;
  voicePlaybackEnabled: boolean;
  ttsProvider: string;
  ttsVoice: string;
  ttsSpeed: number;

  voiceDeliveryMode: "native" | "external" | "both";

  voiceHandsFree: boolean;
  liveSteering: boolean;

  autoResolveConflicts: boolean;

  autoFixCi: boolean;
  sessionStatusCard: boolean;

  autoResetMergedBranch: boolean;

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

  authDiagnostics: Record<string, AuthDiagnostics>;
  /**
   * Which accounts' output buffers the user has opened, keyed by account id.
   *
   * Here rather than left to the `<details>` element because the disclosure is
   * rendered by two different components across one sign-in — the waiting panel
   * and then the challenge — so the element itself is destroyed and rebuilt at
   * the moment the code arrives. Uncontrolled, the buffer a user had open
   * snapped shut under them, and the panel jumped by the height of it.
   */
  authOutputOpen: Record<string, boolean>;
  providerAccounts: CredentialRoute[];

  credentialRoutes: CredentialRoute[];

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
        // Absent where background work runs as a direct provider call (docs/299 req 2).
        harnessId?: string;
        /** Which of the two ran it, so the client never reads an absent harness as a state. */
        execution?: "harness" | "direct";
        source: "pinned" | "default";
      }
    | null;
  /**
   * docs/299 req 3 — what the background-work selector may offer.
   *
   * NOT `eligibleModelsOf(agentList)`, and that is the whole point of the field:
   * that list is the union over installed harnesses, so a model provider
   * reachable only by a direct call is missing from it however well the server
   * resolves one. Computed server-side from the same search the resolver runs,
   * hydrated from `GET /api/bootstrap` and pushed on every `agent_list` SSE — so
   * adding a credential fills the picker in an open Settings tab rather than on
   * the next reload.
   */
  backgroundWorkModels: EligibleModelOption[];
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

  providerAccountAuths: Record<string, ProviderAccountAuth>;

  providerAccountAuthErrors: Record<string, string>;

  setCanRunTurns: (canRun: boolean) => void;

  setHarnessOnboardingCompletedAt: (at: string | null) => void;

  setProviderAccountNotice: (loginId: LoginIntegrationId, notice: ProviderAccountNotice | null) => void;
  setHasSystemPrompt: (has: boolean) => void;
  setAgentSystemInstructions: (text: string) => void;
  /** Update one generated setting's value in the browser, record and mirror alike. */
  setSettingValue: (key: SettingKey, value: unknown) => void;
  /** Hold an uncommitted edit. `seed` is used only when the draft is a new one. */
  setSettingDraft: (key: SettingKey, value: unknown, seed: unknown) => void;
  /** A committed write's effect on the drafts it wrote. */
  settleSettingDrafts: (committed: readonly { key: SettingKey; value: unknown }[]) => void;
  /** Discard every uncommitted edit, which is what closing the dialog does. */
  clearSettingDrafts: () => void;

  getKeybinding: (id: KeybindingId) => string;

  setKeybinding: (id: KeybindingId, chord: string) => void;

  resetKeybinding: (id: KeybindingId) => void;

  setFailoverCutoffs: (modeKey: string, cutoffs: { session: number; weekly: number }) => void;
  setAccountSelectionMode: (modeKey: string, mode: "strict" | "balanced") => void;
  setAuthProgress: (accountId: string, progress: {
    attemptId: string;
    phase: AgentAuthPhase;
    message: string;
    elapsedMs?: number;
  }) => void;
  appendAuthLog: (accountId: string, entry: Omit<AuthDiagnosticEntry, "id">) => void;
  finishAuthDiagnostics: (
    accountId: string,
    status: "complete" | "failed",
    message?: string,
  ) => void;
  setAuthOutputOpen: (accountId: string, open: boolean) => void;
  setProviderAccounts: (accounts: CredentialRoute[]) => void;
  setCredentialRoutes: (routes: CredentialRoute[]) => void;

  setNonTurnModel: (
    pinned: SettingsState["nonTurnModel"],
    resolved: SettingsState["nonTurnModelResolved"],
  ) => void;
  setBackgroundWorkModels: (models: EligibleModelOption[]) => void;
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

  setProviderAccountAuth: (loginId: LoginIntegrationId, accountId: string, auth: ProviderAccountAuth | null) => void;

  setProviderAccountAuthError: (loginId: LoginIntegrationId, accountId: string, message: string | null) => void;

  setPermissionMode: (sessionId: string | undefined, mode: PermissionMode) => void;

  getPermissionMode: (sessionId: string | undefined) => PermissionMode;
  setGithubStatus: (status: { authenticated: boolean; username?: string; avatarUrl?: string }) => void;
  setGithubRateLimit: (state: { resetAt: number | null } | null) => void;
  addPendingFile: (filePath: string) => void;
  removePendingFile: (index: number) => void;
  clearPendingFiles: () => void;
  setPendingFiles: (files: FileContextRef[]) => void;
  reset: () => void;

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

const INITIAL_SETTING_VALUES = initialSettingValues();

/**
 * A generated setting's seeded value, for the named field that mirrors it (P1).
 *
 * The record already holds what the browser had stored, decoded by the value
 * kind's own codec, so a mirror reads it rather than the storage key a second
 * time. The narrowing is for the field's type; the codec is what makes it true.
 */
function initial(key: SettingKey): boolean {
  return INITIAL_SETTING_VALUES[key] === true;
}

function initialText(key: SettingKey): string {
  const value = INITIAL_SETTING_VALUES[key];
  return typeof value === "string" ? value : "";
}

function initialNumber(key: SettingKey): number {
  const value = INITIAL_SETTING_VALUES[key];
  return typeof value === "number" ? value : 1;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settingValues: INITIAL_SETTING_VALUES,
  settingDrafts: {},
  canRunTurns: false,
  harnessOnboardingCompletedAt: null,
  providerAccountNotices: {},
  hasSystemPrompt: false,
  permissionMode: "auto",
  permissionModeBySession: getSavedPermissionModeBySession(),
  githubStatus: { authenticated: false },
  githubRateLimit: null,
  pendingFiles: [],
  memoryBudgetMb: null,
  agentSystemInstructions: "",
  compactConversation: initial("advanced.compactConversation"),
  notifyOnFinish: initial("advanced.notifyOnFinish"),
  soundOnFinish: initial("advanced.soundOnFinish"),
  keybindings: getSavedKeybindings(),
  voiceInputEnabled: initial("voice.inputEnabled"),
  sttProvider: initialText("voice.sttProvider"),
  cleanupEnabled: initial("voice.cleanupEnabled"),
  voiceLanguage: initialText("voice.language"),
  voicePlaybackEnabled: initial("voice.playbackEnabled"),
  ttsProvider: initialText("voice.ttsProvider"),
  ttsVoice: initialText("voice.ttsVoice"),
  ttsSpeed: initialNumber("voice.ttsSpeed"),
  voiceDeliveryMode: "native",
  voiceHandsFree: initial("voice.handsFree"),
  liveSteering: initial("advanced.liveSteering"),
  autoResolveConflicts: initial("advanced.autoResolveConflicts"),
  autoFixCi: initial("advanced.autoFixCi"),
  sessionStatusCard: initial("advanced.sessionStatusCard"),
  autoResetMergedBranch: initial("advanced.autoResetMergedBranch"),
  enableSubAgents: initial("advanced.enableSubAgents"),
  failoverCutoffs: {},
  accountSelectionMode: {},
  authDiagnostics: {},
  authOutputOpen: {},
  providerAccounts: [],
  credentialRoutes: [],
  nonTurnModel: null,
  nonTurnModelResolved: null,
  backgroundWorkModels: [],
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

  setAgentSystemInstructions: (text) => set({ agentSystemInstructions: text }),

  setSettingValue: (key, value) => {
    const declaration = findSetting(key);
    if (!declaration) return;
    // A browser setting's store IS `localStorage`, so the record and the disk
    // move together and there is no second call anyone can forget to make.
    if (declaration.store.kind === "browser") writeBrowserValue(declaration, value);
    const field = mirrorFieldOf(declaration);
    set((state) => ({
      ...(recordHolds(key) ? { settingValues: { ...state.settingValues, [key]: value } } : {}),
      // Only a field the store already holds: `wire` also names payload fields
      // that other stores own, and writing one here would invent it.
      ...(field && field in state ? { [field]: value } : {}),
    }));
  },

  setSettingDraft: (key, value, seed) =>
    set((state) => ({
      settingDrafts: {
        ...state.settingDrafts,
        // The seed is whatever the FIRST edit started from: re-seeding on every
        // keystroke would make an outside change look like the user's own.
        [key]: { seed: state.settingDrafts[key]?.seed ?? seed, value },
      },
    })),

  /**
   * What a successful write does to the drafts it carried.
   *
   * A draft still holding the value that was sent is **done** and goes. One the
   * user has typed in since — a save is a round trip, and typing does not stop
   * for it — is their unsaved work and stays; its seed advances to what is now
   * stored, because this write is the user's own and not the outside change the
   * seed exists to detect.
   */
  settleSettingDrafts: (committed) =>
    set((state) => {
      const done = new Set(
        committed
          .filter(({ key, value }) => sameSettingValue(state.settingDrafts[key]?.value, value))
          .map(({ key }) => key as string),
      );
      const kept: Record<string, SettingDraft> = Object.fromEntries(
        Object.entries(state.settingDrafts).filter(([key]) => !done.has(key)),
      );
      for (const { key } of committed) {
        const draft = kept[key];
        if (draft) kept[key] = { seed: state.settingValues[key], value: draft.value };
      }
      return { settingDrafts: kept };
    }),

  clearSettingDrafts: () => { set({ settingDrafts: {} }); },

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

  setFailoverCutoffs: (modeKey, cutoffs) =>
    set((s) => ({ failoverCutoffs: { ...s.failoverCutoffs, [modeKey]: cutoffs } })),
  setAccountSelectionMode: (modeKey, mode) =>
    set((s) => ({ accountSelectionMode: { ...s.accountSelectionMode, [modeKey]: mode } })),
  setAuthProgress: (accountId, progress) =>
    set((state) => {
      const current = state.authDiagnostics[accountId] ?? EMPTY_AUTH_DIAGNOSTICS;
      const isNewAttempt = current.attemptId !== progress.attemptId;
      return {
        authDiagnostics: {
          ...state.authDiagnostics,
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
  appendAuthLog: (accountId, entry) =>
    set((state) => {
      const current = state.authDiagnostics[accountId] ?? EMPTY_AUTH_DIAGNOSTICS;
      const isNewAttempt = current.attemptId !== entry.attemptId;
      const kept = isNewAttempt ? [] : current.entries;
      const entries = [
        ...kept,
        { ...entry, id: `${entry.attemptId}:${entry.timestamp}:${kept.length}` },
      ].slice(-MAX_AUTH_DIAGNOSTIC_ENTRIES);
      return {
        authDiagnostics: {
          ...state.authDiagnostics,
          [accountId]: {
            ...current,
            attemptId: entry.attemptId,
            active: isNewAttempt ? true : current.active,
            entries,
          },
        },
      };
    }),
  finishAuthDiagnostics: (accountId, status, message) =>
    set((state) => {
      const current = state.authDiagnostics[accountId];

      // that never ran a challenge.
      if (!current) return {};
      return {
        authDiagnostics: {
          ...state.authDiagnostics,
          [accountId]: {
            ...current,
            active: false,
            phase: status,
            // The provider's own wording arrives as `message`; this is the
            // fallback for a login that has none, so it names no harness.
            message: message ?? (status === "complete" ? "Sign-in completed." : "Sign-in failed."),
            ...(status === "failed" && message ? { failedMessage: message } : {}),
          },
        },
      };
    }),
  setAuthOutputOpen: (accountId, open) =>
    set((state) => ({
      authOutputOpen: { ...state.authOutputOpen, [accountId]: open },
    })),

  setProviderAccounts: (accounts) => set({ providerAccounts: accounts }),
  setCredentialRoutes: (routes) => set({ credentialRoutes: routes }),
  setNonTurnModel: (pinned, resolved) => set({ nonTurnModel: pinned, nonTurnModelResolved: resolved }),
  setBackgroundWorkModels: (models) => set({ backgroundWorkModels: models }),
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

  /*
    The address is `integrations.github.connection`'s, so this names neither the
    path nor the field the token travels in (docs/308-data-driven-settings
    req 1). It stays a store action because the first-run gate submits the same
    token as the settings row, and because the answer seeds two things the
    browser holds: the account, and the repositories the Add Repository dialog
    lists.
  */
  submitGitHubToken: async (token) => {
    const declaration = findSetting("integrations.github.connection");
    const request = declaration && settingRequest(declaration, token);
    if (!request) return null;
    const res = await fetch(request.path, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
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
