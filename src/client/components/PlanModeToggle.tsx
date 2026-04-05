import { NotepadIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { WithTooltip } from "./ui/tooltip.js";
import type { PermissionMode } from "../../server/shared/types.js";

export function PlanModeToggle({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const isPlan = mode === "plan";

  const toggle = () => {
    onChange(isPlan ? "auto" : "plan");
  };

  return (
    <WithTooltip label={isPlan ? "Plan mode (read-only)" : "Auto mode"}>
    <button
      onClick={toggle}
      aria-label={isPlan ? "Switch to auto mode" : "Switch to plan mode"}
      aria-pressed={isPlan}
      className={`flex items-center gap-1.5 rounded-lg transition-colors ${
        isPlan
          ? "px-1.5 py-1.5 bg-(--color-accent)/15 text-(--color-accent) hover:bg-(--color-accent)/25"
          : "p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
      }`}
      data-testid="plan-mode-toggle"
    >
      <NotepadIcon size={ICON_SIZE.SM} weight={isPlan ? "fill" : "regular"} />
      {isPlan && <span className="text-xs font-medium">Plan mode</span>}
    </button>
    </WithTooltip>
  );
}
