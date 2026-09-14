import type { ReactNode } from "react";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../../design-tokens.js";
import { cn } from "../../utils/cn.js";
import { bindSetting } from "../Settings/setting-binding.js";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

interface OverflowMenuProps {
  children: ReactNode;

  label?: string;

  align?: "start" | "center" | "end";

  side?: "top" | "right" | "bottom" | "left";

  contentClassName?: string;

  triggerClassName?: string;

  portaled?: boolean;

  onOpenChange?: (open: boolean) => void;

  /** The declaration whose operations this menu offers, where it has one. */
  settingKey?: SettingKey;
}

export function OverflowMenu({
  children,
  label = "More options",
  align = "end",
  side = "bottom",
  contentClassName,
  triggerClassName,
  portaled = true,
  onOpenChange,
  settingKey,
}: OverflowMenuProps) {
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded text-(--color-text-tertiary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
            triggerClassName,
          )}
          title={label}
          aria-label={label}
          {...(settingKey ? bindSetting(settingKey) : {})}
        >
          <DotsThreeVerticalIcon size={ICON_SIZE.SM} weight="bold" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className={contentClassName} portaled={portaled}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
