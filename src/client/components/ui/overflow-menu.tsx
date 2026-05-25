import type { ReactNode } from "react";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { cn } from "../../utils/cn.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

interface OverflowMenuProps {
  children: ReactNode;
  /** Accessible label and title for the trigger button. */
  label?: string;
  /** Alignment passed through to the Radix dropdown content. */
  align?: "start" | "center" | "end";
  /** Side passed through to the Radix dropdown content. */
  side?: "top" | "right" | "bottom" | "left";
  /** Optional width/content styling for the dropdown panel. */
  contentClassName?: string;
  /** Optional trigger styling for local sizing/spacing. */
  triggerClassName?: string;
  /** Called whenever the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

export function OverflowMenu({
  children,
  label = "More options",
  align = "end",
  side = "bottom",
  contentClassName,
  triggerClassName,
  onOpenChange,
}: OverflowMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded text-(--color-text-tertiary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
            triggerClassName,
          )}
          title={label}
          aria-label={label}
        >
          <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className={contentClassName}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
