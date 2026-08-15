import type { ChatMessage } from "../components/MessageList.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { SessionInfo, RepoInfo, FileTreeNode, TurnUsage, SessionUsage, RuntimeMode, CredentialRoute } from "../../server/shared/types.js";
import { turnContextTokens } from "../../server/shared/types.js";
import { getContextWindowForModel } from "../../server/shared/model-windows.js";
import type { ReviewerSlotView } from "../../server/shared/types/agent-types.js";
import type { AgentOption } from "../agent-types.js";
import type { TemplateInfo } from "./template-info.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useBugReportStore, type BugReportCardState } from "../stores/bug-report-store.js";
import { useEgressPromptStore, type EgressPromptCardState } from "../stores/egress-prompt-store.js";
import { usePermissionStore, type PermissionCardState } from "../stores/permission-store.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import { usePresentStore } from "../stores/present-store.js";
import { backgroundTaskLabel } from "../hooks/message-handlers/background-tasks.js";
import type { IssueWriteCard } from "../../server/shared/types.js";

interface PreviewStatusResponse {
  known: boolean;
  running: boolean;
  port: number;
  url: string;
  source: "vite" | "managed" | "detected";
  detectedPorts?: number[];
}

interface HistoryResponse {
  messages: {
    role: string;
    text: string;
    toolUse?: unknown[];
    toolResults?: { toolUseId: string; content: string; isError?: boolean; durationMs?: number }[];
    images?: unknown[];
    files?: unknown[];
    isError?: boolean;
    inProgress?: boolean;
    subagentEvents?: unknown[];
  }[];
  commits: GitCommit[];
  fileTree: FileTreeNode[];
  agentRunning?: boolean;
  /**
   * docs/235 — descriptions of the outstanding agent-initiated background tasks.
   * A session can be between turns (`agentRunning: false`) and still be waiting
   * on work; this is the authoritative snapshot of that state at load time.
   */
  backgroundTasks?: string[];
  /**
   * Per-turn usage series for this session — sourced from `usage_turns` so
   * the ContextDial popover sees a complete history (not just turns observed
   * during the current WS connection).
   */
  turnUsage?: TurnUsage[];
  /** Cumulative session totals — seeds the cost surface on reload. */
  sessionUsage?: SessionUsage | null;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  rewindSnapshot?: {
    sessionId: string;
    action: "chat" | "code" | "both" | "fork";
    expiresAt: number;
  } | null;
  /**
   * docs/093 — durable Present-tab metadata. Rehydrates the present-store on
   * session load so the Present tab survives a reload / session switch / a
   * container restart (the artifact's bytes fetch lazily as today). Metadata
   * only — no `content`.
   */
  presentations?: {
    presentId: string;
    mimeType: string;
    title?: string;
    filePath: string;
    createdAt: string;
  }[];
}

interface BootstrapResponse {
  sessions: SessionInfo[];
  repos?: RepoInfo[];
  agents: AgentOption[];
  templates: TemplateInfo[];
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  settings: {
    /** docs/257 req 8 — server-computed "this install can run a turn". */
    canRunTurns?: boolean;
    /** docs/257 req 9 — when harness onboarding was first completed (ISO). */
    harnessOnboardingCompletedAt?: string;
    gitIdentity: { name: string; email: string };
    systemPrompt: string;
    maxIdleContainers?: number | null;
    agentSystemInstructionsEnabled?: boolean;
    agentSystemInstructions?: string;
    autoCreatePr?: boolean;
    liveSteering?: boolean;
    autoResolveConflicts?: boolean;
    autoFixCi?: boolean;
    autoResetMergedBranch?: boolean;
    enableSubAgents?: boolean;
    providerAccounts?: CredentialRoute[];
    credentialRoutes?: CredentialRoute[];
    /** docs/252 phase 7 (req 9) — the pinned non-turn model, absent for "follow the install". */
    nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string };
    /** docs/252 phase 7 (req 9) — what non-turn work resolves to now, harness included. */
    nonTurnModelResolved?: {
      serviceId: string;
      billingMode: "sub" | "key";
      modelId: string;
      serviceName: string;
      label: string;
      harnessId: string;
      source: "pinned" | "default";
    };
    /** docs/261 phase 3 (req 8) — both reviewer slots, pinned or auto-configured. */
    reviewers?: ReviewerSlotView[];
    /** docs/150 reqs 4-6 — per-provider proactive failover cutoffs, keyed by agent id. */
    failoverCutoffs?: Record<string, { session: number; weekly: number }>;
    accountSelectionMode?: Record<string, "strict" | "balanced">;
  };
  /** Orchestrator runtime mode (feature 118). Defaults to "containerized". */
  runtimeMode?: RuntimeMode;
  /**
   * Tailscale sslip preview host (docs/216). Present only on a Tailscale VPS
   * deploy; routes preview iframes through sslip.io while the app/WS stay on the
   * native MagicDNS host.
   */
  tailnetPreviewHost?: string;
}

