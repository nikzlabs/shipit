// eslint-disable-next-line no-restricted-imports -- focus restoration, Escape listener
import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./Spinner.js";
import { useEventListener } from "../hooks/useEventListener.js";
import { XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useEgressStore } from "../stores/egress-store.js";
import type { NetworkMode } from "../hooks/useSessionNetworkMode.js";
import { isSelectionEligibleForAgent } from "../agent-types.js";
import { startQuickSessionInBackground } from "../stores/actions/session-actions.js";
import {
  clearParkedHarness,
  getSavedModelId,
  getSavedModelSelection,
  getSavedQuickSessionRepo,
  getSavedReasoning,
  getSavedRoleName,
  saveModelId,
  saveModelSelection,
  saveQuickSessionRepo,
  saveRoleName,
} from "../utils/local-storage.js";
import { newSessionAgentId } from "../utils/new-session-agent.js";
import { applyRoleSeeds } from "../utils/role-seed.js";
import { persistHarnessPick } from "../utils/harness-seed.js";
import { parseRepoLabel } from "../utils/repo-label.js";
import { useChatDisabledReason } from "../utils/chat-runnable.js";
import { MessageInput, type SendPayload } from "./MessageInput.js";
import { Button } from "./ui/button.js";
import { Alert } from "./ui/banner.js";
import { Dialog } from "./ui/dialog.js";
import type { FileContextRef, SessionInfo } from "../../server/shared/types.js";

