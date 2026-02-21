import { useEffect, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { ChatMessage, ToolResultBlock } from "../components/MessageList.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { StreamingActivity } from "../components/StreamingIndicator.js";
import { activityFromTool } from "../components/StreamingIndicator.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { FileTreeNode } from "../components/FileTree.js";
import type { LogEntry } from "../components/TerminalPanel.js";
import type { InteractiveTerminalHandle } from "../components/InteractiveTerminal.js";
import type { TemplateInfo } from "../components/TemplateSelector.js";
import type { SessionUsage, UsageStats, TurnTokenData } from "../components/UsageModal.js";
import type { ModelInfo } from "../components/StatusBar.js";
import type { DeployPhase } from "../components/DeployModal.js";
import type { ThreadInfo } from "../components/ThreadIndicator.js";
import type { AgentOption } from "../components/AgentPicker.js";
import type { ToastData } from "../components/Toast.js";
import type { TurnDiffData } from "../components/DiffPanel.js";
import type {
  WsServerMessage, WsSessionRenamed, WsUsageUpdate, WsModelInfo,
  ClaudeContentBlock, ClaudeContentBlockText, ClaudeContentBlockToolUse,
  WsChatHistoryMessage, DeployTargetInfo, DeploymentRecord, FeatureInfo,
  SessionInfo, AgentEvent, AgentContentBlock, WsClientMessage,
  WsMessageQueued, WsQueueUpdated,
} from "../../server/types.js";
import { PERMISSION_MODE_KEY, SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY } from "../utils/local-storage.js";

type RightTab = "preview" | "docs" | "files" | "terminal" | "features" | "changes";

export function useMessageHandler(params: {
  lastMessage: MessageEvent | null;
  send: (msg: WsClientMessage) => void;
  apiGet: <T>(path: string) => Promise<T>;

  // State setters
  setPreview: Dispatch<SetStateAction<PreviewStatus | null>>;
  setSelectedPort: Dispatch<SetStateAction<number | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setActivity: Dispatch<SetStateAction<StreamingActivity | undefined>>;
  setGitCommits: Dispatch<SetStateAction<GitCommit[]>>;
  setAuthUrl: Dispatch<SetStateAction<string | null>>;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setDocFiles: Dispatch<SetStateAction<string[]>>;
  setDocContent: Dispatch<SetStateAction<string | null>>;
  setFileTree: Dispatch<SetStateAction<FileTreeNode[]>>;
  setViewingFileContent: Dispatch<SetStateAction<string | null>>;
  setViewingFileBinary: Dispatch<SetStateAction<boolean>>;
  setLogEntries: Dispatch<SetStateAction<LogEntry[]>>;
  setUnreadLogCount: Dispatch<SetStateAction<number>>;
  setTemplates: Dispatch<SetStateAction<TemplateInfo[]>>;
  setShowTemplates: Dispatch<SetStateAction<boolean>>;
  setCreatingRepo: Dispatch<SetStateAction<boolean>>;
  setSelectedRepoUrl: Dispatch<SetStateAction<string | null>>;
  setGithubStatus: Dispatch<SetStateAction<{ authenticated: boolean; username?: string; avatarUrl?: string }>>;
  setCurrentSessionUsage: Dispatch<SetStateAction<SessionUsage | null>>;
  setAllUsageStats: Dispatch<SetStateAction<UsageStats | null>>;
  setModelInfo: Dispatch<SetStateAction<ModelInfo | null>>;
  setContextTokens: Dispatch<SetStateAction<number>>;
  setTurnTokens: Dispatch<SetStateAction<TurnTokenData[]>>;
  setFileChangeCount: Dispatch<SetStateAction<number>>;
  setHasSystemPrompt: Dispatch<SetStateAction<boolean>>;
  setSystemPromptContent: Dispatch<SetStateAction<string>>;
  setGitIdentityNeeded: Dispatch<SetStateAction<boolean>>;
  setGitIdentity: Dispatch<SetStateAction<{ name: string; email: string }>>;
  setThreads: Dispatch<SetStateAction<ThreadInfo[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string>>;
  setDeployTargets: Dispatch<SetStateAction<DeployTargetInfo[]>>;
  setDeployConfigStatus: Dispatch<SetStateAction<Record<string, { configured: boolean; projectName?: string }>>>;
  setDeployStatus: Dispatch<SetStateAction<DeployPhase | null>>;
  setLastDeployUrl: Dispatch<SetStateAction<string | null>>;
  setLastDeployError: Dispatch<SetStateAction<string | null>>;
  setDeployHistory: Dispatch<SetStateAction<DeploymentRecord[]>>;
  setFeatures: Dispatch<SetStateAction<FeatureInfo[]>>;
  setAgentList: Dispatch<SetStateAction<AgentOption[]>>;
  setShowPRModal: Dispatch<SetStateAction<boolean>>;
  setPrCurrentBranch: Dispatch<SetStateAction<string>>;
  setPrRemoteBranches: Dispatch<SetStateAction<string[]>>;
  setPrResult: Dispatch<SetStateAction<{ success: boolean; url?: string; number?: number; message?: string } | null>>;
  setPrDescGenerating: Dispatch<SetStateAction<boolean>>;
  setPrDescError: Dispatch<SetStateAction<string | null>>;
  setPrGeneratedDesc: Dispatch<SetStateAction<string | null>>;
  setImportSearchResults: Dispatch<SetStateAction<Array<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }>>>;
  setPrStatus: Dispatch<SetStateAction<{
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number };
    autoMergeEnabled: boolean;
    mergeable: boolean;
  } | null>>;
  setQueuedMessages: Dispatch<SetStateAction<Array<{ text: string; position: number }>>>;
  setShellStarted: Dispatch<SetStateAction<boolean>>;
  setToast: Dispatch<SetStateAction<ToastData | null>>;
  setConfigMissing: Dispatch<SetStateAction<boolean>>;
  setInstallStatus: Dispatch<SetStateAction<{ status: "running" | "complete" | "error"; message?: string } | null>>;
  setTurnDiff: Dispatch<SetStateAction<TurnDiffData | null>>;
  setLastCommitPair: Dispatch<SetStateAction<{ from: string; to: string } | null>>;
  setDiffBadgeCount: Dispatch<SetStateAction<number>>;
  setActiveRunnerSessions: Dispatch<SetStateAction<Set<string>>>;

  // Refs
  prDescGeneratingRef: MutableRefObject<boolean>;
  sessionIdRef: MutableRefObject<string | undefined>;
  terminalRef: MutableRefObject<InteractiveTerminalHandle | null>;

  // Dependencies
  rightTab: RightTab;
  viewingFile: string | null;
  gitCommits: GitCommit[];
  notify: (msg: string) => void;
  navigate: (path: string, opts?: { replace?: boolean }) => void;
  handleSessionResume: (sessionId: string) => void;
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  prStatus: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    checks: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number };
    autoMergeEnabled: boolean;
    mergeable: boolean;
  } | null;
}): void {
  const {
    lastMessage, send, apiGet,
    setPreview, setSelectedPort, setMessages, setIsLoading, setActivity,
    setGitCommits, setAuthUrl, setSessions, setDocFiles, setDocContent,
    setFileTree, setViewingFileContent, setViewingFileBinary,
    setLogEntries, setUnreadLogCount, setTemplates, setShowTemplates,
    setCreatingRepo, setSelectedRepoUrl, setGithubStatus,
    setCurrentSessionUsage, setAllUsageStats, setModelInfo, setContextTokens, setTurnTokens,
    setFileChangeCount, setHasSystemPrompt, setSystemPromptContent,
    setGitIdentityNeeded, setGitIdentity, setThreads, setActiveThreadId,
    setDeployTargets, setDeployConfigStatus, setDeployStatus, setLastDeployUrl, setLastDeployError,
    setDeployHistory, setFeatures, setAgentList, setShowPRModal,
    setPrCurrentBranch, setPrRemoteBranches, setPrResult, setPrDescGenerating,
    setPrDescError, setPrGeneratedDesc, setImportSearchResults, setPrStatus,
    setQueuedMessages, setShellStarted, setToast,
    setConfigMissing, setInstallStatus,
    setTurnDiff, setLastCommitPair, setDiffBadgeCount,
    setActiveRunnerSessions,
    prDescGeneratingRef, sessionIdRef, terminalRef,
    rightTab, viewingFile, gitCommits, notify, navigate, handleSessionResume,
    githubStatus, prStatus,
  } = params;

  // Process incoming WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    let data: WsServerMessage;
    try {
      data = JSON.parse(lastMessage.data) as WsServerMessage;
    } catch {
      return;
    }

    if (data.type === "preview_status") {
      setPreview({
        running: data.running,
        port: data.port,
        url: data.url,
        source: data.source,
        detectedPorts: data.detectedPorts,
      });
      // Reset user selection if the selected port is no longer available
      setSelectedPort((prev) => {
        if (prev === null) return null;
        const allAvailable = [...(data.detectedPorts ?? [])];
        if (data.source === "vite" || data.source === "managed") allAvailable.push(data.port);
        return allAvailable.includes(prev) ? prev : null;
      });
    }

    // ---- Normalized agent event handler (multi-agent support) ----
    if (data.type === "agent_event") {
      const event = data.event as AgentEvent;

      if (event.type === "agent_assistant") {
        const textBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.content ?? [])
          .filter((b: AgentContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

        // Update activity based on what's in this event
        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                {
                  role: "assistant" as const,
                  text: last.text + textBlocks,
                  toolUse: [...(last.toolUse ?? []), ...toolUseBlocks],
                  toolResults: last.toolResults,
                  streaming: true,
                },
              ];
            }
            return [
              ...prev,
              {
                role: "assistant" as const,
                text: textBlocks,
                toolUse: toolUseBlocks,
                streaming: true,
              },
            ];
          });
        }
      }

      // Track tool result events — agent is processing results
      if (event.type === "agent_tool_result") {
        setActivity({ label: "Processing results..." });

        const results: ToolResultBlock[] = [];
        for (const block of (event.content ?? []) as Record<string, unknown>[]) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const rawContent = block.content;
            let content: string;
            if (typeof rawContent === "string") {
              content = rawContent;
            } else if (rawContent == null) {
              content = "";
            } else {
              content = JSON.stringify(rawContent);
            }
            if (content.length > 1_000_000) {
              content = content.slice(0, 1_000_000) + "\n... (output truncated — exceeded 1MB)";
            }
            results.push({
              toolUseId: String(block.tool_use_id),
              content,
              isError: (block.is_error as boolean) ?? false,
            });
          }
        }

        if (results.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              const existingResults = last.toolResults ?? [];
              return [
                ...prev.slice(0, -1),
                { ...last, toolResults: [...existingResults, ...results] },
              ];
            }
            return prev;
          });
        }
      }

      if (event.type === "agent_result") {
        setIsLoading(false);
        setActivity(undefined);
        notify("The agent has finished responding.");
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    // ---- Legacy claude_event handler (backward compatibility) ----
    if (data.type === "claude_event") {
      const event = data.event;

      if (event.type === "assistant") {
        const textBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockText => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (event.message?.content ?? [])
          .filter((b: ClaudeContentBlock): b is ClaudeContentBlockToolUse => b.type === "tool_use");

        if (toolUseBlocks.length > 0) {
          const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
          setActivity(activityFromTool(lastTool.name, lastTool.input));
        } else if (textBlocks) {
          setActivity({ label: "Thinking..." });
        }

        if (textBlocks || toolUseBlocks.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              return [
                ...prev.slice(0, -1),
                {
                  role: "assistant" as const,
                  text: last.text + textBlocks,
                  toolUse: [...(last.toolUse ?? []), ...toolUseBlocks],
                  toolResults: last.toolResults,
                  streaming: true,
                },
              ];
            }
            return [
              ...prev,
              {
                role: "assistant" as const,
                text: textBlocks,
                toolUse: toolUseBlocks,
                streaming: true,
              },
            ];
          });
        }
      }

      if (event.type === "user") {
        setActivity({ label: "Processing results..." });

        const results: ToolResultBlock[] = [];
        for (const block of (event.message?.content ?? []) as Record<string, unknown>[]) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const rawContent = block.content;
            let content: string;
            if (typeof rawContent === "string") {
              content = rawContent;
            } else if (rawContent == null) {
              content = "";
            } else {
              content = JSON.stringify(rawContent);
            }
            if (content.length > 1_000_000) {
              content = content.slice(0, 1_000_000) + "\n... (output truncated — exceeded 1MB)";
            }
            results.push({
              toolUseId: String(block.tool_use_id),
              content,
              isError: (block.is_error as boolean) ?? false,
            });
          }
        }

        if (results.length > 0) {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant") {
              const existingResults = last.toolResults ?? [];
              return [
                ...prev.slice(0, -1),
                { ...last, toolResults: [...existingResults, ...results] },
              ];
            }
            return prev;
          });
        }
      }

      if (event.type === "result") {
        setIsLoading(false);
        setActivity(undefined);
        notify("The agent has finished responding.");
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, streaming: false }];
          }
          return prev;
        });
      }
    }

    if (data.type === "error") {
      // If we're generating a PR description, show the error in the modal
      if (prDescGeneratingRef.current) {
        setPrDescGenerating(false);
        prDescGeneratingRef.current = false;
        setPrDescError(data.message);
        return;
      }
      setIsLoading(false);
      setActivity(undefined);
      // Mark any in-flight streaming message as done, then append the error
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const updated =
          last && last.role === "assistant" && last.streaming
            ? [...prev.slice(0, -1), { ...last, streaming: false }]
            : prev;
        return [
          ...updated,
          { role: "assistant", text: `Error: ${data.message}`, streaming: false, isError: true },
        ];
      });
    }

    if (data.type === "git_log") {
      setGitCommits(data.commits);
    }

    if (data.type === "git_committed") {
      // Track the commit pair for diff review (previous HEAD → new commit)
      const prevHash = gitCommits[0]?.hash;
      if (prevHash) {
        setLastCommitPair({ from: prevHash, to: data.hash });
        setTurnDiff(null); // Clear stale diff data
        setDiffBadgeCount((prev) => prev + 1);
      }
      // Prepend the new commit to the list
      setGitCommits((prev) => [
        { hash: data.hash, message: data.message, date: new Date().toISOString(), author: "ShipIt" },
        ...prev,
      ]);
      // Refresh file tree if the Files tab is active (files likely changed)
      if (rightTab === "files" && sessionIdRef.current) {
        if (viewingFile) {
          // Fetch file content with tree in one request
          apiGet<{ content: string; isBinary?: boolean; tree: FileTreeNode[] }>(
            `/api/sessions/${sessionIdRef.current}/files/${viewingFile}?tree=true`,
          ).then((d) => {
            setFileTree(d.tree);
            setViewingFileContent(d.content);
            setViewingFileBinary(d.isBinary ?? false);
          }).catch(() => {});
        } else {
          apiGet<{ tree: FileTreeNode[] }>(`/api/sessions/${sessionIdRef.current}/files`)
            .then((d) => setFileTree(d.tree))
            .catch(() => {});
        }
      }
    }

    if (data.type === "rollback_complete") {
      // Refresh the git log after rollback
      if (sessionIdRef.current) {
        apiGet<{ commits: GitCommit[] }>(`/api/sessions/${sessionIdRef.current}/git/log`)
          .then((d) => setGitCommits(d.commits))
          .catch(() => {});
      }
    }

    if (data.type === "auth_required") {
      setAuthUrl(data.url ?? "");
      setIsLoading(false);
      setActivity(undefined);
    }

    if (data.type === "auth_complete") {
      setAuthUrl(null);
    }

    if (data.type === "agent_list") {
      setAgentList(data.agents);
    }

    if (data.type === "global_settings") {
      setGitIdentity({ name: data.gitIdentity.name, email: data.gitIdentity.email });
      setSystemPromptContent(data.systemPrompt);
      setHasSystemPrompt(data.systemPrompt.length > 0);
      setAgentList(data.agents);
    }

    if (data.type === "git_identity_required") {
      setGitIdentityNeeded(true);
    }

    if (data.type === "git_identity_set") {
      setGitIdentityNeeded(false);
      if (data.name || data.email) {
        setGitIdentity({ name: data.name, email: data.email });
      }
    }

    if (data.type === "session_list") {
      setSessions(data.sessions);
    }

    if (data.type === "session_started") {
      sessionIdRef.current = data.session.id;
      navigate(`/session/${data.session.id}`, { replace: true });
      setSessions((prev) => {
        const exists = prev.some((s) => s.id === data.session.id);
        if (exists) {
          return prev.map((s) => (s.id === data.session.id ? data.session : s));
        }
        return [data.session, ...prev];
      });
      // Load threads for this session
      apiGet<{ threads: ThreadInfo[]; activeThreadId: string }>(`/api/sessions/${data.session.id}/threads`)
        .then((d) => { setThreads(d.threads); setActiveThreadId(d.activeThreadId); })
        .catch(() => {});
    }

    if (data.type === "session_renamed") {
      const renamed = (data as WsSessionRenamed).session;
      setSessions((prev) =>
        prev.map((s) => (s.id === renamed.id ? renamed : s))
      );
    }

    if (data.type === "file_tree") {
      setFileTree(data.tree);
    }

    if (data.type === "files_changed") {
      const paths: string[] = data.paths;
      const sid = sessionIdRef.current;

      // Auto-refresh file tree and/or viewed file
      if (sid) {
        const needsTree = rightTab === "files";
        const needsFile = viewingFile && paths.some((p) => viewingFile.endsWith(p));

        if (needsTree && needsFile) {
          // Fetch file content with tree in one request
          apiGet<{ content: string; isBinary?: boolean; tree: FileTreeNode[] }>(
            `/api/sessions/${sid}/files/${viewingFile}?tree=true`,
          ).then((d) => {
            setFileTree(d.tree);
            setViewingFileContent(d.content);
            setViewingFileBinary(d.isBinary ?? false);
          }).catch(() => {});
        } else if (needsTree) {
          apiGet<{ tree: FileTreeNode[] }>(`/api/sessions/${sid}/files`)
            .then((d) => setFileTree(d.tree))
            .catch(() => {});
        } else if (needsFile) {
          apiGet<{ content: string; isBinary?: boolean }>(`/api/sessions/${sid}/files/${viewingFile}`)
            .then((d) => {
              setViewingFileContent(d.content);
              setViewingFileBinary(d.isBinary ?? false);
            })
            .catch(() => {});
        }
      }

      // Show a badge on the Files tab when changes occur while not viewing it
      if (rightTab !== "files") {
        setFileChangeCount((prev) => prev + paths.length);
      }
    }

    if (data.type === "chat_history") {
      // Replace messages with the persisted history (loaded messages are never streaming)
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        images: m.images,
        files: m.files,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "template_list") {
      setTemplates(data.templates as TemplateInfo[]);
    }

    if (data.type === "template_applied") {
      setShowTemplates(false);
      // Refresh file tree in case user is on that tab
      if (sessionIdRef.current) {
        apiGet<{ tree: FileTreeNode[] }>(`/api/sessions/${sessionIdRef.current}/files`)
          .then((d) => setFileTree(d.tree))
          .catch(() => {});
      }
    }

    if (data.type === "home_repo_ready") {
      setCreatingRepo(false);
      if (data.success && data.repoUrl) {
        setSelectedRepoUrl(data.repoUrl);
      }
    }

    if (data.type === "github_status") {
      setGithubStatus({
        authenticated: data.authenticated,
        username: data.username,
        avatarUrl: data.avatarUrl,
      });
    }

    if (data.type === "github_push_result" || data.type === "github_pull_result") {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          text: data.message,
          streaming: false,
          isError: !data.success,
        },
      ]);
      // Refresh PR status after push
      if (data.type === "github_push_result" && data.success && sessionIdRef.current) {
        const sid = sessionIdRef.current;
        apiGet<{ pr: typeof prStatus }>(`/api/sessions/${sid}/pr/status`)
          .then((d) => setPrStatus(d.pr))
          .catch(() => {});
        // Show toast with PR creation shortcut
        if (githubStatus.authenticated && !prStatus?.url) {
          setToast({
            message: `Pushed to origin/${data.branch ?? "branch"}`,
            action: {
              label: "Create PR",
              onClick: () => {
                setShowPRModal(true);
                apiGet<{ current: string; remote: string[] }>(`/api/sessions/${sid}/git/branches`)
                  .then((d) => { setPrCurrentBranch(d.current); setPrRemoteBranches(d.remote); })
                  .catch(() => {});
              },
            },
            duration: 8000,
          });
        }
      }
    }


    if (data.type === "github_pr_created") {
      setPrResult({
        success: data.success,
        url: data.url,
        number: data.number,
        message: data.message,
      });
      // Refresh PR status after PR creation
      if (data.success && sessionIdRef.current) {
        apiGet<{ pr: typeof prStatus }>(`/api/sessions/${sessionIdRef.current}/pr/status`)
          .then((d) => setPrStatus(d.pr))
          .catch(() => {});
      }
    }

    if (data.type === "merge_pr_result") {
      if (data.success && !data.autoMergeEnabled) {
        setPrStatus(null);
      } else if (data.autoMergeEnabled && sessionIdRef.current) {
        apiGet<{ pr: typeof prStatus }>(`/api/sessions/${sessionIdRef.current}/pr/status`)
          .then((d) => setPrStatus(d.pr))
          .catch(() => {});
      }
    }

    if (data.type === "generated_pr_description") {
      setPrDescGenerating(false);
      prDescGeneratingRef.current = false;
      setPrGeneratedDesc(data.description);
    }

    if (data.type === "model_info") {
      const info = data as WsModelInfo;
      setModelInfo({ model: info.model, contextWindowTokens: info.contextWindowTokens });
    }

    if (data.type === "usage_update") {
      const update = data as WsUsageUpdate;
      setCurrentSessionUsage({
        sessionId: update.sessionId,
        totalCostUsd: update.totalCostUsd,
        totalDurationMs: update.totalDurationMs,
        turnCount: update.turnCount,
      });
      if (update.cumulativeInputTokens !== undefined) {
        setContextTokens(update.cumulativeInputTokens);
      }
      // Track per-turn token data
      if (update.lastTurnInputTokens !== undefined || update.lastTurnOutputTokens !== undefined) {
        setTurnTokens((prev) => [
          ...prev,
          {
            inputTokens: update.lastTurnInputTokens,
            outputTokens: update.lastTurnOutputTokens,
            costUsd: update.totalCostUsd - prev.reduce((sum, t) => sum + t.costUsd, 0),
            durationMs: update.totalDurationMs - prev.reduce((sum, t) => sum + t.durationMs, 0),
          },
        ]);
      }
    }

    if (data.type === "thread_list") {
      setThreads(data.threads);
      setActiveThreadId(data.activeThreadId);
    }

    if (data.type === "checkpoint_created") {
      // Update the thread's checkpoints in local state
      setThreads((prev) =>
        prev.map((t) =>
          t.id === data.threadId
            ? { ...t, checkpoints: [...t.checkpoints, data.checkpoint] }
            : t,
        ),
      );
    }

    if (data.type === "thread_forked") {
      setThreads((prev) => {
        const deactivated = prev.map((t) => ({ ...t, isActive: false }));
        return [...deactivated, data.thread];
      });
      setActiveThreadId(data.thread.id);
      // Replace messages with the thread's conversation
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        images: m.images,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "thread_switched") {
      setThreads((prev) =>
        prev.map((t) => ({ ...t, isActive: t.id === data.thread.id })),
      );
      setActiveThreadId(data.thread.id);
      const loaded: ChatMessage[] = data.messages.map((m: WsChatHistoryMessage) => ({
        role: m.role,
        text: m.text,
        toolUse: m.toolUse,
        images: m.images,
        isError: m.isError,
        streaming: false,
      }));
      setMessages(loaded);
    }

    if (data.type === "deploy_config_saved") {
      // Refresh config status after save
      if (sessionIdRef.current) {
        apiGet<{ targets: DeployTargetInfo[]; projectSettings: Record<string, { configured: boolean; projectName?: string }> }>(
          `/api/sessions/${sessionIdRef.current}/deploy/setup`,
        ).then((d) => {
          setDeployTargets(d.targets);
          setDeployConfigStatus(d.projectSettings);
        }).catch(() => {});
      }
    }

    if (data.type === "deploy_status") {
      setDeployStatus(data.phase);
      setLastDeployUrl(null);
      setLastDeployError(null);
    }

    if (data.type === "deploy_complete") {
      setDeployStatus("complete");
      setLastDeployUrl(data.url);
      setLastDeployError(null);
    }

    if (data.type === "deploy_error") {
      setDeployStatus("error");
      setLastDeployError(data.message);
    }

    if (data.type === "message_queued") {
      const queued = data as WsMessageQueued;
      setQueuedMessages((prev) => [...prev, { text: queued.text, position: queued.position }]);
      // Add the queued message to the chat list with queued=true
      setMessages((prev) => [...prev, { role: "user" as const, text: queued.text, queued: true, queuePosition: queued.position }]);
    }

    if (data.type === "queue_updated") {
      const update = data as WsQueueUpdated;
      setQueuedMessages(update.queue);
      // Sync queued state on chat messages: remove queued flag from items no longer in queue
      if (update.queue.length === 0) {
        // All queued items are now either executing or cancelled — clear queued flags
        setMessages((prev) =>
          prev.map((m) => (m.queued ? { ...m, queued: false, queuePosition: undefined } : m))
        );
      } else {
        // Keep only the first queued message as "currently executing" (no queued flag)
        // Others remain queued with updated positions
        const queueTexts = new Set(update.queue.map((q) => q.text));
        setMessages((prev) =>
          prev.map((m) => {
            if (!m.queued) return m;
            if (!queueTexts.has(m.text)) {
              // This message was either dequeued for execution or cancelled
              return { ...m, queued: false, queuePosition: undefined };
            }
            // Update position from server's authoritative queue
            const queueItem = update.queue.find((q) => q.text === m.text);
            return queueItem ? { ...m, queuePosition: queueItem.position } : m;
          })
        );
      }
    }

    if (data.type === "full_reset_complete") {
      // Clear all localStorage keys
      try {
        localStorage.removeItem("shipit-theme");
        localStorage.removeItem(PERMISSION_MODE_KEY);
        localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
        localStorage.removeItem(AGENT_PREFERENCE_KEY);
        localStorage.removeItem("vibe-panel-split");
      } catch {
        // localStorage may be unavailable
      }
      window.location.reload();
      return;
    }

    if (data.type === "claude_interrupted") {
      setIsLoading(false);
      setActivity(undefined);
      setQueuedMessages([]);
      // Mark any streaming assistant message as complete with an interrupted note
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              streaming: false,
              text: last.text + "\n\n_(Interrupted by user)_",
            },
          ];
        }
        return prev;
      });
    }

    if (data.type === "log_entry") {
      setLogEntries((prev) => {
        const next = [...prev, { source: data.source, text: data.text, timestamp: data.timestamp }];
        // Cap at 500 entries on the client to avoid memory growth
        return next.length > 500 ? next.slice(-500) : next;
      });
      // Increment unread count when terminal tab is not active
      if (rightTab !== "terminal") {
        setUnreadLogCount((prev) => prev + 1);
      }
    }

    if (data.type === "clear_logs") {
      setLogEntries([]);
      setUnreadLogCount(0);
    }

    if (data.type === "preview_config_missing") {
      setConfigMissing(true);
    }

    if (data.type === "preview_config_error") {
      setConfigMissing(false);
      // Show the config error as a toast notification
      setToast({ message: `Preview config error: ${data.message}` });
    }

    if (data.type === "install_status") {
      setInstallStatus({ status: data.status, message: data.message });
      if (data.status === "complete") {
        // Clear install status after a brief delay
        setTimeout(() => setInstallStatus(null), 1000);
      }
    }

    // Clear config missing state when preview starts running
    if (data.type === "preview_status" && data.running) {
      setConfigMissing(false);
      setInstallStatus(null);
    }

    if (data.type === "turn_diff") {
      setTurnDiff({
        fromCommit: data.fromCommit,
        toCommit: data.toCommit,
        files: data.files,
        stats: data.stats,
      });
    }

    if (data.type === "reject_changes_complete") {
      // Clear the diff data and refresh workspace state
      setTurnDiff(null);
      setLastCommitPair(null);
      setDiffBadgeCount(0);
      if (sessionIdRef.current) {
        apiGet<{ gitLog: GitCommit[]; fileTree: FileTreeNode[] }>(
          `/api/sessions/${sessionIdRef.current}/workspace-state`,
        ).then((d) => {
          setGitCommits(d.gitLog);
          setFileTree(d.fileTree);
        }).catch(() => {});
      }
    }

    if (data.type === "terminal_output") {
      terminalRef.current?.write(data.data);
    }

    if (data.type === "terminal_exit") {
      setShellStarted(false);
    }

    // ---- Session runner messages ----
    if (data.type === "session_status") {
      // Update running state: if running, add to set; if not, remove
      setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        if (data.running) {
          next.add(data.sessionId);
        } else {
          next.delete(data.sessionId);
        }
        return next;
      });
      // If this is for the current session, update isLoading
      if (data.sessionId === sessionIdRef.current) {
        setIsLoading(data.running);
      }
    }

    if (data.type === "session_agent_started") {
      setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.add(data.sessionId);
        return next;
      });
    }

    if (data.type === "session_agent_finished") {
      setActiveRunnerSessions((prev) => {
        const next = new Set(prev);
        next.delete(data.sessionId);
        return next;
      });
    }
  }, [lastMessage, send, apiGet, rightTab, viewingFile, gitCommits, notify, handleSessionResume, navigate,
      setPreview, setSelectedPort, setMessages, setIsLoading, setActivity,
      setGitCommits, setAuthUrl, setSessions, setDocFiles, setDocContent,
      setFileTree, setViewingFileContent, setViewingFileBinary,
      setLogEntries, setUnreadLogCount, setTemplates, setShowTemplates,
      setCreatingRepo, setSelectedRepoUrl, setGithubStatus,
      setCurrentSessionUsage, setAllUsageStats, setModelInfo, setContextTokens, setTurnTokens,
      setFileChangeCount, setHasSystemPrompt, setSystemPromptContent,
      setGitIdentityNeeded, setGitIdentity, setThreads, setActiveThreadId,
      setDeployTargets, setDeployConfigStatus, setDeployStatus, setLastDeployUrl, setLastDeployError,
      setDeployHistory, setFeatures, setAgentList, setShowPRModal,
      setPrCurrentBranch, setPrRemoteBranches, setPrResult, setPrDescGenerating,
      setPrDescError, setPrGeneratedDesc, setImportSearchResults, setPrStatus,
      setQueuedMessages, setShellStarted, setToast,
      setConfigMissing, setInstallStatus,
      setTurnDiff, setLastCommitPair, setDiffBadgeCount,
      setActiveRunnerSessions,
      prDescGeneratingRef, sessionIdRef, terminalRef,
      githubStatus, prStatus]);
}
