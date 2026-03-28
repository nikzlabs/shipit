// eslint-disable-next-line no-restricted-imports -- useEffect: document mousedown listener for click-outside with cleanup (browser API subscription)
import { useState, useRef, useEffect } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";

export type RewindMode = "fork_chat" | "rewind_code" | "rewind_all";

interface RewindDropdownProps {
  messageIndex: number;
  disabled?: boolean;
  onRewind: (messageIndex: number, mode: RewindMode) => void;
  /** Called when the dropdown opens/closes so the parent can keep the toolbar visible. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Dropdown button that appears on user messages.
 * Offers three rewind options: fork conversation, rewind code, or both.
 */
export function RewindDropdown({ messageIndex, disabled, onRewind, onOpenChange }: RewindDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const updateOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };

  // Close on outside click
  // eslint-disable-next-line no-restricted-syntax -- existing usage
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

  const handleClick = (mode: RewindMode) => {
    updateOpen(false);
    onRewind(messageIndex, mode);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => updateOpen(!open)}
        disabled={disabled}
        className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Rewind options"
        aria-label="Rewind options"
      >
        <ArrowCounterClockwiseIcon size={14} />
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-1 w-60 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-lg shadow-lg z-50 py-1">
          <button
            onClick={() => handleClick("fork_chat")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Fork conversation from here</div>
            <div className="text-(--color-text-secondary) mt-0.5">New conversation branch, keep code as-is</div>
          </button>
          <button
            onClick={() => handleClick("rewind_code")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Rewind code to here</div>
            <div className="text-(--color-text-secondary) mt-0.5">Revert files, keep conversation</div>
          </button>
          <button
            onClick={() => handleClick("rewind_all")}
            className="w-full text-left px-3 py-2 text-xs hover:bg-(--color-bg-hover) text-(--color-text-primary)"
          >
            <div className="font-medium">Fork conversation and rewind code</div>
            <div className="text-(--color-text-secondary) mt-0.5">Revert files, new conversation branch</div>
          </button>
        </div>
      )}
    </div>
  );
}
