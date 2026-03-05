import type { ChatMessage } from "../components/MessageList.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { SessionInfo, RepoInfo, FileTreeNode, FeatureInfo } from "../../server/shared/types.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useRepoStore } from "../stores/repo-store.js";

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
  }[];
  commits: GitCommit[];
  fileTree: FileTreeNode[];
  agentRunning?: boolean;
}

interface BootstrapResponse {
  sessions: SessionInfo[];
  repos?: RepoInfo[];
  agents: AgentOption[];
  templates: TemplateInfo[];
  features?: FeatureInfo[];
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  settings: {
    gitIdentity: { name: string; email: string };
    systemPrompt: string;
    maxIdleContainers?: number | null;
  };
}

/**
 * Fetch session history via HTTP and populate stores.
 * Shared between useConnectionSync (WS reconnect) and session-actions (session resume).
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/history`);
  const data = await res.json() as HistoryResponse;
  useSessionStore.getState().setMessages(
    data.messages.map((m) => ({ ...m, streaming: m.inProgress ?? false } as ChatMessage)),
  );
  if (data.agentRunning) {
    useSessionStore.getState().setIsLoading(true);
  } else {
    useSessionStore.getState().setIsLoading(false);
    useSessionStore.getState().setActivity(undefined);
  }
  useGitStore.getState().setCommits(data.commits);
  useFileStore.getState().setTree(data.fileTree);

  // Fetch preview status via HTTP — reliable fallback in case the WS
  // preview_status message is lost during the initial connection burst.
  try {
    const previewRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
    if (previewRes.ok) {
      const ps = await previewRes.json() as PreviewStatusResponse;
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
          if (usePreviewStore.getState().status) return; // WS delivered it in the meantime
          try {
            const retryRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
            if (retryRes.ok) {
              const retry = await retryRes.json() as PreviewStatusResponse;
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
  useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
  useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
  if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
  useUiStore.getState().setBootstrapLoaded(true);
}
