// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

export type RollbackMode = "code" | "code_and_chat" | "fork";

interface RollbackDropdownProps {
  messageIndex: number;
  parentCommitHash: string;
  disabled?: boolean;
  onRollback: (messageIndex: number, mode: RollbackMode, parentCommitHash: string) => void;
  /** Called when the dropdown opens/closes so the parent can keep the toolbar visible. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Dropdown button that appears on assistant messages with a linked git commit.
 * Offers three rollback options: code only, code+chat, or fork as new session.
 */
export function RollbackDropdown({ messageIndex, parentCommitHash, disabled, onRollback, onOpenChange }: RollbackDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const updateOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
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

  const handleClick = (mode: RollbackMode) => {
    updateOpen(false);
    onRollback(messageIndex, mode, parentCommitHash);
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

      {open && (
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
            <div className="text-(--color-text-secondary) mt-0.5">New branch from this point</div>
          </button>
        </div>
      )}
    </div>
  );
}
