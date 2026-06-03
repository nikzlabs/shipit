import type { ChatMessage } from "../components/MessageList.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { SessionInfo, RepoInfo, FileTreeNode, TurnUsage, SessionUsage, RuntimeMode, ProviderAccount } from "../../server/shared/types.js";
import { turnContextTokens } from "../../server/shared/types.js";
import { getContextWindowForModel } from "../../server/shared/model-windows.js";
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
    toolResults?: { toolUseId: string; content: string; isError?: boolean }[];
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
}

interface BootstrapResponse {
  sessions: SessionInfo[];
  repos?: RepoInfo[];
  agents: AgentOption[];
  templates: TemplateInfo[];
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  settings: {
    gitIdentity: { name: string; email: string };
    systemPrompt: string;
    maxIdleContainers?: number | null;
    agentSystemInstructionsEnabled?: boolean;
    agentSystemInstructions?: string;
    autoCreatePr?: boolean;
    liveSteering?: boolean;
    autoResolveConflicts?: boolean;
    autoFixCi?: boolean;
    providerAccounts?: ProviderAccount[];
  };
  /** Orchestrator runtime mode (feature 118). Defaults to "containerized". */
  runtimeMode?: RuntimeMode;
  /** Preview subdomain policy from the orchestrator runtime environment. */
  previewSubdomains?: "auto" | "always";
}

/**
 * Fetch session history via HTTP and populate stores.
 * Shared between useConnectionSync (WS reconnect) and session-actions (session resume).
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/history`);
  const data = await res.json() as HistoryResponse;
  const isStillActiveSession = () => useSessionStore.getState().sessionId === sessionId;
  if (!isStillActiveSession()) {
    return;
  }
  const session = useSessionStore.getState();
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
  if (data.agentRunning) {
    session.setIsLoading(true);
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
  useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
  useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
  if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
  if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
  if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
  if (data.settings.autoCreatePr !== undefined) useSettingsStore.getState().setAutoCreatePr(data.settings.autoCreatePr);
  if (data.settings.liveSteering !== undefined) useSettingsStore.getState().setLiveSteering(data.settings.liveSteering);
  if (data.settings.autoResolveConflicts !== undefined) useSettingsStore.getState().setAutoResolveConflicts(data.settings.autoResolveConflicts);
  if (data.settings.autoFixCi !== undefined) useSettingsStore.getState().setAutoFixCi(data.settings.autoFixCi);
  if (data.settings.providerAccounts) useSettingsStore.getState().setProviderAccounts(data.settings.providerAccounts);
  useUiStore.getState().setRuntimeMode(data.runtimeMode ?? "containerized");
  useUiStore.getState().setPreviewSubdomains(data.previewSubdomains ?? "auto");
  useUiStore.getState().setBootstrapLoaded(true);
}
