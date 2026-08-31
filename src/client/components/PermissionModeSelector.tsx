import {
  NotepadIcon,
  ShieldCheckIcon,
  FastForwardIcon,
  CheckIcon,
  GlobeIcon,
  GlobeXIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { INSET_FOCUS_RING, ICON_SIZE } from "../design-tokens.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.js";
import { WithTooltip } from "./ui/tooltip.js";
import { resolveModelAlias } from "../utils/format-model.js";
import { getSavedModelId } from "../utils/local-storage.js";
import {
  NETWORK_MODE_LABEL,
  enforcementWarning,
  resolvesToContained,
  type NetworkMode,
} from "../hooks/useSessionNetworkMode.js";
import type {
  AgentId,
  EgressEnforcementStatus,
  PermissionMode,
} from "../../server/shared/types.js";
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
 * offered.
 *
 * ---
 *
 * docs/285 — it now carries the session's **network mode** as well, as a second
 * labelled section in the same flat popover (reqs 5, 6).
 *
 * Network containment gets no control of its own: it is needed rarely, and the
 * composer row is the scarcest space in the product (docs/260 exists to keep
 * that row from pushing Send off the edge). It shares the control that already
 * holds the thing it most resembles — a per-session switch governing what the
 * agent is allowed to do.
 *
 * **Flat, not a drill-down.** Two short sections fit in one menu body, and a
 * setting the user reaches this rarely should not also cost a navigation step.
 * `ComposerSettingsMenu`'s drill-down exists because that menu must survive
 * catalogue growth (dozens of models); this one has at most six rows, forever.
 *
 * **One trigger, every viewport** (req 6). The mode left `ComposerSettingsMenu`
 * entirely rather than appearing in both, so there is one control for one
 * setting — and on mobile that removed a level of nesting rather than adding one
 * (req 9).
 */

/**
 * docs/260-composer-toolbar-layout req 17 — `label` is the mode ALONE ("Guarded"), because it renders as
 * a badge in the composer row where the second word was 34px of nothing. The
 * menu below spells out "<label> mode", where it reads as a description and
 * there is room for it.
 */
const MODE_META: Record<
  PermissionMode,
  { label: string; icon: typeof NotepadIcon; description: string }
> = {
  plan: {
    label: "Plan",
    icon: NotepadIcon,
    description: "Read-only — research and plan, no edits.",
  },
  guarded: {
    label: "Guarded",
    icon: ShieldCheckIcon,
    description: "Autonomous — commands are safety-checked by Claude before running; risky ones are blocked. Slightly slower and costs a bit more than auto.",
  },
  auto: {
    label: "Auto",
    icon: FastForwardIcon,
    description: "Autonomous — no command safety check.",
  },
};

// Display order: most → least oversight.
const LADDER: PermissionMode[] = ["plan", "guarded", "auto"];

/**
 * Whether the effective model can run guarded mode. Guarded needs Sonnet or
 * Opus; Haiku is unsupported. The runtime init-field check is the backstop if a
 * model turns out unsupported despite this gate.
 *
 * docs/260 — exported because the composer's settings menu offers the same
 * choice below 700px of composer width, and a second copy of the rule would
 * drift into offering a mode the server then refuses.
 */
export function isGuardedModelOk({
  agents,
  activeAgentId,
  modelInfo,
}: {
  agents: AgentOption[];
  activeAgentId: AgentId;
  modelInfo?: ModelInfo | null;
}): boolean {
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const effectiveAlias =
    (modelInfo?.model ? resolveModelAlias(modelInfo.model) : undefined) ??
    getSavedModelId() ??
    activeAgent?.models[0];
  return effectiveAlias !== "haiku";
}

/** docs/285 — everything the Network section needs, or `undefined` to omit it. */
export interface NetworkSectionProps {
  mode: NetworkMode;
  onChange: (mode: NetworkMode) => void;
  /** The workspace default, so `Inherit` can name what it currently inherits. */
  globalEnabled: boolean;
  enforcementStatus: EgressEnforcementStatus;
  /**
   * The server's verdict that the LIVE container was started in a different
   * containment than the selection resolves to. Read rather than re-derived:
   * "the topology is fixed at creation" is not the same as "this change alters
   * it", and the client cannot see what the container actually booted with.
   */
  pendingRestart: boolean;
  /**
   * No turn has run yet, so the choice is still free — it will be in force from
   * the first one. Drives which of the two footers is shown; they say opposite
   * things and both are true at their own moment.
   */
  beforeFirstTurn: boolean;
  /**
   * req 10 — whether `globalEnabled` has actually been read from the server.
   *
   * False means the workspace default is genuinely unknown, and the control says
   * so rather than printing its optimistic placeholder as fact. Naming the wrong
   * inherited value is worse than naming none: the user reads it, believes their
   * session is contained, and sends.
   */
  loaded: boolean;
}

export function PermissionModeSelector({
  mode,
  onChange,
  agents,
  activeAgentId,
  modelInfo,
  disabled = false,
  network,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  agents: AgentOption[];
  activeAgentId: AgentId;
  modelInfo?: ModelInfo | null;
  /**
   * docs/257 req 3 — the composer is dead as a whole (no runnable service), so
   * there is no turn for a permission mode to govern. The control stays visible
   * (it still reports the mode a future turn will run under) but does not open.
   */
  disabled?: boolean;
  /**
   * docs/285 — the Network section. Omitted for a sandbox session, whose network
   * access IS one of its capability grants (docs/211, docs/279): offering this
   * as well would put two controls over one session's egress.
   */
  network?: NetworkSectionProps;
}) {
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const supported = activeAgent?.supportedPermissionModes ?? [];

  // Build the offered set: always include `auto` (every agent runs it), plus
  // any other modes the agent advertises. Ordered along the oversight ladder.
  const available = LADDER.filter((m) => m === "auto" || supported.includes(m));

  const guardedModelOk = isGuardedModelOk({ agents, activeAgentId, modelInfo });

  // A harness with one permission mode (Codex) has nothing to toggle there —
  // but docs/285 gave this control a second job, so it now renders the network
  // section alone rather than disappearing and taking that job with it.
  const showModes = available.length > 1;
  if (!showModes && !network) return null;

  // The mode we actually display as active. If the stored mode isn't currently
  // offered (agent/model changed out from under it), fall back to auto.
  const displayMode: PermissionMode = available.includes(mode) ? mode : "auto";
  const Meta = MODE_META[displayMode];
  const modeIsDefault = displayMode === "auto";

  const networkIsDefault = !network || network.mode === "inherit";
  // req 10 — an unread workspace default cannot decide that this session is
  // contained, so `Inherit` warns about nothing until the value is known. An
  // explicit pick needs no default and is unaffected.
  const contained = network && (network.mode !== "inherit" || network.loaded)
    ? resolvesToContained(network.mode, network.globalEnabled)
    : false;
  const warning = network && contained ? enforcementWarning(network.enforcementStatus) : null;

  // The trigger is worded only when something is NOT at its default; otherwise
  // it stays the bare icon it has always been. Network wins the label when both
  // are non-default: the mode has three states the user changes routinely, while
  // an explicit network pick is the rare, consequential one.
  const triggerLabel = !networkIsDefault
    ? NETWORK_MODE_LABEL[network.mode]
    : modeIsDefault
      ? null
      : Meta.label;
  const TriggerIcon = !networkIsDefault
    ? (network.mode === "open" ? GlobeIcon : GlobeXIcon)
    : Meta.icon;
  const highlighted = !modeIsDefault || !networkIsDefault;

  // req 10 — the COMMON state has to be readable too, and there is no hover on
  // touch, so the effective values are stated in the accessible name rather than
  // left to a tint the prototype's worded case demonstrates and the default case
  // never shows. An explicit pick says it OVERRIDES the workspace: that the
  // choice is pinned is the part req 10 asks to be stated, and it is exactly
  // what a colour cannot carry.
  const networkSummary = network
    ? networkIsDefault
      ? network.loaded
        ? `Network: inheriting the workspace setting (currently ${network.globalEnabled ? "Contained" : "Open"})`
        : "Network: inheriting the workspace setting"
      : `Network: ${NETWORK_MODE_LABEL[network.mode]}, overriding the workspace setting`
    : null;
  const accessibleName = [
    showModes ? `Permission mode: ${Meta.label}` : null,
    networkSummary,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <DropdownMenu>
      <WithTooltip label={accessibleName}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={accessibleName}
            title={accessibleName}
            disabled={disabled}
            className={`flex items-center gap-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${INSET_FOCUS_RING} ${
              highlighted
                ? "px-1.5 py-1.5 bg-(--color-accent)/15 text-(--color-accent) hover:bg-(--color-accent)/25"
                : "p-1.5 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
            }`}
            data-testid="permission-mode-selector"
          >
            <TriggerIcon size={ICON_SIZE.SM} weight={highlighted ? "fill" : "regular"} />
            {triggerLabel && <span className="text-xs font-medium">{triggerLabel}</span>}
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent side="top" align="start" className="w-80" data-testid="permission-mode-menu">
        {showModes && (
          <>
            <SectionHeader>Permission mode</SectionHeader>
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
                      <span className="text-sm font-medium">{meta.label} mode</span>
                      {isCurrent && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-accent)" />}
                    </div>
                    <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                      {guardedDisabled ? "Guarded mode needs a Sonnet or Opus model." : meta.description}
                    </p>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </>
        )}

        {showModes && network && <DropdownMenuSeparator />}

        {network && (
          <>
            <SectionHeader>Network access</SectionHeader>
            {(["inherit", "contained", "open"] as const).map((m) => {
              const isCurrent = m === network.mode;
              const Icon = m === "open" ? GlobeIcon : m === "contained" ? GlobeXIcon : GlobeIcon;
              return (
                <DropdownMenuItem
                  key={m}
                  onSelect={() => network.onChange(m)}
                  className="flex items-start gap-2 px-3 py-2"
                  data-testid={`network-mode-option-${m}`}
                >
                  <Icon size={ICON_SIZE.SM} className="mt-0.5 shrink-0" weight={isCurrent ? "fill" : "regular"} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium">{NETWORK_MODE_LABEL[m]}</span>
                      {isCurrent && <CheckIcon size={ICON_SIZE.XS} className="text-(--color-accent)" />}
                    </div>
                    <p className="text-xs text-(--color-text-tertiary) mt-0.5">
                      {m === "inherit"
                        // req 10 — name the value being inherited, and do NOT
                        // present it as pinned: `Inherit` resolves when the
                        // container starts, so it follows a workspace change
                        // made in between. That is what the word means (req 3).
                        ? network.loaded
                          ? `Follow the workspace setting — currently ${network.globalEnabled ? "Contained" : "Open"}.`
                          : "Follow the workspace setting."
                        : m === "contained"
                          ? "Deny by default; only allowlisted hosts are reachable."
                          : "Unrestricted outbound network access."}
                    </p>
                  </div>
                </DropdownMenuItem>
              );
            })}

            {warning && (
              <p
                className="mx-3 mt-1 mb-2 flex items-start gap-1.5 rounded-md bg-(--color-warning-subtle) px-2 py-1.5 text-xs text-(--color-warning)"
                data-testid="network-enforcement-warning"
              >
                <WarningIcon size={ICON_SIZE.XS} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
              </p>
            )}

            {/* The menu STATES; it does not act. Two footers, and which one is
                true depends on whether a turn has run. */}
            {network.beforeFirstTurn ? (
              <p
                className="px-3 pt-1 pb-2 text-xs text-(--color-text-tertiary)"
                data-testid="network-mode-first-turn-note"
              >
                In force from this session&rsquo;s first turn. Setup that has already run
                may have used the workspace setting.
              </p>
            ) : (
              network.pendingRestart && (
                <p
                  className="px-3 pt-1 pb-2 text-xs text-(--color-text-tertiary)"
                  data-testid="network-mode-pending-note"
                >
                  Applies on the next container start — restart from Session settings.
                </p>
              )
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A labelled group heading inside the flat menu. */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)">
      {children}
    </div>
  );
}
