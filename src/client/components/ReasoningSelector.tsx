import { useCallback, useState } from "react";
import { BrainIcon, CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { getSavedReasoning, saveReasoning } from "../utils/local-storage.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "./ui/dropdown-menu.js";
import type { AgentOption } from "../agent-types.js";

/**
 * docs/217 — Control B: the composer's reasoning/effort control for the ACTIVE
 * session's own turns. Sits beside the model selector. The option set and label
 * are agent-defined (`agent.reasoning`); a "Default" entry maps to no value (the
 * CLI's native default). Hidden when the active agent exposes no reasoning knob.
 *
 * Value precedence: an optimistic local pick (until the session row catches up) →
 * the server-persisted per-session value (`sessionReasoning`) → the per-agent
 * localStorage seed. The seed is what makes switching agents restore each one's
 * last composer pick (docs/217 — "persist per agent separately").
 */
export function ReasoningSelector({
  agent,
  sessionReasoning,
  onChange,
  disabled,
  compactTrigger = false,
}: {
  agent: AgentOption | undefined;
  sessionReasoning: string | undefined;
  /** `null` clears the selection back to the agent's default. */
  onChange: (effort: string | null) => void;
  disabled?: boolean;
  /** Mobile composer mode: show only the brain icon to conserve toolbar width. */
  compactTrigger?: boolean;
}) {
  const [pending, setPending] = useState<string | null | undefined>(undefined);

  const handleSelect = useCallback(
    (effort: string | null) => {
      if (!agent) return;
      setPending(effort);
      saveReasoning(agent.id, effort);
      onChange(effort);
    },
    [agent, onChange],
  );

  const reasoning = agent?.reasoning;
  if (!agent || !reasoning || reasoning.options.length === 0) return null;

  // `pending` (incl. an explicit null = "Default just picked") wins until cleared;
  // otherwise the server value, then the per-agent seed. `undefined` ⇒ Default.
  const current =
    pending !== undefined
      ? pending ?? undefined
      : sessionReasoning ?? getSavedReasoning(agent.id);

  const currentLabel =
    reasoning.options.find((o) => o.value === current)?.label ?? "Default";

  return (
    <div data-testid="reasoning-selector">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled}
            className={`flex items-center justify-center gap-1.5 text-xs rounded-lg transition-colors font-medium text-(--color-text-secondary) hover:bg-(--color-bg-hover) cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              compactTrigger ? "h-8 w-8 p-0" : "px-2.5 py-1.5"
            }`}
            aria-label={`${reasoning.label} selector`}
            title={`${reasoning.label}: ${currentLabel}`}
            data-testid="reasoning-trigger"
          >
            <BrainIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />
            {!compactTrigger && (
              <>
                <span>{currentLabel}</span>
                <CaretDownIcon size={ICON_SIZE.XS} />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-44" data-testid="reasoning-dropdown">
          <DropdownMenuLabel>{reasoning.label}</DropdownMenuLabel>
          {[{ value: null as string | null, label: "Default" }, ...reasoning.options].map((opt) => {
            const isCurrent = (opt.value ?? undefined) === (current ?? undefined);
            return (
              <DropdownMenuItem
                key={opt.value ?? "__default__"}
                onSelect={() => handleSelect(opt.value)}
                className={`pl-5 pr-3 py-1.5 text-sm ${
                  isCurrent ? "bg-(--color-accent-subtle) text-(--color-text-link)" : ""
                }`}
                data-testid={`reasoning-option-${opt.value ?? "default"}`}
              >
                <span className="flex-1">{opt.label}</span>
                <span className="flex w-4 shrink-0 justify-end">
                  {isCurrent && <CheckIcon size={ICON_SIZE.SM} className="text-(--color-accent)" />}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
