import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";

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
  const handleClick = (mode: RewindMode) => {
    onRewind(messageIndex, mode);
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          disabled={disabled}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Rewind options"
          aria-label="Rewind options"
        >
          <ArrowCounterClockwiseIcon size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60">
        <DropdownMenuItem onSelect={() => handleClick("fork_chat")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Fork conversation from here</div>
          <div className="text-(--color-text-secondary) mt-0.5">New conversation branch, keep code as-is</div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleClick("rewind_code")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Rewind code to here</div>
          <div className="text-(--color-text-secondary) mt-0.5">Revert files, keep conversation</div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleClick("rewind_all")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Fork conversation and rewind code</div>
          <div className="text-(--color-text-secondary) mt-0.5">Revert files, new conversation branch</div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
