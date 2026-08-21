import { useCallback, useState } from "react";
import { BrainIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { getSavedReasoning, saveReasoning } from "../utils/local-storage.js";
import { Picker, PickerOption } from "./pickers/Picker.js";
import { useBoundModelSelection } from "./ModelPicker.js";
import { reasoningOptionsFor } from "../../server/shared/catalogue/index.js";
import type { AgentOption } from "../agent-types.js";
import type { AgentId } from "../../server/shared/types.js";

/**
 * The reasoning choice as both this control and docs/260's composer settings
 * menu render it. Extracted so the menu's Reasoning panel shares one precedence
 * rule (and one `saveReasoning` side effect) with the standalone selector.
 *
 * Returns `null` when the agent exposes no reasoning knob, which is the caller's
 * signal to render nothing.
 */
export function useReasoningPickerState({
  agent,
  sessionReasoning,
  onChange,
  seedFromHistory = false,
}: {
  agent: AgentOption | undefined;
  sessionReasoning: string | undefined;
  onChange: (effort: string | null) => void;
  seedFromHistory?: boolean;
}) {
  const [pending, setPending] = useState<string | null | undefined>(undefined);

  const select = useCallback(
    (effort: string | null) => {
      if (!agent) return;
      setPending(effort);
      saveReasoning(agent.id, effort);
      onChange(effort);
    },
    [agent, onChange],
  );

  // docs/274 req 14 — the levels THIS SELECTION honours, never the harness's raw
  // vocabulary. The two diverge for grok, which declares four levels and sends
  // them only under a subscription, so reading `reasoning.options` here would
  // put four controls on screen that change nothing on a key-billed session.
  // The selection is derived from the same session and seed the model picker
  // beside this one reads, so the two controls cannot describe different rows.
  const selection = useBoundModelSelection(seedFromHistory);
  const reasoning = agent?.reasoning;
  const options = agent ? reasoningOptionsFor(agent.id as AgentId, selection) : [];
  if (!agent || !reasoning || options.length === 0) return null;

  // `pending` (incl. an explicit null = "Default just picked") wins until cleared;
  // otherwise the per-session value. The per-agent seed is consulted only when
  // composing a brand-new session (`seedFromHistory`). `undefined` ⇒ Default.
  const current =
    pending !== undefined
      ? pending ?? undefined
      : sessionReasoning ?? (seedFromHistory ? getSavedReasoning(agent.id) : undefined);

  return {
    /** The agent's own name for the knob ("Reasoning", "Reasoning effort"). */
    label: reasoning.label,
    /** "Default" plus the levels this selection honours, in catalogue order. */
    options: [{ value: null as string | null, label: "Default" }, ...options],
    current,
    currentLabel: options.find((o) => o.value === current)?.label ?? "Default",
    select,
  };
}

/**
 * docs/217 — Control B: the composer's reasoning/effort control for the ACTIVE
 * session's own turns. Sits beside the model selector. The option set and label
 * are agent-defined (`agent.reasoning`); a "Default" entry maps to no value (the
 * CLI's native default). Hidden when the active agent exposes no reasoning knob.
 *
 * Reasoning is **per session**: the displayed value is the active session's own
 * persisted level (`sessionReasoning`), so switching to a previous session
 * restores *its* level rather than bleeding the level last picked elsewhere.
 *
 * Value precedence: an optimistic local pick (until the session row catches up) →
 * the server-persisted per-session value (`sessionReasoning`) → the per-agent
 * localStorage seed. The seed is consulted **only in the new-session composer**
 * (`seedFromHistory`, i.e. no active session yet): there it previews the level
 * the about-to-be-created session will inherit, which is how changing the level
 * carries forward to new sessions. For an active session the seed is *not* a
 * display fallback — a session genuinely at "Default" shows "Default". The
 * optimistic `pending` pick is reset across a session switch by keying this
 * component on the session id at the call site, so a "Max" picked in one session
 * can never linger into the next (both were the "forgot it was on Max" footgun).
 * The seed still drives new sessions and per-agent restore via `saveReasoning`
 * and the `?reasoning=` connect param (docs/217).
 *
 * docs/260 — the composer's WIDE row only. Below 700px of composer width the
 * reasoning knob moves into `ComposerSettingsMenu`, so the old icon-only
 * `compactTrigger` variant no longer has a width to exist at.
 *
 * docs/261 phase 6 (req 13) — the markup is now `Picker`, shared with Settings.
 * This control is the *reference*: the screenshot the requirement was written
 * against is this button beside the model one, so what moved into the shared
 * component is what was already here.
 */
export function ReasoningSelector({
  agent,
  sessionReasoning,
  onChange,
  disabled,
  seedFromHistory = false,
}: {
  agent: AgentOption | undefined;
  sessionReasoning: string | undefined;
  /** `null` clears the selection back to the agent's default. */
  onChange: (effort: string | null) => void;
  disabled?: boolean;
  /**
   * When true (new-session composer — no active session), fall back to the
   * per-agent localStorage seed so the picker previews the level the new session
   * will inherit. False for an active session, whose own value is authoritative.
   */
  seedFromHistory?: boolean;
}) {
  const state = useReasoningPickerState({ agent, sessionReasoning, onChange, seedFromHistory });
  if (!state) return null;
  const { label, options, current, currentLabel, select: handleSelect } = state;

  return (
    <div data-testid="reasoning-selector">
      <Picker
        label={currentLabel}
        icon={<BrainIcon size={ICON_SIZE.XS} className="text-(--color-text-tertiary)" />}
        ariaLabel={`${label} selector`}
        title={`${label}: ${currentLabel}`}
        triggerTestId="reasoning-trigger"
        menuTestId="reasoning-dropdown"
        menuLabel={label}
        menuWidth="w-44"
        side="top"
        align="end"
        disabled={disabled}
      >
        {options.map((opt) => (
          <PickerOption
            key={opt.value ?? "__default__"}
            label={opt.label}
            selected={(opt.value ?? undefined) === (current ?? undefined)}
            onSelect={() => handleSelect(opt.value)}
            testId={`reasoning-option-${opt.value ?? "default"}`}
            indent
          />
        ))}
      </Picker>
    </div>
  );
}