export function QuickCaptureOverlay({
  onAddRepo,
  onSessionCreated,
}: {
  onAddRepo: () => void;

  onSessionCreated?: (session: SessionInfo) => void;
}) {
  const open = useUiStore((s) => s.quickCaptureOpen);
  const bootstrapLoaded = useUiStore((s) => s.bootstrapLoaded);
  const agentList = useUiStore((s) => s.agentList);
  const modelInfo = useUiStore((s) => s.modelInfo);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionId = useSessionStore((s) => s.sessionId);
  const repos = useRepoStore((s) => s.repos);
  const activeRepoUrl = useRepoStore((s) => s.activeRepoUrl);
  const permissionMode = useSettingsStore((s) => s.permissionMode);

  const chatDisabledReason = useChatDisabledReason();
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | undefined>(undefined);
  const [pendingFiles, setPendingFiles] = useState<FileContextRef[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(getSavedModelId());

  const [selectedReasoning, setSelectedReasoning] = useState<string | undefined>(undefined);

  // per-session and must NEVER be persisted. Do NOT wire it to localStorage the

  // defaults off and the user must opt in every single time.
  const [armAutoMerge, setArmAutoMerge] = useState(false);

  const [networkMode, setNetworkMode] = useState<NetworkMode>("inherit");

  const egressGlobalEnabled = useEgressStore((s) => s.globalEnabled);
  const egressEnforcement = useEgressStore((s) => s.enforcementStatus);
  const egressGlobalLoaded = useEgressStore((s) => s.globalLoaded);
  // The harness and model seeds live in localStorage, which React cannot

  const [, noteSeedWrite] = useState(0);
  const seedWritten = () => noteSeedWrite((n) => n + 1);
  const [error, setError] = useState<string | null>(null);
  const restoreFocusRef = useRef<{ element: HTMLTextAreaElement; start: number | null; end: number | null } | null>(null);
  const wasOpenRef = useRef(false);

  // React cannot track, so a dependency list here is a list of things that

  const selectedAgentId = newSessionAgentId(agentList);

  const activeSessionRepo = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.remoteUrl,
    [sessions, sessionId],
  );

  // opening — a send earlier in this page session must be reflected without a

  // `open` reads as an unnecessary dependency because it is not referenced in

  // localStorage, which React cannot track, so `open` is the deliberate

  const lastQuickSessionRepo = useMemo(() => {
    const saved = getSavedQuickSessionRepo();
    return saved && repos.some((r) => r.url === saved) ? saved : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is unreferenced by design — it re-reads a non-reactive localStorage value on each opening (see above)
  }, [repos, open]);
  const defaultRepoUrl = lastQuickSessionRepo ?? activeSessionRepo ?? activeRepoUrl ?? repos[0]?.url;
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

    setNetworkMode("inherit");
    void useEgressStore.getState().loadGlobal();
    setSelectedModel(getSavedModelId());

    setSelectedReasoning(undefined);
    // docs/175 decision #1 — auto-merge never persists across openings either.

    setArmAutoMerge(false);
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

  useEventListener(open ? window : null, "keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  if (!open) return null;

  const disabled = !bootstrapLoaded || selectedRepo?.status !== "ready";

  const handleSend = (payload: SendPayload): boolean => {
    if (!selectedRepo) {

      setError("Add a repo first.");
      return false;
    }

    const reasoning = selectedReasoning ?? getSavedReasoning(selectedAgentId);
    const savedSelection = getSavedModelSelection();
    const params = {
      repoUrl: selectedRepo.url,
      initialPrompt: payload.text,
      agent: selectedAgentId,
      ...(selectedModel ? { model: selectedModel } : {}),

      // the seed was read is a different choice and must not inherit its service.

      ...(selectedModel
        && savedSelection?.modelId === selectedModel
        && isSelectionEligibleForAgent(agentList, selectedAgentId, savedSelection)
        ? { serviceId: savedSelection.serviceId, billingMode: savedSelection.billingMode }
        : {}),
      ...(reasoning ? { reasoning } : {}),

      ...(getSavedRoleName() ? { role: getSavedRoleName()! } : {}),
      ...(armAutoMerge ? { armAutoMerge: true } : {}),

      ...(networkMode !== "inherit"
        ? { networkMode: networkMode === "contained" }
        : {}),

      ...(payload.dictated ? { dictated: true } : {}),
      ...(payload.deferredFiles.length > 0 ? { files: payload.deferredFiles } : {}),
    };

    saveQuickSessionRepo(selectedRepo.url);
    setPendingFiles([]);
    close();

    startQuickSessionInBackground(params, (created) => onSessionCreated?.(created));
    return true;
  };

  return (

    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
    <div
      role="dialog"
      aria-label="Quick capture"
      className="fixed inset-0 z-50 flex items-start justify-center bg-(--color-bg-overlay) px-4 pt-[14vh] pb-[env(safe-area-inset-bottom)] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-(--color-border-secondary) bg-(--color-bg-elevated) shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-(--color-border-primary) px-4 py-3">
          <div className="min-w-0">
            {!bootstrapLoaded ? (
              <span className="inline-flex items-center gap-2 text-sm text-(--color-text-secondary)">
                <Spinner size={ICON_SIZE.SM} />
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
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={close} aria-label="Close quick capture">
            <XIcon size={ICON_SIZE.SM} />
          </Button>
        </div>
        {error && (
          <Alert variant="error" className="mx-4 mt-3 text-sm">
            {error}
          </Alert>
        )}
        {selectedRepo && selectedRepo.status !== "ready" && (
          <Alert variant="warning" className="mx-4 mt-3 text-sm">
            This repo is still cloning.
          </Alert>
        )}
        <div className="py-3">
          <MessageInput
            surface="overlay"
            onSend={handleSend}
            disabled={disabled}

            disabledReason={chatDisabledReason}
            isLoading={false}
            permissionMode={permissionMode}
            onPermissionModeChange={(mode) => useSettingsStore.getState().setPermissionMode(undefined, mode)}
            /* docs/285 req 2 — the same control the chat composer carries, fed
               from local state rather than the server: this session does not
               exist yet, so there is nothing to read a value from and nothing to
               write one to. `beforeFirstTurn` is unconditionally true for the
               same reason — the overlay's whole job is the first turn.

               `pendingRestart` is false and cannot be otherwise: it reports that
               a LIVE container disagrees with the selection, and there is no
               container here yet. */
            network={{
              mode: networkMode,
              onChange: setNetworkMode,
              globalEnabled: egressGlobalEnabled,
              enforcementStatus: egressEnforcement,
              pendingRestart: false,
              beforeFirstTurn: true,
              // req 10 — the overlay must not name a workspace default it has

              loaded: egressGlobalLoaded,

              saving: false,
            }}
            pendingFiles={pendingFiles}
            onRemoveFile={(index) => setPendingFiles((files) => files.filter((_, i) => i !== index))}
            onAddFile={(path) => setPendingFiles((files) => files.some((f) => f.path === path) ? files : [...files, { path }])}
            fileTree={[]}
            skills={[]}
            agents={agentList}
            activeAgentId={selectedAgentId}
            onAgentChange={(agentId) => {
              useUiStore.getState().setActiveAgentId(agentId);

              const nextModelId = persistHarnessPick({
                agentId,
                agents: agentList,
                ...(selectedModel ? { current: { modelId: selectedModel } } : {}),
              });
              if (nextModelId) setSelectedModel(nextModelId);

              saveRoleName(undefined);
              seedWritten();

              setSelectedReasoning(undefined);
            }}
            onModelChange={(selection) => {

              clearParkedHarness();
              if (selection.serviceId) {
                saveModelSelection({
                  serviceId: selection.serviceId,
                  billingMode: selection.billingMode,
                  modelId: selection.modelId,
                });
              } else {
                saveModelId(selection.modelId);
              }
              setSelectedModel(selection.modelId);

              saveRoleName(undefined);
              seedWritten();

              setSelectedReasoning(undefined);
            }}

            onReasoningChange={(effort) => {

              saveRoleName(undefined);
              seedWritten();
              setSelectedReasoning(effort ?? undefined);
            }}

            onRoleChange={(roleName) => {

              saveRoleName(roleName);

              if (roleName !== undefined) {
                const role = useSettingsStore.getState().roles.find((r) => r.name === roleName);
                applyRoleSeeds(role);
                clearParkedHarness();
                // The creation params read this state, not the seed. The level is
                // cleared, not set: `send` falls back to the per-harness seed.
                if (role?.resolved) setSelectedModel(role.resolved.modelId);
                setSelectedReasoning(undefined);
              }
              seedWritten();
            }}
            modelInfo={modelInfo}
            hasActiveSession={false}
          />
        </div>
        <div className="flex flex-col gap-3 border-t border-(--color-border-primary) px-4 py-3 text-xs text-(--color-text-tertiary)">
          {/* docs/175 — auto-merge opt-in. Always present (no CI-presence
              gating, decision #2). The note is unconditional and honest:
              the per-PR `checks.state === "none"` signal isn't knowable
              before the PR exists, so we describe what arming does rather
              than claiming a per-repo "no CI gate" verdict. Laid out as a
              column so the label, checkbox, and note wrap cleanly and stay
              tappable on a narrow (mobile) viewport. */}
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={armAutoMerge}
              onChange={(e) => setArmAutoMerge(e.target.checked)}
              disabled={disabled}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-(--color-accent)"
            />
            <span className="min-w-0">
              <span className="text-(--color-text-secondary)">Auto-merge when ready</span>
              <span className="mt-0.5 block text-(--color-text-tertiary)">
                Merges automatically once the PR is mergeable. If it has no CI
                checks, it merges immediately — without review.
              </span>
            </span>
          </label>
          <span>Enter to send · Shift+Enter for newline · Esc to dismiss</span>
        </div>
      </div>
    </div>
    </Dialog>
  );
}
