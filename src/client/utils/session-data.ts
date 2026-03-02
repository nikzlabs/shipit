import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useThreadStore } from "../stores/thread-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useRepoStore } from "../stores/repo-store.js";

/**
 * Fetch session history via HTTP and populate stores.
 * Shared between useConnectionSync (WS reconnect) and session-actions (session resume).
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/history`);
  const data = await res.json();
  useSessionStore.getState().setMessages(
    data.messages.map((m: { role: string; text: string; toolUse?: unknown[]; images?: unknown[]; files?: unknown[]; isError?: boolean }) => ({ ...m, streaming: false } as ChatMessage)),
  );
  useGitStore.getState().setCommits(data.commits);
  useFileStore.getState().setTree(data.fileTree);
  useThreadStore.getState().setThreads(data.threads);
  useThreadStore.getState().setActiveThreadId(data.activeThreadId);

  // Fetch preview status via HTTP — reliable fallback in case the WS
  // preview_status message is lost during the initial connection burst.
  try {
    const previewRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
    if (previewRes.ok) {
      const ps = await previewRes.json();
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
              const retry = await retryRes.json();
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
  const data = await res.json();
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
  if (data.settings.maxIdleContainers != null) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
  useUiStore.getState().setBootstrapLoaded(true);
}
