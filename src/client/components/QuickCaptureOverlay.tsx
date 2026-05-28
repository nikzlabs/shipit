// eslint-disable-next-line no-restricted-imports -- focus restoration, Escape listener
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleNotchIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { createHeadlessSession } from "../stores/actions/session-actions.js";
import { getSavedAgentId, getSavedModelId, saveAgentId, saveModelId } from "../utils/local-storage.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import { MessageInput, type SendPayload } from "./MessageInput.js";
import { Button } from "./ui/button.js";
import type { FileContextRef } from "../../server/shared/types.js";

const QUICK_CAPTURE_FOCUS_KEY = "__quick_capture__";

export function QuickCaptureOverlay({ onAddRepo }: { onAddRepo: () => void }) {
  const open = useUiStore((s) => s.quickCaptureOpen);
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);
  const agentList = useUiStore((s) => s.agentList);
  const modelInfo = useUiStore((s) => s.modelInfo);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionId = useSessionStore((s) => s.sessionId);
  const repos = useRepoStore((s) => s.repos);
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const permissionMode = useSettingsStore((s) => s.permissionMode);
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | undefined>(undefined);
  const [pendingFiles, setPendingFiles] = useState<FileContextRef[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(getSavedAgentId());
  const [selectedModel, setSelectedModel] = useState<string | undefined>(getSavedModelId());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restoreFocusRef = useRef<{ element: HTMLTextAreaElement; start: number | null; end: number | null } | null>(null);
  const wasOpenRef = useRef(false);

  const activeSessionRepo = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.remoteUrl,
    [sessions, sessionId],
  );
  const defaultRepoUrl = activeSessionRepo ?? activeRepoUrl ?? repos[0]?.url;
  const effectiveRepoUrl = selectedRepoUrl ?? defaultRepoUrl;
  const selectedRepo = repos.find((r) => r.url === effectiveRepoUrl);

  // eslint-disable-next-line no-restricted-syntax -- captures browser focus for restoration after dialog close
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLTextAreaElement
      ? { element: active, start: active.selectionStart, end: active.selectionEnd }
      : null;
    if (!wasOpenRef.current) {
      setSelectedRepoUrl(defaultRepoUrl);
    }
    wasOpenRef.current = true;
    setSelectedAgentId(getSavedAgentId());
    setSelectedModel(getSavedModelId());
  }, [defaultRepoUrl, open]);

  const close = () => {
    useUiStore.getState().setQuickCaptureOpen(false);
    setError(null);
    requestAnimationFrame(() => {
      const restore = restoreFocusRef.current;
      if (!restore) return;
      restore.element.focus();
      if (restore.start !== null && restore.end !== null) {
        restore.element.setSelectionRange(restore.start, restore.end);
      }
    });
  };

  // eslint-disable-next-line no-restricted-syntax -- Escape key listener while modal is open
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const disabled = submitting || !bootstrapLoaded || selectedRepo?.status !== "ready";

  const handleSend = async (payload: SendPayload) => {
    if (!selectedRepo) {
      setError("Add a repo first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createHeadlessSession({
        repoUrl: selectedRepo.url,
        initialPrompt: payload.text,
        agent: selectedAgentId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(payload.deferredFiles.length > 0 ? { files: payload.deferredFiles } : {}),
      });
      setPendingFiles([]);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start a session — try again");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Quick capture"
      className="fixed inset-0 z-50 flex items-start justify-center bg-(--color-bg-overlay) px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-(--color-border-primary) px-4 py-3">
          <div className="min-w-0">
            {!bootstrapLoaded ? (
              <span className="inline-flex items-center gap-2 text-sm text-(--color-text-secondary)">
                <CircleNotchIcon size={ICON_SIZE.SM} className="animate-spin" />
                Loading repos
              </span>
            ) : repos.length === 0 ? (
              <button
                className="text-sm text-(--color-text-link) hover:underline"
                onClick={() => {
                  close();
                  onAddRepo();
                }}
              >
                Add a repo first
              </button>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-(--color-text-secondary)">New quick session in</span>
                <select
                  className="min-w-0 rounded-md border border-(--color-border-secondary) bg-(--color-bg-tertiary) px-2 py-1 text-(--color-text-primary)"
                  value={effectiveRepoUrl ?? ""}
                  onChange={(e) => setSelectedRepoUrl(e.target.value)}
                >
                  {repos.map((repo) => (
                    <option key={repo.url} value={repo.url}>
                      {parseRepoLabel(repo.url)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={close} aria-label="Close quick capture">
            <XIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
        {error && (
          <div className="mx-4 mt-3 rounded-md border border-(--color-error)/40 bg-(--color-error-subtle) px-3 py-2 text-sm text-(--color-error)">
            {error}
          </div>
        )}
        {selectedRepo && selectedRepo.status !== "ready" && (
          <div className="mx-4 mt-3 rounded-md border border-(--color-warning)/40 bg-(--color-warning-subtle) px-3 py-2 text-sm text-(--color-warning)">
            This repo is still cloning.
          </div>
        )}
        <div className="py-3">
          <MessageInput
            surface="overlay"
            onSend={(payload) => void handleSend(payload)}
            disabled={disabled}
            isLoading={submitting}
            permissionMode={permissionMode}
            onPermissionModeChange={(mode) => useSettingsStore.getState().setPermissionMode(undefined, mode)}
            pendingFiles={pendingFiles}
            onRemoveFile={(index) => setPendingFiles((files) => files.filter((_, i) => i !== index))}
            onAddFile={(path) => setPendingFiles((files) => files.some((f) => f.path === path) ? files : [...files, { path }])}
            fileTree={[]}
            skills={[]}
            agents={agentList}
            activeAgentId={selectedAgentId}
            onAgentChange={(agentId) => {
              saveAgentId(agentId);
              setSelectedAgentId(agentId);
              useUiStore.getState().setActiveAgentId(agentId);
            }}
            onModelChange={(model) => {
              saveModelId(model);
              setSelectedModel(model);
            }}
            modelInfo={modelInfo}
            focusKey={QUICK_CAPTURE_FOCUS_KEY}
            hasActiveSession={false}
          />
        </div>
        <div className="flex items-center justify-between border-t border-(--color-border-primary) px-4 py-3 text-xs text-(--color-text-tertiary)">
          <span>Enter to send · Shift+Enter for newline · Esc to dismiss</span>
          {submitting && <span className="inline-flex items-center gap-1"><CircleNotchIcon size={ICON_SIZE.XS} className="animate-spin" /> Starting</span>}
        </div>
      </div>
    </div>
  );
}
