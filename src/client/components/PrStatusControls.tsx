import { useState } from "react";
import {
  CaretDownIcon,
  CheckCircleIcon,
  GitMergeIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { GitPullRequestClosedIcon } from "./GitPullRequestClosedIcon.js";
import { Button } from "./ui/button.js";
import { DropdownMenuItem } from "./ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";
import { AUTO_MERGE_ICON_CLASS, ICON_SIZE } from "../design-tokens.js";
import { useGitStore } from "../stores/git-store.js";
import { usePrStore, type PrCardState } from "../stores/pr-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUiStore } from "../stores/ui-store.js";

/** Reusable toggle switch for PR status actions. */
function ToggleSwitch({
  label,
  enabled,
  onToggle,
  title,
}: {
  label: ReactNode;
  enabled: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <Button variant="ghost" size="sm" onClick={onToggle} title={title}>
      <span className={`inline-block w-6 h-3.5 rounded-full transition-colors ${enabled ? "bg-(--color-success)" : "bg-(--color-text-tertiary)"}`}>
        <span className={`block w-2.5 h-2.5 mt-0.5 rounded-full bg-(--color-text-inverse) transition-transform ${enabled ? "translate-x-3" : "translate-x-0.5"}`} />
      </span>
      {label}
    </Button>
  );
}

/** Hover tooltip explaining ShipIt-managed auto-merge with a link to GitHub settings. */
function ManagedMergeInfo({ settingsUrl }: { settingsUrl?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-(--color-text-secondary) hover:text-(--color-text-primary) focus:outline-none focus:ring-2 focus:ring-(--color-border-focus)"
            aria-label="Auto-merge requirements"
            onClick={(event) => event.preventDefault()}
          >
            <InfoIcon size={ICON_SIZE.XS} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          collisionPadding={12}
          className="z-[60] w-[min(calc(100vw-2rem),16rem)] whitespace-normal p-2.5 text-(--color-text-secondary)"
        >
          <div>
            GitHub auto-merge requires branch protection rules. ShipIt will merge this PR when CI passes.
            {settingsUrl && (
              <a href={settingsUrl} target="_blank" rel="noopener noreferrer"
                className="block mt-1 underline hover:opacity-80 text-(--color-text-link)">
                Configure in GitHub settings
              </a>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// docs/169 — the per-card AutoFixToggle was removed: auto-fix CI is now a global
// account-level setting (Settings → PR automations), not a per-session toggle.

export function AutoMergeToggle({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const toggleAutoMerge = usePrStore((s) => s.toggleAutoMerge);
  const enabled = autoMerge?.enabled ?? false;

  return (
    <span className="flex items-center gap-1">
      <ToggleSwitch
        label={<span className="inline-flex items-center gap-1"><GitMergeIcon size={ICON_SIZE.XS} className={AUTO_MERGE_ICON_CLASS} />Auto-merge</span>}
        enabled={enabled}
        onToggle={() => toggleAutoMerge(sessionId, !enabled)}
        title={enabled ? "Disable auto-merge" : "Enable auto-merge"}
      />
      {autoMerge?.managed && <ManagedMergeInfo settingsUrl={autoMerge.settingsUrl} />}
    </span>
  );
}

const MERGE_METHOD_LABELS: Record<string, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/**
 * Shared close-PR state machine, used by every place the action appears: the
 * merge dropdown (regular, mergeable case) and the card / detail-panel overflow
 * menus (which keep close reachable when the merge button is hidden — most
 * importantly during merge conflicts). Owns the two-step-confirm + in-flight
 * state and the actual `closePr` call so the destructive logic lives in exactly
 * one place.
 *
 * `handleClose()` resolves to `true` only when the PR was actually closed, so a
 * caller can dismiss its own dropdown on success. `reset()` clears the armed
 * confirm — callers invoke it when their menu closes so it never reopens armed.
 */
export function useClosePr(sessionId: string) {
  const closePr = usePrStore((s) => s.closePr);
  const setToast = useUiStore((s) => s.setToast);
  // First click arms the confirm, the second commits — cheaper than a modal and
  // contained to whichever dropdown hosts the item.
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  const reset = () => setConfirmClose(false);

  const handleClose = async (): Promise<boolean> => {
    if (closing) return false;
    if (!confirmClose) {
      setConfirmClose(true);
      return false;
    }
    setClosing(true);
    const error = await closePr(sessionId);
    if (error) {
      setToast({ message: `Close failed: ${error}` });
      setClosing(false);
      setConfirmClose(false);
      return false;
    }
    setClosing(false);
    setConfirmClose(false);
    return true;
  };

  return { confirmClose, closing, handleClose, reset };
}

/** Shared label for the close item across its two visual treatments. */
function closePrLabel(confirmClose: boolean, closing: boolean): string {
  return closing ? "Closing..." : confirmClose ? "Click again to confirm" : "Close pull request";
}

/**
 * Close item styled for MergeButton's bespoke (non-Radix) dropdown — a plain
 * button matching the merge-method rows above it.
 */
function ClosePrMenuItem({
  confirmClose,
  closing,
  onClick,
}: {
  confirmClose: boolean;
  closing: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={closing}
      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-(--color-error) hover:bg-(--color-bg-hover) transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <span className="w-3 flex justify-center"><GitPullRequestClosedIcon size={12} /></span>
      {closePrLabel(confirmClose, closing)}
    </button>
  );
}

/**
 * Close item for a Radix `OverflowMenu` (the card's existing ⋮ menu and the
 * detail panel's). Reuses the `useClosePr` state passed in by the menu's owner
 * so the owner can `reset()` the armed confirm from the menu's `onOpenChange`.
 * First select arms the confirm and keeps the menu open (`preventDefault`); the
 * second runs the close and lets Radix close the menu.
 */
export function ClosePrDropdownItem({ state }: { state: ReturnType<typeof useClosePr> }) {
  const { confirmClose, closing, handleClose } = state;
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        if (!confirmClose) e.preventDefault();
        void handleClose();
      }}
      disabled={closing}
      className="text-(--color-error) hover:text-(--color-error) focus:text-(--color-error)"
    >
      <GitPullRequestClosedIcon size={ICON_SIZE.SM} className="shrink-0" />
      {closePrLabel(confirmClose, closing)}
    </DropdownMenuItem>
  );
}

export function MergeButton({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const merge = usePrStore((s) => s.merge);
  const setMergeMethod = usePrStore((s) => s.setMergeMethod);
  const setToast = useUiStore((s) => s.setToast);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const { confirmClose, closing, handleClose, reset } = useClosePr(sessionId);

  const method = autoMerge?.mergeMethod ?? "squash";
  const label = MERGE_METHOD_LABELS[method] ?? "Squash and merge";
  const disabled = merging || isAgentRunning;
  const title = isAgentRunning
    ? "Agent is still working; merge will be available when the turn finishes"
    : undefined;

  // Reset the armed-confirm state whenever the menu closes so it never reopens
  // pre-armed.
  const closeDropdown = () => {
    setDropdownOpen(false);
    reset();
  };

  const handleMerge = async () => {
    if (disabled) return;
    setMerging(true);
    const error = await merge(sessionId, method);
    if (error) {
      setToast({ message: `Merge failed: ${error}` });
      setMerging(false);
    }
  };

  const onCloseClick = async () => {
    if (await handleClose()) closeDropdown();
  };

  return (
    <div className="relative inline-flex">
      <button
        onClick={handleMerge}
        disabled={disabled}
        title={title}
        className="h-6 px-2 text-xs font-medium whitespace-nowrap bg-(--color-success) hover:opacity-90 text-(--color-text-inverse) rounded-l transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {merging ? "Merging..." : label}
      </button>
      <button
        onClick={() => (dropdownOpen ? closeDropdown() : setDropdownOpen(true))}
        disabled={disabled}
        title={title}
        className="h-6 px-1 text-xs font-medium bg-(--color-success) hover:opacity-90 text-(--color-text-inverse) rounded-r border-l border-black/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Select merge method"
      >
        <CaretDownIcon size={12} />
      </button>
      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeDropdown} />
          <div className="absolute top-full right-0 mt-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-md shadow-lg z-50 min-w-45">
            {(["squash", "merge", "rebase"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { void setMergeMethod(sessionId, m); closeDropdown(); }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors text-left"
              >
                <span className="w-3 text-(--color-success)">{m === method ? <CheckCircleIcon size={12} /> : ""}</span>
                {MERGE_METHOD_LABELS[m]}
              </button>
            ))}
            {/* docs/064 — close lives here for the regular (mergeable) case
                where it's most discoverable, right under the merge methods. The
                card / detail-panel overflow menu (ClosePrDropdownItem) carries
                the same action for the states where this whole button is hidden
                (conflicts, failing CI, review required, auto-merge armed). */}
            <div className="my-1 h-px bg-(--color-border-secondary)" />
            <ClosePrMenuItem
              confirmClose={confirmClose}
              closing={closing}
              onClick={() => void onCloseClick()}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function FixCIButton({ sessionId }: { sessionId: string }) {
  const fixCI = usePrStore((s) => s.fixCI);
  const setToast = useUiStore((s) => s.setToast);
  const [fixingCI, setFixingCI] = useState(false);

  const handleFixCI = async () => {
    setFixingCI(true);
    const error = await fixCI(sessionId);
    if (error) {
      setToast({ message: `Fix CI failed: ${error}` });
    }
    setFixingCI(false);
  };

  return (
    <Button
      variant="destructive"
      size="sm"
      onClick={handleFixCI}
      disabled={fixingCI}
      title={fixingCI ? "Fixing CI" : "Fix CI"}
      aria-label={fixingCI ? "Fixing CI" : "Fix CI"}
      className="shrink-0 h-6"
    >
      {fixingCI ? "Fixing..." : "Fix CI"}
    </Button>
  );
}

export function ResolveConflictsButton({ sessionId, baseBranch }: { sessionId: string; baseBranch: string }) {
  const startRebase = useGitStore((s) => s.startRebase);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const [starting, setStarting] = useState(false);

  const handleClick = async () => {
    if (isAgentRunning || starting) return;
    setStarting(true);
    try {
      await startRebase(sessionId, baseBranch);
    } finally {
      setStarting(false);
    }
  };

  const title = isAgentRunning
    ? "Wait for the agent to finish before resolving conflicts"
    : "Rebase onto the base branch and let the agent resolve conflicts";

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={isAgentRunning || starting}
      title={title}
      onClick={handleClick}
      className="shrink-0 h-6"
    >
      {starting ? "Starting..." : "Resolve conflicts"}
    </Button>
  );
}
