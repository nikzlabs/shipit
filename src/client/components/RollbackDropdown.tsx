// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

export type RollbackMode = "code" | "code_and_chat" | "fork";

interface RollbackDropdownProps {
  messageIndex: number;
  parentCommitHash: string;
  disabled?: boolean;
  onRollback: (messageIndex: number, mode: RollbackMode, parentCommitHash: string, sessionName?: string) => void;
  /** Called when the dropdown opens/closes so the parent can keep the toolbar visible. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Dropdown button that appears on assistant messages with a linked git commit.
 * Offers three rollback options: code only, code+chat, or fork as new session.
 *
 * Fork flow asks for a session name inline — the branch name is derived
 * server-side from the active session's branch, so the user only names the
 * thing they will actually see in the sidebar.
 */
export function RollbackDropdown({ messageIndex, parentCommitHash, disabled, onRollback, onOpenChange }: RollbackDropdownProps) {
  const [open, setOpen] = useState(false);
  const [namingFork, setNamingFork] = useState(false);
  const [forkName, setForkName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const updateOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
    if (!value) {
      setNamingFork(false);
      setForkName("");
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        updateOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus the name input when transitioning to the naming step
  useEffect(() => {
    if (namingFork) nameInputRef.current?.focus();
  }, [namingFork]);

  const handleClick = (mode: RollbackMode) => {
    if (mode === "fork") {
      setNamingFork(true);
      return;
    }
    updateOpen(false);
    onRollback(messageIndex, mode, parentCommitHash);
  };

  const submitFork = () => {
    const trimmed = forkName.trim();
    if (!trimmed) return;
    updateOpen(false);
    onRollback(messageIndex, "fork", parentCommitHash, trimmed);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => updateOpen(!open)}
        disabled={disabled}
        className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Rollback options"
        aria-label="Rollback options"
      >
        {/* Undo/rewind icon */}
        <ArrowCounterClockwiseIcon size={14} />
      </button>

      {open && !namingFork && (
        <div className="absolute right-0 bottom-full mb-1 w-52 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1">
          <button
            onClick={() => handleClick("code")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Rollback code</div>
            <div className="text-(--color-text-secondary) mt-0.5">Revert files, keep chat history</div>
          </button>
          <button
            onClick={() => handleClick("code_and_chat")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Rollback code + chat</div>
            <div className="text-(--color-text-secondary) mt-0.5">Revert files, dim later messages</div>
          </button>
          <div className="border-t border-(--color-border-primary) my-1" />
          <button
            onClick={() => handleClick("fork")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Fork as new session</div>
            <div className="text-(--color-text-secondary) mt-0.5">New session from this point</div>
          </button>
        </div>
      )}

      {open && namingFork && (
        <form
          onSubmit={(e) => { e.preventDefault(); submitFork(); }}
          className="absolute right-0 bottom-full mb-1 w-64 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 p-3 space-y-2"
        >
          <label className="block text-xs font-medium text-(--color-text-primary)">Session name</label>
          <input
            ref={nameInputRef}
            type="text"
            value={forkName}
            onChange={(e) => setForkName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") updateOpen(false); }}
            placeholder="e.g. Try alt approach"
            maxLength={120}
            className="w-full bg-(--color-bg-tertiary) text-(--color-text-primary) text-xs px-2 py-1.5 rounded border border-(--color-border-secondary) focus:border-(--color-border-focus) focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => updateOpen(false)}
              className="px-2 py-1 text-xs rounded text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!forkName.trim()}
              className="px-2 py-1 text-xs rounded bg-(--color-accent) text-(--color-accent-text) disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Fork
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
