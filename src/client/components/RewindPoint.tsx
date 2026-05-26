import { useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon, GitForkIcon } from "@phosphor-icons/react";
import type { RewindAtGapAction, WsRewindPreview } from "../../server/shared/types.js";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";

export type RewindGapAction = RewindAtGapAction;

interface RewindPointProps {
  gapPosition: number;
  currentState?: boolean;
  disabled?: boolean;
  defaultBranchName: string;
  previews?: Partial<Record<RewindGapAction, WsRewindPreview>>;
  onRequestPreview?: (gapPosition: number, action: RewindGapAction) => void;
  onRewind: (gapPosition: number, action: RewindGapAction, branchName?: string) => void;
}

const ACTIONS: RewindGapAction[] = ["chat", "code", "both", "fork"];

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function Skeleton({ width }: { width: string }) {
  return (
    <span
      className={`inline-block h-3 ${width} animate-pulse rounded bg-(--color-bg-tertiary) align-middle`}
      aria-hidden="true"
    />
  );
}

function renderSubtitle(action: RewindGapAction, preview?: WsRewindPreview): ReactNode {
  if (action === "fork") {
    if (preview?.keptTurnGroupCount === undefined) return <Skeleton width="w-32" />;
    return `Includes ${plural(preview.keptTurnGroupCount, "turn group")}`;
  }

  if (action === "chat") {
    if (preview?.discardedTurnGroupCount === undefined) return <Skeleton width="w-28" />;
    return `Discard ${plural(preview.discardedTurnGroupCount, "turn group")}`;
  }

  if (action === "code") {
    if (preview?.fileCount === undefined) return <Skeleton width="w-32" />;
    return `Reset ${plural(preview.fileCount, "file")}, keep chat`;
  }

  if (preview?.discardedTurnGroupCount === undefined || preview?.fileCount === undefined) {
    return <Skeleton width="w-44" />;
  }
  return `Discard ${plural(preview.discardedTurnGroupCount, "turn group")} and reset ${plural(preview.fileCount, "file")}`;
}

function titleFor(action: RewindGapAction): string {
  switch (action) {
    case "chat": return "Rewind Chat";
    case "code": return "Rewind Code";
    case "both": return "Rewind Chat and Code";
    case "fork": return "Fork as New Session";
  }
}

export function RewindPoint({
  gapPosition,
  currentState = false,
  disabled = false,
  defaultBranchName,
  previews,
  onRequestPreview,
  onRewind,
}: RewindPointProps) {
  const [pendingAction, setPendingAction] = useState<Exclude<RewindGapAction, "chat"> | null>(null);
  const [branchName, setBranchName] = useState(defaultBranchName);
  const [menuOpen, setMenuOpen] = useState(false);
  const availableActions = currentState ? (["fork"] as RewindGapAction[]) : ACTIONS;
  const modalPreview = pendingAction ? previews?.[pendingAction] : undefined;

  const modalSummary = useMemo<ReactNode>(() => {
    if (!pendingAction) return "";
    return renderSubtitle(pendingAction, modalPreview);
  }, [modalPreview, pendingAction]);

  const requestPreviews = (open: boolean) => {
    setMenuOpen(open);
    if (!open || disabled) return;
    for (const action of availableActions) onRequestPreview?.(gapPosition, action);
  };

  const chooseAction = (action: RewindGapAction) => {
    if (disabled) return;
    if (action === "chat") {
      onRewind(gapPosition, "chat");
      return;
    }
    if (action === "fork") setBranchName(defaultBranchName);
    setPendingAction(action);
    onRequestPreview?.(gapPosition, action);
  };

  const confirm = () => {
    if (!pendingAction) return;
    onRewind(gapPosition, pendingAction, pendingAction === "fork" ? branchName.trim() : undefined);
    setPendingAction(null);
  };

  const confirmDisabled = pendingAction === "fork" && branchName.trim().length === 0;

  return (
    <div
      className="group/rewind relative flex h-6 items-center gap-0 transition-[gap] duration-150 hover:gap-24 data-[menu-open=true]:gap-24"
      data-testid="rewind-point"
      data-menu-open={menuOpen}
    >
      <div className="h-px flex-1 bg-(--color-border-secondary) opacity-30 transition-opacity group-hover/rewind:opacity-100 group-data-[menu-open=true]/rewind:opacity-100" />
      <div className="h-px flex-1 bg-(--color-border-secondary) opacity-30 transition-opacity group-hover/rewind:opacity-100 group-data-[menu-open=true]/rewind:opacity-100" />
      <DropdownMenu onOpenChange={requestPreviews}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="absolute left-1/2 top-1/2 inline-flex h-6 -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-2 text-xs font-medium text-(--color-text-secondary) opacity-0 transition-opacity hover:bg-(--color-bg-tertiary) hover:text-(--color-text-primary) focus:opacity-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 group-hover/rewind:opacity-100 group-data-[menu-open=true]/rewind:opacity-100"
            title={disabled ? "Wait for the current turn to finish" : currentState ? "Fork current state" : "Rewind options"}
            aria-label={currentState ? "Fork current state" : "Rewind options"}
          >
            {currentState ? <GitForkIcon size={ICON_SIZE.SM} /> : <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />}
            {currentState ? "Fork" : "Rewind"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" side="top" className="w-64">
          {!currentState && (
            <>
              <DropdownMenuItem onSelect={() => chooseAction("chat")} className="flex-col items-start">
                <div className="font-medium text-(--color-text-primary)">Rewind chat to here</div>
                <div className="mt-0.5 text-(--color-text-secondary)">{renderSubtitle("chat", previews?.chat)}</div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chooseAction("code")} className="flex-col items-start">
                <div className="font-medium text-(--color-text-primary)">Rewind code to here</div>
                <div className="mt-0.5 text-(--color-text-secondary)">{renderSubtitle("code", previews?.code)}</div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chooseAction("both")} className="flex-col items-start">
                <div className="font-medium text-(--color-text-primary)">Rewind chat and code</div>
                <div className="mt-0.5 text-(--color-text-secondary)">{renderSubtitle("both", previews?.both)}</div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => chooseAction("fork")} className="flex-col items-start">
            <div className="font-medium text-(--color-text-primary)">Fork as new session</div>
            <div className="mt-0.5 text-(--color-text-secondary)">{renderSubtitle("fork", previews?.fork)}</div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent className="w-[min(92vw,28rem)]">
          <DialogHeader>
            <div>
              <DialogTitle>{pendingAction ? titleFor(pendingAction) : "Rewind"}</DialogTitle>
              <DialogDescription className="mt-1">{modalSummary}</DialogDescription>
            </div>
          </DialogHeader>
          <div className="space-y-3 px-5 py-4">
            {pendingAction === "fork" ? (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-(--color-text-secondary)">Branch slug</span>
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !confirmDisabled) confirm();
                    if (event.key === "Escape") setPendingAction(null);
                  }}
                  className="w-full rounded-md border border-(--color-border-secondary) bg-(--color-bg-tertiary) px-3 py-2 text-sm text-(--color-text-primary) outline-none focus:border-(--color-border-focus)"
                  autoFocus
                />
              </label>
            ) : (
              <p className="text-sm text-(--color-text-secondary)">
                This resets the workspace state for this session. The chat remains visible unless this action discards it.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setPendingAction(null)}>Cancel</Button>
            <Button type="button" variant={pendingAction === "fork" ? "primary" : "destructive"} disabled={confirmDisabled} onClick={confirm}>
              {pendingAction === "fork" ? "Fork" : "Rewind"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
