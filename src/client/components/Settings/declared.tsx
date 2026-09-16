/**
 * The dialog's standard controls, rendered from the declarations
 * (docs/299-agent-settings-access req 7, plan.md → Settings are declared once).
 *
 * A toggle, an enum, a number or a text box takes its label and its help text
 * from `ALL_SETTINGS` and carries none of its own. That is the whole of req 7's
 * last sentence: the description the agent reads is the description the user
 * reads, because there is only one of them.
 *
 * Each control also carries its {@link bindSetting} binding, as does every
 * bespoke control elsewhere in the two dialogs — see `setting-binding.ts` for
 * why that is an attribute of its own rather than a test id, and
 * `settings-coverage.test.tsx` for what reads it.
 */

import type { ReactNode } from "react";
import type { SettingKey } from "../../../server/shared/settings-catalogue/index.js";
import { ToggleSwitch } from "./ToggleSwitch.js";
import { inputClass } from "./shared.js";
import { bindSetting, bindSettingOption, settingCopy, settingOptions, type DeclaredOption } from "./setting-binding.js";
import { useDeclaredBoolean, type DeclaredBooleanKey } from "./declared-setting.js";

export { saveSetting, useSetting, useDeclaredBoolean, type DeclaredBooleanKey } from "./declared-setting.js";

export {
  SETTING_ATTR,
  SETTING_OPTION_ATTR,
  bindSetting,
  bindSettingOption,
  settingCopy,
  settingOf,
  settingOptions,
  type DeclaredOption,
  type SettingBinding,
} from "./setting-binding.js";

/**
 * The label and help text, marked so the coverage walk can compare them against
 * the declaration. A control that wrote its own words would fail that
 * comparison, which is the defect this slice exists to make impossible.
 */
export function SettingCopy({
  settingKey,
  heading,
  detail,
}: {
  settingKey: SettingKey;
  /** A section that *is* one setting gets a heading; a row gets a plain label. */
  heading?: boolean;
  /** Derived status beneath the description — never copy. */
  detail?: ReactNode;
}) {
  const { label, description } = settingCopy(settingKey);
  return (
    <div className="min-w-0">
      {heading ? (
        <h3
          className="text-sm font-medium text-(--color-text-primary)"
          data-setting-label={settingKey}
        >
          {label}
        </h3>
      ) : (
        <span className="text-sm text-(--color-text-primary)" data-setting-label={settingKey}>
          {label}
        </span>
      )}
      <p className="text-xs text-(--color-text-tertiary)" data-setting-description={settingKey}>
        {description}
      </p>
      {detail}
    </div>
  );
}

interface ToggleChrome {
  testId?: string;
  detail?: ReactNode;
  /** A section that *is* one toggle keeps its heading. */
  heading?: boolean;
}

interface ToggleWiring {
  enabled: boolean;
  onToggle: (value: boolean) => void;
}

function ToggleRow({
  settingKey,
  enabled,
  onToggle,
  testId,
  detail,
  heading,
}: { settingKey: SettingKey } & ToggleWiring & ToggleChrome) {
  const { label } = settingCopy(settingKey);
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <SettingCopy
        settingKey={settingKey}
        {...(heading ? { heading } : {})}
        {...(detail ? { detail } : {})}
      />
      <ToggleSwitch
        enabled={enabled}
        onToggle={onToggle}
        label={label}
        settingKey={settingKey}
        {...(testId ? { testId } : {})}
      />
    </div>
  );
}

/** Its own component, so the hook is unconditional on the branch that uses it. */
function DerivedToggle({
  settingKey,
  ...chrome
}: { settingKey: DeclaredBooleanKey } & ToggleChrome) {
  const { value, set } = useDeclaredBoolean(settingKey);
  return <ToggleRow settingKey={settingKey} enabled={value} onToggle={set} {...chrome} />;
}

/**
 * A boolean setting: the declared words on the left, the switch on the right.
 *
 * **The wiring is optional, and omitting it is the point** (req 7). A declared
 * global boolean reads and writes itself — the store field, the
 * `PUT /api/settings` payload, the rollback and the toast all come from the
 * declaration (`declared-setting.ts`), so a new one costs a declaration and this
 * tag. The two props stay for a value the browser store owns, and for a control
 * whose write is not a settings save at all. A key that is neither derivable nor
 * given them is a compile error naming the setting.
 */
