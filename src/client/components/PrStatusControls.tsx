import { useState } from "react";
import {
  CaretDownIcon,
  CheckCircleIcon,
  GitMergeIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "./ui/button.js";
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

export function MergeButton({ sessionId, autoMerge }: { sessionId: string; autoMerge?: PrCardState["autoMerge"] }) {
  const merge = usePrStore((s) => s.merge);
  const setMergeMethod = usePrStore((s) => s.setMergeMethod);
  const setToast = useUiStore((s) => s.setToast);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [merging, setMerging] = useState(false);

  const method = autoMerge?.mergeMethod ?? "squash";
  const label = MERGE_METHOD_LABELS[method] ?? "Squash and merge";
  const disabled = merging || isAgentRunning;
  const title = isAgentRunning
    ? "Agent is still working; merge will be available when the turn finishes"
    : undefined;

  const handleMerge = async () => {
    if (disabled) return;
    setMerging(true);
    const error = await merge(sessionId, method);
    if (error) {
      setToast({ message: `Merge failed: ${error}` });
      setMerging(false);
    }
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
        onClick={() => setDropdownOpen(!dropdownOpen)}
        disabled={disabled}
        title={title}
        className="h-6 px-1 text-xs font-medium bg-(--color-success) hover:opacity-90 text-(--color-text-inverse) rounded-r border-l border-black/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label="Select merge method"
      >
        <CaretDownIcon size={12} />
      </button>
      {dropdownOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
          <div className="absolute top-full right-0 mt-1 bg-(--color-bg-elevated) border border-(--color-border-secondary) rounded-md shadow-lg z-50 min-w-45">
            {(["squash", "merge", "rebase"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { void setMergeMethod(sessionId, m); setDropdownOpen(false); }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors text-left"
              >
                <span className="w-3 text-(--color-success)">{m === method ? <CheckCircleIcon size={12} /> : ""}</span>
                {MERGE_METHOD_LABELS[m]}
              </button>
            ))}
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
