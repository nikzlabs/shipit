import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";

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
  const handleClick = (mode: RollbackMode) => {
    onRollback(messageIndex, mode, parentCommitHash);
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          disabled={disabled}
          className="p-1 rounded text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-(--color-bg-hover) transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Rollback options"
          aria-label="Rollback options"
        >
          <ArrowCounterClockwiseIcon size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-52">
        <DropdownMenuItem onClick={() => handleClick("code")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Rollback code</div>
          <div className="text-(--color-text-secondary) mt-0.5">Revert files, keep chat history</div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleClick("code_and_chat")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Rollback code + chat</div>
          <div className="text-(--color-text-secondary) mt-0.5">Revert files, dim later messages</div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => handleClick("fork")} className="flex-col items-start">
          <div className="font-medium text-(--color-text-primary)">Fork as new session</div>
          <div className="text-(--color-text-secondary) mt-0.5">New branch from this point</div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
