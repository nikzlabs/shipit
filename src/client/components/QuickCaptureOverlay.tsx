// eslint-disable-next-line no-restricted-imports -- focus restoration, Escape listener
import { useEffect, useMemo, useRef, useState } from "react";
import { useEventListener } from "../hooks/useEventListener.js";
import { CircleNotchIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useSessionStore } from "../stores/session-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
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
  /** Notified with the freshly created (or reused-and-graduated) session. */
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
  // docs/257 req 3 — the same install-level signal the main composer reads.
  const chatDisabledReason = useChatDisabledReason();
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | undefined>(undefined);
  const [pendingFiles, setPendingFiles] = useState<FileContextRef[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(getSavedModelId());
  // docs/217 — per-session reasoning effort (Control B), seeded from the active
  // agent's localStorage pick. Mirrors the regular composer's new-session
  // behavior, but a quick session's first turn is dispatched server-side at
  // creation (docs/205) — before any WS connect — so the `?reasoning=` connect
  // param can't reach turn 1. We therefore send the chosen level in the
  // creation params (below). `undefined` falls back to the saved seed at send.
  const [selectedReasoning, setSelectedReasoning] = useState<string | undefined>(undefined);
  // docs/175-auto-merge-at-session-creation/plan.md decision #1: this toggle is
  // per-session and must NEVER be persisted. Do NOT wire it to localStorage the
  // way the model/agent pickers are — a sticky auto-merge is an invisible,
  // irreversible footgun that would silently ship a review-intended PR. It
  // defaults off and the user must opt in every single time.
  const [armAutoMerge, setArmAutoMerge] = useState(false);
  // The harness and model seeds live in localStorage, which React cannot
  // subscribe to — and both this overlay and the pickers inside it read them
  // during render. Bumped after every write below so the read happens again; a
  // pick that changes only a seed (a harness switch that keeps the model) has
  // nothing else to re-render on.
  const [, noteSeedWrite] = useState(0);
  const seedWritten = () => noteSeedWrite((n) => n + 1);
  const [error, setError] = useState<string | null>(null);
  const restoreFocusRef = useRef<{ element: HTMLTextAreaElement; start: number | null; end: number | null } | null>(null);
  const wasOpenRef = useRef(false);

  // The model is the single source of truth; derive the agent from it rather
  // than tracking a separate `vibe-agent-id`, which can go stale (it's only
  // re-persisted when the picker switches agents in an *unpinned* session, so a
  // user who picks Claude models inside already-pinned sessions keeps a stale
  // `codex` agent key). Sending that stale key would pin the brand-new quick
  // session to the wrong agent even though the overlay shows Claude. See
  // docs/142 (Problem C) and docs/166-quick-capture-agent-pin.
  //
  // `newSessionAgentId` IS that rule, and this is the creation path it names —
  // so it is called rather than re-implemented. The overlay used to inline a
  // copy of it, which meant the harness the picker DISPLAYS (which calls the
  // shared rule) and the harness the session is CREATED on could disagree the
  // moment the two stopped matching character for character.
  //
  // Read on every render, not memoized: the rule reads localStorage, which
  // React cannot track, so a dependency list here is a list of things that
  // *happen* to be written at the same time — and one of them being unchanged
  // is enough to freeze the answer. That is not hypothetical: a harness switch
  // that KEEPS the model (below) writes only the harness, so a `selectedModel`
  // dep would have shown the old harness for exactly the shared-model case the
  // switch exists for. `seedWrites` below forces the render; this line is then
  // always current.
  const selectedAgentId = newSessionAgentId(agentList);

  const activeSessionRepo = useMemo(
    () => sessions.find((s) => s.id === sessionId)?.remoteUrl,
    [sessions, sessionId],
  );
  // The last quick session's repo wins over the repo the user is currently
  // sitting in. Quick capture is the "I just spotted a gap" surface, and that
  // gap is usually in a *different* repo than the one being worked in (the
  // canonical case: working in a product repo, filing work into ShipIt itself).
  // Re-targeting to the current session every time meant re-picking the same
  // repo on every capture. The remembered value is validated against the loaded
  // repo list so a removed/renamed repo silently falls back instead of
  // selecting nothing. Only when there's no remembered quick session do we fall
  // back to the current context. See docs/145 "Repo / target context".
  // `open` is in the deps so the value is re-read from localStorage on every
  // opening — a send earlier in this page session must be reflected without a
  // reload.
  // `open` reads as an unnecessary dependency because it is not referenced in
  // the body — that is the point: `getSavedQuickSessionRepo()` reads
  // localStorage, which React cannot track, so `open` is the deliberate
  // cache-buster that re-reads it on each opening.
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
    setSelectedModel(getSavedModelId());
    // Clear any explicit pick so the picker previews each agent's saved seed.
    setSelectedReasoning(undefined);
    // docs/175 decision #1 — auto-merge never persists across openings either.
    // Reset to off on every open so a prior session's opt-in can't carry over.
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

  // docs/205 — optimistic start. Close the overlay immediately and create the
  // session in the background, so the user gets straight back to their current
  // session instead of waiting behind a modal spinner (a cold clone is
  // ~10-30s). The new session appears in the sidebar via the `session_list` SSE
  // broadcast; the server has already dispatched the first prompt by the time
  // the request returns. A failure surfaces as an error toast since the overlay
  // is already gone.
  const handleSend = (payload: SendPayload) => {
    if (!selectedRepo) {
      setError("Add a repo first.");
      return;
    }
    // docs/217 — the explicit pick wins; otherwise the active agent's saved
    // seed (the ReasoningSelector persists every pick via `saveReasoning`), so
    // the level carries forward to new quick sessions exactly like the model.
    const reasoning = selectedReasoning ?? getSavedReasoning(selectedAgentId);
    const savedSelection = getSavedModelSelection();
    const params = {
      repoUrl: selectedRepo.url,
      initialPrompt: payload.text,
      agent: selectedAgentId,
      ...(selectedModel ? { model: selectedModel } : {}),
      // docs/252 — send the rest of the selection's identity alongside the id.
      // A quick session's first turn is dispatched server-side at creation, so
      // there is no WS connect to carry the seed; without these the bare id
      // would be re-resolved to whichever service sorts first, which for an id
      // two services offer is a coin flip over who gets billed. Only sent when
      // the saved selection is for THIS model — an explicit picker change since
      // the seed was read is a different choice and must not inherit its service.
      //
      // docs/252 phase 3 — and only when that saved selection is still
      // ELIGIBLE. The slot outlives a credential change: a triple written while
      // a subscription was connected still names a real catalogue row after the
      // subscription goes away, so sending it would pin a fresh session to a
      // mode with no credential and fail its first turn. Dropping the pair falls
      // back to server-side resolution of the bare id, which lands on a mode
      // that does have one.
      ...(selectedModel
        && savedSelection?.modelId === selectedModel
        && isSelectionEligibleForAgent(agentList, selectedAgentId, savedSelection)
        ? { serviceId: savedSelection.serviceId, billingMode: savedSelection.billingMode }
        : {}),
      ...(reasoning ? { reasoning } : {}),
      // docs/272 reqs 1, 11 — the role, which the server resolves and applies
      // OVER the harness/model/reasoning above rather than alongside them: those
      // describe controls the user handed over when they picked it. Sending both
      // keeps the client from having to resolve a role's tuple, which is the
      // second implementation docs/264 keeps out of the browser.
      ...(getSavedRoleName() ? { role: getSavedRoleName()! } : {}),
      ...(armAutoMerge ? { armAutoMerge: true } : {}),
      // docs/144 — Mode B is the voice-native path (hold the hotkey, speak a
      // task, it spawns a session), so the dictation hint matters most here.
      ...(payload.dictated ? { dictated: true } : {}),
      ...(payload.deferredFiles.length > 0 ? { files: payload.deferredFiles } : {}),
    };
    // Remember the target so the next quick capture defaults to it (see
    // `lastQuickSessionRepo`). Written on send, not on picker change, so an
    // abandoned overlay can't move the default.
    saveQuickSessionRepo(selectedRepo.url);
    setPendingFiles([]);
    close();
    // Let the app graduate the URL when the server reused the session the user
    // is sitting on (a /{slug}/new page's claimed session). See App.tsx
    // `handleQuickSessionCreated` — a true background session won't match the
    // active session id and stays put.
    startQuickSessionInBackground(params, (created) => onSessionCreated?.(created));
  };

  return (
    // Wrapped in the shared Dialog purely to inherit Back-button dismissal (the
    // wrapper pushes a history entry and maps Back → onOpenChange(false)). The
    // bespoke top-anchored, command-palette layout is kept as-is rather than
    // forced into DialogContent's centered / fullscreen-on-mobile mold.
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
            onSend={(payload) => handleSend(payload)}
            disabled={disabled}
            /* docs/257 req 3 — `disabledReason`, not just another clause in
               `disabled`. `disabled` guards submission only, so adding
               `!canRunTurns` there would leave Quick Capture typeable,
               attachable and — when opened by the voice hotkey — recording,
               with just the Send button dead. That is the "block at submit"
               failure the requirement rejects, reached through another door. */
            disabledReason={chatDisabledReason}
            isLoading={false}
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
              useUiStore.getState().setActiveAgentId(agentId);
              // …and MOVE THE MODEL onto that harness, or the pick is a no-op.
              // The harness here is derived from the model (see
              // `selectedAgentId`), so leaving the previous harness's model in
              // place re-derives the harness right back and the overlay ignores
              // the pick entirely — which is what "tapping Codex does nothing"
              // was. `persistHarnessPick` is that rule; it is shared with the
              // composer, which turned out to have the same bug one step later
              // (its pick survived until the next `useUiStore.reset()`).
              const nextModelId = persistHarnessPick({
                agentId,
                agents: agentList,
                ...(selectedModel ? { current: { modelId: selectedModel } } : {}),
              });
              if (nextModelId) setSelectedModel(nextModelId);
              // docs/272 req 15 — changing one of the three a role set is the
              // whole of leaving it, here as in the composer. There is no server
              // to ask on this surface, so the seed is cleared directly.
              saveRoleName(undefined);
              seedWritten();
              // Reasoning is per-agent — drop any explicit pick made for the
              // harness being left, exactly as a model switch does below.
              setSelectedReasoning(undefined);
            }}
            onModelChange={(selection) => {
              // docs/252 phase 3 — the picker now hands over the whole triple.
              // Quick Capture stores it verbatim rather than the bare id it used
              // to: dropping the service here is what let a fresh session
              // re-resolve to whichever service sorts first (a phase-1 finding).
              //
              // A model pick names a harness too, so it overrules any parked
              // redirect — same reason the composer's does.
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
              // docs/272 req 15 — see the harness handler above.
              saveRoleName(undefined);
              seedWritten();
              // Reasoning is per-agent; a model switch can change the agent, so
              // drop the explicit pick and let the new agent's seed take over.
              setSelectedReasoning(undefined);
            }}
            // No `sessionReasoning` here: there's no session yet, and the
            // selector's own seed fallback (`seedFromHistory`) + post-pick
            // `pending` state drive the displayed value. We only need the
            // callback to (a) make the control visible and (b) capture the pick
            // for the creation params below.
            onReasoningChange={(effort) => {
              // docs/272 req 15 — the level is the third of the three.
              saveRoleName(undefined);
              seedWritten();
              setSelectedReasoning(effort ?? undefined);
            }}
            // No `sessionRoleName`: this overlay has no session, so `MessageInput`
            // displays the seed slot itself — the same slot the creation params
            // above read. A second copy in this component's state was one more
            // thing that could disagree with it.
            onRoleChange={(roleName) => {
              // The pick IS the seed here: the creation params carry it and the
              // server applies it to the session it creates.
              saveRoleName(roleName);
              // …and the three pickers' seeds become the role's, so this overlay
              // shows what the role set rather than what it held before. req 18 —
              // "No role" has none to apply: it drops the name and the standing
              // instructions, and the parameters stay where the role left them.
              if (roleName !== undefined) {
                applyRoleSeeds(useSettingsStore.getState().roles.find((r) => r.name === roleName));
                clearParkedHarness();
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