/**
 * Monotonic id of the most recently *issued* history load. A response may only
 * be applied if no later load has been issued since — "last request wins",
 * not "last response wins".
 *
 * Without this, more than one load can be in flight at once and the responses
 * can land out of order, because nothing cancels a load when the connection it
 * was issued for is replaced. A window reactivation is the common way in:
 * `useWebSocket` force-reconnects on foreground, so a load issued for the
 * outgoing socket is still in flight when the incoming socket opens and issues
 * its own. When the stale one lands last it does two destructive things:
 *
 *   1. `setMessages` rewinds the transcript to the DB snapshot it read. For a
 *      running turn the DB only holds rows up to the last tool-result boundary,
 *      so everything the turn produced since — text, tool calls, cards — is
 *      wiped. Live events only append after that, so the hole never heals; a
 *      reload repairs it because the DB itself was fine. That is the reported
 *      "messages disappeared on reactivation, reload brought them back".
 *   2. `setHistoryLoaded(true)` fires mid-reconnect, which breaks the ordering
 *      invariant `turn_snapshot` depends on (`useMessageHandler` queues the
 *      snapshot only while history is *not* loaded, so it lands on top of the
 *      baseline). A snapshot dispatched immediately instead applies its
 *      replace-filter against whatever the transcript happens to hold.
 *
 * Scoping by session id alone doesn't catch either — both loads are for the
 * same session.
 */
let historyLoadSeq = 0;

/**
 * The load `historyLoadSeq` currently names, so issuing a newer one can CANCEL
 * it rather than merely discard its answer (planning#375).
 *
 * `historyLoadSeq` alone makes a superseded response harmless, not free: the
 * body is still streamed to the browser and still `JSON.parse`d before the
 * guard above drops it. A DevTools trace of a foreground reconnect caught the
 * cost — two `/history` requests 480 ms apart, **2.67 MB each**, one of them
 * downloaded and parsed purely to be thrown away, on a main thread that was
 * already the bottleneck.
 *
 * Aborting, rather than having the new caller AWAIT the in-flight one: the
 * whole reason a second load exists is that the socket the first was issued for
 * is gone (see the `closed`/`connecting` branch of `useConnectionSync`, which
 * deliberately frees the next open to issue its own). Chaining the fresh load
 * onto a request whose connection is dead would hang the transcript behind a
 * fetch that may never settle — the failure the seq guard was written to avoid,
 * re-introduced from the other side.
 *
 * The seq guard stays regardless: `abort()` races a response that is already
 * being applied, and it is the guard — not the cancellation — that makes
 * out-of-order application impossible.
 */
let inFlightHistoryLoad: { seq: number; controller: AbortController } | null = null;

