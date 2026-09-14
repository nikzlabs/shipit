import { bindSetting } from "./setting-binding.js";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";

export function ToggleSwitch({
  enabled,
  onToggle,
  testId,
  label,
  settingKey,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  testId?: string;
  label?: string;
  /** The declaration this switch is the control for (docs/299 req 7). */
  settingKey?: SettingKey;
}) {
  return (
    <button
      onClick={() => onToggle(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-(--color-accent)" : "bg-(--color-bg-hover)"
      }`}
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      data-testid={testId}
      {...(settingKey ? bindSetting(settingKey) : {})}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
