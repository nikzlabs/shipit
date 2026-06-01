import { NotepadIcon, ShieldCheckIcon, FastForwardIcon, CheckIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu.js";
import { WithTooltip } from "./ui/tooltip.js";
import { resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId } from "../utils/local-storage.js";
import type { AgentId, PermissionMode } from "../../server/shared/types.js";
import type { AgentOption } from "../agent-types.js";
import type { ModelInfo } from "../utils/model-info.js";

/**
 * docs/138 — three-state, agent-aware permission-mode selector. Replaces the
 * old binary PlanModeToggle. Oversight ladder (most → least): plan → guarded →
 * auto.
 *
 * - `plan`: read-only research/planning.
 * - `guarded`: autonomous, but every shell/network command is safety-checked by
 *   Claude before running; risky ones are blocked. Needs a Sonnet/Opus model
 *   and a Max/Team/Enterprise plan — the model coupling is gated here; the plan
 *   / admin coupling is detected at runtime and falls back automatically.
 * - `auto`: autonomous, no safety check (current default).
 *
 * Agent-aware: only modes in the active agent's `supportedPermissionModes` are
 * offered. For an agent that supports nothing (Codex) the selector hides
 * entirely — auto is the only behavior and there's nothing to toggle.
 */

const MODE_META: Record<
  PermissionMode,
  { label: string; icon: typeof NotepadIcon; description: string }
> = {
  plan: {
    label: "Plan mode",
    icon: NotepadIcon,
    description: "Read-only — research and plan, no edits.",
  },
  guarded: {
    label: "Guarded mode",
    icon: ShieldCheckIcon,
    description: "Autonomous — commands are safety-checked by Claude before running; risky ones are blocked. Slightly slower and costs a bit more than auto.",
  },
  auto: {
    label: "Auto mode",
    icon: FastForwardIcon,
    description: "Autonomous — no command safety check.",
  },
};

// Display order: most → least oversight.
const LADDER: PermissionMode[] = ["plan", "guarded", "auto"];

export function PermissionModeSelector({
  mode,
  onChange,
  agents,
  activeAgentId,
  modelInfo,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  agents: AgentOption[];
  activeAgentId: AgentId;
  modelInfo?: ModelInfo | null;
}) {
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const supported = activeAgent?.supportedPermissionModes ?? [];

  // Build the offered set: always include `auto` (every agent runs it), plus
  // any other modes the agent advertises. Ordered along the oversight ladder.
  const available = LADDER.filter((m) => m === "auto" || supported.includes(m));

  // Resolve the effective model alias to gate guarded's model coupling. Guarded
  // needs Sonnet or Opus; Haiku is unsupported. The runtime init-field check is
  // the backstop if a model turns out unsupported despite this gate.
  const effectiveAlias =
    (modelInfo?.model ? resolveModelAlias(modelInfo.model) : undefined) ??
    getSavedModelId() ??
    activeAgent?.models[0];
  const guardedModelOk = effectiveAlias !== "haiku";

  // Nothing meaningful to toggle (e.g. Codex: only `auto`). Hide the control —
  // this also fixes the latent gap where the old binary toggle showed `plan`
  // for agents that advertise no permission modes.
  if (available.length <= 1) return null;

  // The mode we actually display as active. If the stored mode isn't currently
  // offered (agent/model changed out from under it), fall back to auto.
  const displayMode: PermissionMode = available.includes(mode) ? mode : "auto";
  const Meta = MODE_META[displayMode];
  const TriggerIcon = Meta.icon;
  const isAuto = displayMode === "auto";

  return (
    <DropdownMenu>
      <WithTooltip label={Meta.description}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Permission mode"
            className={`flex items-center gap-1.5 rounded-lg transition-colors ${
              isAuto
                ? "p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
                : "px-1.5 py-1.5 bg-(--color-accent)/15 text-(--color-accent) hover:bg-(--color-accent)/25"
            }`}
            data-testid="permission-mode-selector"
          >
            <TriggerIcon size={ICON_SIZE.SM} weight={isAuto ? "regular" : "fill"} />
            {!isAuto && <span className="text-xs font-medium">{Meta.label}</span>}
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent side="top" align="start" className="w-72" data-testid="permission-mode-menu">
        {available.map((m) => {
          const meta = MODE_META[m];
          const Icon = meta.icon;
          const guardedDisabled = m === "guarded" && !guardedModelOk;
          const isCurrent = m === displayMode;
          return (
            <DropdownMenuItem
              key={m}
              disabled={guardedDisabled}
              onSelect={() => { if (!guardedDisabled) onChange(m); }}
              className="flex items-start gap-2 px-3 py-2"
              data-testid={`permission-mode-option-${m}`}
            >
              <Icon size={ICON_SIZE.SM} className="mt-0.5 shrink-0" weight={isCurrent ? "fill" : "regular"} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{meta.label}</span>
                  {isCurrent && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-accent)" />}
                </div>
                <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                  {guardedDisabled ? "Guarded mode needs a Sonnet or Opus model." : meta.description}
                </p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