/**
 * Fetch session history via HTTP and populate stores.
 * Shared between useConnectionSync (WS reconnect) and session-actions (session resume).
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const seq = ++historyLoadSeq;
  // Supersede the previous load — including one for a different session, since
  // `historyLoadSeq` is global and "last request wins" is too.
  inFlightHistoryLoad?.controller.abort();
  const controller = new AbortController();
  inFlightHistoryLoad = { seq, controller };
  let data: HistoryResponse;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/history`, { signal: controller.signal });
    data = await res.json() as HistoryResponse;
  } catch (err) {
    // A load we cancelled ourselves is not a failure. Return rather than throw,
    // matching what a superseded load has always done — `useConnectionSync`
    // relies on that (it logs a throw as "Failed to load session history" and
    // suppresses its retry nudge).
    if (controller.signal.aborted) return;
    throw err;
  } finally {
    if (inFlightHistoryLoad?.seq === seq) inFlightHistoryLoad = null;
  }
  // Still the newest load for this session? A superseded response must not
  // write anything — see `historyLoadSeq`.
  const isStillActiveSession = () =>
    historyLoadSeq === seq && useSessionStore.getState().sessionId === sessionId;
  if (!isStillActiveSession()) {
    return;
  }
  const session = useSessionStore.getState();
  // `inProgress` rides through to the ChatMessage: it marks the rows that
  // belong to a still-running turn, which is exactly the set an attach-time
  // `turn_snapshot` replaces (see `turn-snapshot.ts`). `streaming` stays the
  // narrower "this bubble is being written to" flag the renderer uses.
  session.setMessages(
    data.messages.map((m) => ({
      ...m,
      streaming: m.inProgress ?? false,
    } as unknown as ChatMessage)),
  );

  // docs/164 — rehydrate the bug-report store from persisted cards so each
  // `BugReportCard` renders with its correct phase (a filed card comes back
  // "filed" with its issue link; a failed one as an editable draft). Seeding is
  // authoritative — it overwrites any draft a turn-event-buffer replay may have
  // created first on reconnect.
  const persistedCards = data.messages
    .map((m) => (m as { bugReport?: BugReportCardState }).bugReport)
    .filter((b): b is BugReportCardState => !!b && typeof b.cardId === "string" && !!b.phase);
  if (persistedCards.length > 0) {
    useBugReportStore.getState().seedCards(persistedCards);
  }

  // docs/193 / planning#114 — rehydrate the permission store from persisted cards so
  // each `PermissionRequestCard` renders with its correct phase (an approved/
  // denied/expired card comes back resolved, not re-offering Approve/Deny). A
  // still-pending card comes back actionable — the worker holds the request, so
  // the user can answer it after a reload. Authoritative seed wins over a buffer
  // replay.
  const persistedPermissions = data.messages
    .map((m) => (m as { permissionPrompt?: PermissionCardState }).permissionPrompt)
    .filter((p): p is PermissionCardState => !!p && typeof p.requestId === "string" && !!p.phase);
  if (persistedPermissions.length > 0) {
    usePermissionStore.getState().seedCards(persistedPermissions);
  }

  // docs/172 / planning#92 — rehydrate the egress-prompt store from persisted cards so
  // each `EgressPromptCard` renders with its correct phase (a resolved card comes
  // back resolved, not re-offering the buttons). Authoritative seed wins over a
  // buffer replay.
  const persistedEgress = data.messages
    .map((m) => (m as { egressPrompt?: EgressPromptCardState }).egressPrompt)
    .filter((e): e is EgressPromptCardState => !!e && typeof e.cardId === "string" && !!e.phase);
  if (persistedEgress.length > 0) {
    useEgressPromptStore.getState().seedCards(persistedEgress);
  }

  // docs/177 — rehydrate the issue-write store from persisted provenance cards
  // so each `IssueWriteCard` renders with its correct undo state (an undone
  // card comes back "undone", not re-offering Undo). Authoritative seed wins
  // over a buffer replay.
  const persistedWrites = data.messages
    .map((m) => (m as { issueWrite?: IssueWriteCard }).issueWrite)
    .filter((w): w is IssueWriteCard => !!w && typeof w.cardId === "string" && !!w.undoState);
  if (persistedWrites.length > 0) {
    useIssueWriteStore.getState().seedCards(persistedWrites);
  }

  // docs/093 — rehydrate the Present tab from durable metadata so it survives a
  // reload / session switch / container restart. `hydrate` replaces the list
  // without bumping the unseen badge or auto-switching the panel (silent sync),
  // is idempotent by presentId, and preserves any already-fetched bytes — so it
  // and the WS `present_state` replay can't double-render. Always called (even
  // empty) so a now-cleared session drops a stale tab.
  usePresentStore.getState().hydrate(data.presentations ?? []);

  // docs/235 — reconcile the standing background-task marker from the payload
  // before deciding the chat status line. This load is authoritative for THIS
  // session (and only this session): it carries the descriptions the SSE
  // `session_attention` snapshot has no room for, so switching in upgrades the
  // unnamed fallback label to the named one.
  const backgroundTasks = data.backgroundTasks ?? [];
  session.setBackgroundTaskSessions((prev) => {
    const next = new Map(prev);
    if (backgroundTasks.length > 0) { next.set(sessionId, backgroundTasks); } else { next.delete(sessionId); }
    return next;
  });

  if (data.agentRunning) {
    session.setIsLoading(true);
  } else if (backgroundTasks.length > 0) {
    // Between turns with work outstanding the session is not idle, it is
    // waiting — clearing the bar here reads as "finished". This is the same
    // rule `handleSessionStatus` applies at turn end; without it, hydration
    // raced the live/replayed `background_tasks` message and wiped the status
    // line a moment after the switch. `tool` is deliberately left unset — no
    // tool call is running, so the tool spinner would be a lie.
    session.setIsLoading(true);
    session.setActivity({ label: backgroundTaskLabel(backgroundTasks) });
  } else {
    session.setIsLoading(false);
    session.setActivity(undefined);
  }
  session.setHistoryLoaded(true);
  if (data.rewindSnapshot) {
    session.setRewindRecovery(data.rewindSnapshot);
  }
  useGitStore.getState().setCommits(data.commits);
  useFileStore.getState().setTree(data.fileTree);

  // Seed cost surfaces from the authoritative usage store on reload, so the
  // ContextDial doesn't have to wait for a fresh `usage_update` to know what
  // the session has cost so far.
  const ui = useUiStore.getState();
  if (data.turnUsage) {
    session.setTurnUsageForSession(sessionId, data.turnUsage);
    if (data.turnUsage.length > 0) {
      // Real context occupancy = uncached input + cache reads + cache writes;
      // `inputTokens` alone undercounts massively under prompt caching.
      ui.setContextTokens(turnContextTokens(data.turnUsage[data.turnUsage.length - 1]));
    }
    // Seed `modelInfo` from the most recent turn that recorded a model. The
    // server only emits `model_info` over WS on `agent_init`, so a session
    // loaded from history (page reload, session switch) where the agent isn't
    // actively running has no other way to know which model was last used.
    // Without this seeding the context dial — the surface that also shows the
    // running session cost — would hide entirely until the next turn fires.
    const lastWithModel = [...data.turnUsage].reverse().find((t) => t.model);
    if (lastWithModel?.model) {
      ui.setModelInfo({
        model: lastWithModel.model,
        contextWindowTokens: getContextWindowForModel(lastWithModel.model),
      });
    }
  }
  if (data.sessionUsage) {
    ui.setCurrentSessionUsage(data.sessionUsage);
  } else {
    ui.setCurrentSessionUsage(null);
  }
  ui.setCumulativeTokens(
    data.cumulativeInputTokens ?? 0,
    data.cumulativeOutputTokens ?? 0,
  );

  // Fetch preview status via HTTP — reliable fallback in case the WS
  // preview_status message is lost during the initial connection burst.
  try {
    const previewRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
    if (!isStillActiveSession()) return;
    if (previewRes.ok) {
      const ps = await previewRes.json() as PreviewStatusResponse;
      if (!isStillActiveSession()) return;
      // Only apply if the store still has no status (WS message may have arrived first)
      if (ps.known && !usePreviewStore.getState().status) {
        usePreviewStore.getState().setStatus({
          running: ps.running,
          port: ps.port,
          url: ps.url,
          source: ps.source,
          detectedPorts: ps.detectedPorts,
        });
      }
      // If preview state is not yet known (runner SSE still connecting),
      // retry once after a delay. By then the runner should have received
      // state from the worker and the HTTP endpoint will return known: true.
      if (!ps.known) {
        setTimeout(async () => {
          if (!isStillActiveSession()) return;
          if (usePreviewStore.getState().status) return; // WS delivered it in the meantime
          try {
            const retryRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
            if (!isStillActiveSession()) return;
            if (retryRes.ok) {
              const retry = await retryRes.json() as PreviewStatusResponse;
              if (!isStillActiveSession()) return;
              if (retry.known && !usePreviewStore.getState().status) {
                usePreviewStore.getState().setStatus({
                  running: retry.running,
                  port: retry.port,
                  url: retry.url,
                  source: retry.source,
                  detectedPorts: retry.detectedPorts,
                });
              }
            }
          } catch { /* non-critical */ }
        }, 3000);
      }
    }
  } catch {
    // Non-critical — WS will deliver the status eventually
  }
}

