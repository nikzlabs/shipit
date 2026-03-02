import type { ChatMessage } from "../components/MessageList.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useThreadStore } from "../stores/thread-store.js";
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
  useUiStore.getState().setBootstrapLoaded(true);
}