export function DeclaredToggle(
  props:
    | ({ settingKey: DeclaredBooleanKey } & Partial<ToggleWiring> & ToggleChrome)
    | ({ settingKey: SettingKey } & ToggleWiring & ToggleChrome),
) {
  const { settingKey, enabled, onToggle, ...chrome } = props;
  if (enabled === undefined || onToggle === undefined) {
    return <DerivedToggle settingKey={settingKey as DeclaredBooleanKey} {...chrome} />;
  }
  return (
    <ToggleRow settingKey={settingKey} enabled={enabled} onToggle={onToggle} {...chrome} />
  );
}

/**
 * An enum setting as a `<select>`.
 *
 * `options` is supplied only where the choices are not the declared ones — a
 * provider's voices, the dozen dictation languages — because those are values
 * the install produces rather than copy anyone writes.
 */
export function DeclaredSelect({
  settingKey,
  id,
  value,
  onChange,
  options,
  testId,
  width = "w-56",
}: {
  settingKey: SettingKey;
  id: string;
  value: string;
  onChange: (value: string) => void;
  options?: readonly DeclaredOption[];
  testId?: string;
  width?: string;
}) {
  const { label, description } = settingCopy(settingKey);
  const rendered = options ?? settingOptions(settingKey);
  return (
    <div className="space-y-1.5">
      <label
        className="block text-sm text-(--color-text-primary)"
        htmlFor={id}
        data-setting-label={settingKey}
      >
        {label}
      </label>
      <p className="text-xs text-(--color-text-tertiary)" data-setting-description={settingKey}>
        {description}
      </p>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${width} ${inputClass}`}
        {...bindSetting(settingKey)}
        {...(testId ? { "data-testid": testId } : {})}
      >
        {rendered.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * An enum setting as a row of cards — one per option, each carrying that
 * option's own declared description. The release channel is the case: two
 * choices whose consequences need a sentence each.
 */
export function DeclaredEnumCards({
  settingKey,
  value,
  onChange,
  disabled,
  testIdPrefix,
}: {
  settingKey: SettingKey;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Omitted by a generated row, whose options are found by their declared labels. */
  testIdPrefix?: string;
}) {
  const { label, description } = settingCopy(settingKey);
  return (
    <div className="space-y-1.5">
      <span
        className="block text-xs font-medium text-(--color-text-secondary)"
        data-setting-label={settingKey}
      >
        {label}
      </span>
      <p className="text-xs text-(--color-text-tertiary)" data-setting-description={settingKey}>
        {description}
      </p>
      <div className="flex gap-2" role="group" aria-label={label}>
        {settingOptions(settingKey).map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              aria-label={option.label}
              {...(testIdPrefix ? { "data-testid": `${testIdPrefix}-${option.value}` } : {})}
              {...bindSettingOption(settingKey, option.value)}
              onClick={() => onChange(option.value)}
              className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                active
                  ? "border-(--color-accent) bg-(--color-accent-subtle)"
                  : "border-(--color-border-secondary) hover:border-(--color-border-primary)"
              }`}
            >
              <span className="block text-sm font-medium text-(--color-text-primary)">
                {option.label}
              </span>
              <span className="block text-xs text-(--color-text-tertiary)">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A free-text setting as a `<textarea>`. */
export function DeclaredTextarea({
  settingKey,
  value,
  onChange,
  className,
}: {
  settingKey: SettingKey;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { label, description } = settingCopy(settingKey);
  return (
    <>
      <div>
        <h3
          className="text-sm font-medium text-(--color-text-primary) mb-1"
          data-setting-label={settingKey}
        >
          {label}
        </h3>
        <p
          className="text-xs text-(--color-text-secondary) mb-2"
          data-setting-description={settingKey}
        >
          {description}
        </p>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        {...(className ? { className } : {})}
        {...bindSetting(settingKey)}
      />
    </>
  );
}