/**
 * Fetch bootstrap data via HTTP and populate stores.
 */
export async function loadBootstrapData(): Promise<void> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  const data = await res.json() as BootstrapResponse;
  useSessionStore.getState().setSessions(data.sessions);
  if (data.repos) useRepoStore.getState().setRepos(data.repos);
  useUiStore.getState().setAgentList(data.agents);
  useUiStore.getState().setTemplates(data.templates);
  useSettingsStore.getState().setGithubStatus({
    authenticated: data.githubStatus.authenticated,
    username: data.githubStatus.username,
    avatarUrl: data.githubStatus.avatarUrl,
  });
  useGitStore.getState().setIdentity(data.settings.gitIdentity);
  if (!data.settings.gitIdentity.name && !data.settings.gitIdentity.email) {
    useGitStore.getState().setIdentityNeeded(true);
  }
  // docs/257 req 8 — the readers here copy named fields rather than spreading
  // `settings`, so a new one has to be wired by hand or it silently never
  // arrives.
  //
  // `?? false` deliberately, and deliberately UNLIKE the `agent_list` SSE
  // handler, which ignores an absent field instead. This is the authoritative
  // full snapshot: a field missing from it means "the server did not say", and
  // "cannot run" is the safe reading. The SSE event is an incremental push,
  // where a missing field means "no news" and clobbering a good value with
  // `false` would disable a runnable install. (Both are belt-and-braces — the
  // SPA is served by the same orchestrator that answers this request, so a
  // server old enough to omit the field cannot serve a client new enough to
  // read it.)
  useSettingsStore.getState().setCanRunTurns(data.settings.canRunTurns ?? false);
  // docs/257 req 9 — `?? null` for the same reason as `?? false` above: this is
  // the authoritative full snapshot, so an absent field means "never completed"
  // rather than "no news". The SSE handler, an incremental push, ignores an
  // absent field instead.
  useSettingsStore.getState()
    .setHarnessOnboardingCompletedAt(data.settings.harnessOnboardingCompletedAt ?? null);
  useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
  useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
  if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
  if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
  if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
  if (data.settings.autoCreatePr !== undefined) useSettingsStore.getState().setAutoCreatePr(data.settings.autoCreatePr);
  if (data.settings.liveSteering !== undefined) useSettingsStore.getState().setLiveSteering(data.settings.liveSteering);
  if (data.settings.autoResolveConflicts !== undefined) useSettingsStore.getState().setAutoResolveConflicts(data.settings.autoResolveConflicts);
  if (data.settings.autoFixCi !== undefined) useSettingsStore.getState().setAutoFixCi(data.settings.autoFixCi);
  if (data.settings.autoResetMergedBranch !== undefined) useSettingsStore.getState().setAutoResetMergedBranch(data.settings.autoResetMergedBranch);
  if (data.settings.enableSubAgents !== undefined) useSettingsStore.getState().setEnableSubAgents(data.settings.enableSubAgents);
  if (data.settings.providerAccounts) useSettingsStore.getState().setProviderAccounts(data.settings.providerAccounts);
  if (data.settings.credentialRoutes) useSettingsStore.getState().setCredentialRoutes(data.settings.credentialRoutes);
  // docs/252 phase 7 (req 9) — the pin AND the resolved answer, always applied
  // (never guarded on presence): absent means "no pin" / "nothing runnable",
  // which are real states the panel has to render, not a reason to keep a stale
  // value from a previous read.
  useSettingsStore.getState().setNonTurnModel(
    data.settings.nonTurnModel ?? null,
    data.settings.nonTurnModelResolved ?? null,
  );
  // docs/261 phase 3 (req 8) — guarded on presence, unlike the non-turn pair
  // above, because the two cases differ: an absent `nonTurnModel` is the real
  // state "no pin", while an absent `reviewers` only ever means an older server.
  // Clearing the array would empty the Reviewer tab rather than say anything.
  if (data.settings.reviewers) useSettingsStore.getState().setReviewers(data.settings.reviewers);
  useUiStore.getState().setRuntimeMode(data.runtimeMode ?? "containerized");
  useUiStore.getState().setTailnetPreviewHost(data.tailnetPreviewHost ?? null);
  useUiStore.getState().setBootstrapLoaded(true);
}
