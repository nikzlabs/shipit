import { useState, useRef, useCallback } from "react";
import { ArchiveIcon as PhArchiveIcon, ArrowCounterClockwiseIcon, DownloadSimpleIcon, PencilSimpleIcon, PushPinIcon, WrenchIcon, CaretRightIcon, CaretDownIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { formatRelativeDate } from "../../utils/dates.js";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu.js";
import { OverflowMenu } from "../ui/overflow-menu.js";
import { PrStateBadge } from "../PrLifecycleCard.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useAttentionInfo } from "../../hooks/useAttentionInfo.js";
import type { SessionInfo } from "../../../server/shared/types.js";
import { SessionStatusDot, AutoMergeBadge, DiskTierBadge } from "./SessionStatusIndicators.js";

interface SessionItemProps {
  session: SessionInfo;
  isCurrent: boolean;
  onResume: (id: string) => void;
  onSelectCurrent?: () => void;
  onArchive?: (id: string) => void;
  onRestore?: (id: string) => void;
  repoLabel?: string;
  disabled?: boolean;
  /**
   * docs/117 Phase 2 — when true, this session row is rendered indented to
   * indicate it was spawned by another session in the same group (the
   * parent appears immediately above). Visual-only; the click target and
   * archive controls are identical to a regular row.
   */
  indented?: boolean;
  /**
   * Number of agent-spawned children attached to this session. When > 0,
   * the row renders a caret toggle on the left so the user can collapse the
   * brood — matches the existing repo-header caret pattern.
   */
  childCount?: number;
  isChildrenCollapsed?: boolean;
  onToggleChildren?: () => void;
  /**
   * docs/156 — true when the device is a touch screen. The session row's
   * overflow menu trigger is always visible on touch (no hover affordance);
   * on desktop it hover-reveals on inactive rows.
   */
  isTouch?: boolean;
  /**
   * Render the overflow menu through a portal by default. Dialog-contained rows
   * disable this so Radix Dialog's modal focus/aria scope owns the menu too.
   */
  overflowMenuPortaled?: boolean;
}

export function SessionItem({ session, isCurrent, onResume, onSelectCurrent, onArchive, onRestore, repoLabel, disabled, indented, childCount, isChildrenCollapsed, onToggleChildren, isTouch, overflowMenuPortaled = true }: SessionItemProps) {
  const isArchived = session.archived === true;

  const attentionReason = useAttentionInfo(session.id);
  const needsAttention = attentionReason !== null && !isArchived;
  const hasChildren = (childCount ?? 0) > 0 && !!onToggleChildren;

  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editResolvedRef = useRef(false);

  const startEditing = useCallback(() => {
    setEditingTitle(session.title);
    editResolvedRef.current = false;
    setIsEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [session.title]);

  const submitRename = useCallback(() => {
    if (editResolvedRef.current) return;
    editResolvedRef.current = true;
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== session.title) {
      void useSessionStore.getState().renameSession(session.id, trimmed);
    }
    setIsEditing(false);
    setEditingTitle("");
  }, [editingTitle, session.title, session.id]);

  const cancelEditing = useCallback(() => {
    editResolvedRef.current = true;
    setIsEditing(false);
    setEditingTitle("");
  }, []);

  // docs/128 — spin up a privileged ops session pre-loaded to investigate THIS
  // session. The store seeds the new session's composer with the target id +
  // a read-only first step, so the operator never copy-pastes the session id
  // into a blank ops session. On success we navigate straight into it.
  const handleInvestigateInOps = useCallback(async () => {
    const newId = await useSessionStore.getState().createOpsSession(session.id);
    if (newId) {
      onResume(newId);
    } else {
      useUiStore.getState().setToast({ message: "Failed to create ops session" });
    }
  }, [session.id, onResume]);

  // Chat/session-scoped actions, relocated here from the PR card's overflow
  // menu (which is now PR-only). Both are limited to the *current* session: the
  // store's `messages` are only the active session's, and a rewind restore must
  // go over that session's socket. The rewind-restore event is bridged to the
  // WS sender by a listener in App.tsx (`shipit:restore-rewind`).
  const rewindRecovery = useSessionStore((s) => s.rewindRecoveries[session.id]);
  const canRecoverRewind = isCurrent && !!rewindRecovery && rewindRecovery.expiresAt > Date.now();

  const handleDownloadChat = useCallback(() => {
    const msgs = useSessionStore.getState().messages;
    if (msgs.length === 0) return;
    const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${session.id}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session.id]);

  const handleRecoverRewind = useCallback(() => {
    window.dispatchEvent(new CustomEvent("shipit:restore-rewind", { detail: { sessionId: session.id } }));
  }, [session.id]);

  // docs/110 — toggle the pin (persistent) flag. Pinning sticks the session to
  // the top of its repo group and exempts it from sidebar demotion + disk
  // reclamation; the store optimistically updates and the server broadcasts the
  // reconciled session_list.
  const isPinned = !!session.pinnedAt;
  const handleTogglePin = useCallback(() => {
    void useSessionStore.getState().setPinned(session.id, !session.pinnedAt);
  }, [session.id, session.pinnedAt]);

  // The overflow trigger is always visible on the active row, on touch
  // devices, and while the menu itself is open. On inactive desktop rows it
  // hover-reveals so it doesn't add visual noise to the long sidebar list.
  const overflowAlwaysVisible = isCurrent || menuOpen || Boolean(isTouch);
  const hasCurrentSessionActions = isCurrent;
  const canInvestigateInOps = session.kind !== "ops";
  const hasSeparatedActions = hasCurrentSessionActions || canInvestigateInOps;

  // docs/187 — "rail + trail": a needs-attention session is marked on the row's
  // open RIGHT edge (clear of the PR icon and the panel's left border, where a
  // marker is easy to miss). A crisp solid amber bar on the right edge — an `inset`
  // box-shadow with a negative x-offset, so it paints the right inner edge with zero
  // layout shift — gives the hard contrast peripheral vision catches; a soft amber
  // gradient trails left from it for the glow. Both reuse the saturated per-theme
  // `--color-attention` (the trail via `color-mix`), so no new tokens; the
  // background layers over the row's own fill, so it coexists with the selected gray.
  const attentionMarker = needsAttention
    ? {
        boxShadow: "inset -3px 0 0 var(--color-attention)",
        backgroundImage:
          "linear-gradient(90deg, transparent 62%, color-mix(in srgb, var(--color-attention) 20%, transparent))",
      }
    : undefined;

  return (
    <div
      data-testid={indented ? "session-item-indented" : "session-item"}
      className={`group flex items-start gap-1.5 px-2 py-1.5 text-xs transition-colors rounded mx-1 ${
        indented ? "ml-5" : ""
      } ${
        isArchived ? "opacity-60" : ""
      } ${
        isCurrent
          ? "bg-(--color-bg-secondary) text-(--color-text-primary)"
          : isArchived
            ? "text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)"
            : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
      }`}
      style={attentionMarker}
      title={attentionReason ?? undefined}
    >
      {hasChildren && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleChildren?.(); }}
          className="shrink-0 -ml-1.5 w-4 h-4 mt-px flex items-center justify-center text-(--color-text-tertiary) hover:text-(--color-text-primary) rounded"
          aria-label={isChildrenCollapsed ? `Show ${childCount} spawned session${childCount === 1 ? "" : "s"}` : `Hide ${childCount} spawned session${childCount === 1 ? "" : "s"}`}
          title={isChildrenCollapsed ? `Show ${childCount} spawned` : `Hide ${childCount} spawned`}
        >
          {isChildrenCollapsed
            ? <CaretRightIcon size={ICON_SIZE.XS} />
            : <CaretDownIcon size={ICON_SIZE.XS} />
          }
        </button>
      )}
      <PrStateBadge sessionId={session.id} />

      {isEditing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); submitRename(); }}
          className="flex-1 min-w-0"
        >
          <input
            ref={inputRef}
            type="text"
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") cancelEditing(); }}
            onBlur={submitRename}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-(--color-bg-tertiary) text-(--color-text-primary) text-xs px-1.5 py-0.5 rounded border border-(--color-border-secondary) focus:border-(--color-border-focus) focus:outline-none"
            maxLength={120}
            aria-label="Session name"
          />
        </form>
      ) : (
        <button
          onClick={() => {
            if (isCurrent) {
              onSelectCurrent?.();
              return;
            }
            onResume(session.id);
          }}
          disabled={disabled}
          className="flex-1 min-w-0 text-left"
        >
          <p
            className="truncate leading-snug"
          >
            {session.title}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <SessionStatusDot sessionId={session.id} />
            {isPinned && (
              <PushPinIcon size={ICON_SIZE.XS} weight="fill" className="text-(--color-accent) shrink-0" />
            )}
            {session.kind === "ops" && (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-(--color-text-tertiary) border border-(--color-border-secondary) rounded px-1 leading-tight shrink-0">
                ops
              </span>
            )}
            {session.kind === "sandbox" && (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-(--color-sandbox) bg-(--color-sandbox-subtle) rounded px-1 leading-tight shrink-0">
                sandbox
              </span>
            )}
            {repoLabel && (
              <span className="text-[10px] text-(--color-text-tertiary) truncate">{repoLabel}</span>
            )}
            {isArchived && <PhArchiveIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary) shrink-0" />}
            {!isArchived && <DiskTierBadge session={session} />}
            <span className="text-(--color-text-tertiary) text-[10px]">{formatRelativeDate(session.lastUsedAt)}</span>
            <AutoMergeBadge sessionId={session.id} />
          </div>
        </button>
      )}

      {!isEditing && (
        <div
          className={`shrink-0 flex items-center gap-0.5 transition-opacity ${
            overflowAlwaysVisible ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <OverflowMenu
            label="Session actions"
            triggerClassName="h-7 w-7"
            portaled={overflowMenuPortaled}
            onOpenChange={setMenuOpen}
          >
            {!isArchived && (
              <>
                <DropdownMenuItem onSelect={startEditing} disabled={disabled}>
                  <PencilSimpleIcon size={ICON_SIZE.SM} />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleTogglePin} disabled={disabled}>
                  <PushPinIcon size={ICON_SIZE.SM} weight={isPinned ? "fill" : "regular"} />
                  {isPinned ? "Unpin" : "Pin to top"}
                </DropdownMenuItem>
                {onArchive && (
                  <DropdownMenuItem onSelect={() => onArchive(session.id)} disabled={disabled}>
                    <PhArchiveIcon size={ICON_SIZE.SM} />
                    Archive
                  </DropdownMenuItem>
                )}
                {hasSeparatedActions && <DropdownMenuSeparator />}
                {/* Chat-scoped actions, only on the active session's row (see the
                    handlers above for why they're current-only). */}
                {hasCurrentSessionActions && (
                  <>
                    {canRecoverRewind && (
                      <DropdownMenuItem onSelect={handleRecoverRewind}>
                        <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
                        Recover recent rewind
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={handleDownloadChat}>
                      <DownloadSimpleIcon size={ICON_SIZE.SM} />
                      Download chat
                    </DropdownMenuItem>
                  </>
                )}
                {canInvestigateInOps && (
                  <DropdownMenuItem onSelect={() => void handleInvestigateInOps()} disabled={disabled}>
                    <WrenchIcon size={ICON_SIZE.SM} />
                    Investigate in Ops session
                  </DropdownMenuItem>
                )}
              </>
            )}
            {isArchived && onRestore && (
              <DropdownMenuItem onSelect={() => onRestore(session.id)} disabled={disabled}>
                <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
                Restore
              </DropdownMenuItem>
            )}
          </OverflowMenu>
        </div>
      )}
    </div>
  );
}
