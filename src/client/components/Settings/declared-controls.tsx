/**
 * The control each value kind gets (docs/308-data-driven-settings plan.md →
 * The renderer).
 *
 * Every one of them receives a `SettingKey` and nothing else: the words are the
 * declaration's, the value is read and written through the shared hooks, and a
 * refusal is the value type's own `validate()` message rather than a second
 * phrasing written beside the control (inventory.md P8).
 *
 * A kind absent from {@link CONTROLS} has no generated row, which is how a slice
 * converts the settings it supports and leaves the rest hand-written rather than
 * rendering a row that cannot save (P18). `setting-values.ts` holds the same
 * rule on the reader's side, and `DeclaredSettings.test.tsx` fails if the two
 * disagree.
 */

import type { ReactNode } from "react";
import type {
  SettingKey,
  SettingValueKind,
} from "../../../server/shared/settings-catalogue/index.js";
import { useSetting, useSettingDraft } from "./declared-setting.js";
import {
  DeclaredEnumCards,
  DeclaredSelect,
  DeclaredTextarea,
  DeclaredToggle,
  SettingCopy,
} from "./declared.js";
import { settingOf, settingOptions } from "./setting-copy.js";
import { inputClass } from "./shared.js";

function GeneratedToggle({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  return <DeclaredToggle settingKey={settingKey} enabled={value === true} onToggle={set} />;
}

/**
 * A choice: a row of cards, or a `<select>`.
 *
 * **What decides it is already in the declaration** (req 5): a card exists to
 * carry an option's own sentence, so an option set that declares descriptions
 * gets cards and one that does not gets a select. The release channel is the
 * first — two choices whose consequences need a sentence each — and the voice
 * enums are the second: a dozen dictation languages and two provider lists the
 * install produces, none of which has anything to put on a card. VS Code makes
 * every enum a dropdown and hangs `enumDescriptions` beside it (req 6); the
 * cards are the one place we spend more room than that, and only where there is
 * something to spend it on.
 */
function GeneratedEnum({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  const selected = typeof value === "string" ? value : "";
  const options = settingOptions(settingKey);
  if (options.length > 0 && options.every((option) => option.description)) {
    return <DeclaredEnumCards settingKey={settingKey} value={selected} onChange={set} />;
  }
  return (
    <DeclaredSelect
      settingKey={settingKey}
      id={`setting-${settingKey}`}
      value={selected}
      onChange={set}
    />
  );
}

/** The stored value moved while this box was being edited (inventory.md P14). */
function ChangedElsewhere({ settingKey }: { settingKey: SettingKey }) {
  return (
    <p
      className="rounded-md border border-(--color-border-secondary) bg-(--color-bg-secondary) px-3 py-2 text-xs text-(--color-text-secondary)"
      data-testid={`setting-changed-elsewhere-${settingKey}`}
    >
      This changed somewhere else while you were editing. Your edits are still here; saving
      replaces what is stored now.
    </p>
  );
}

/** The value type's own refusal, shown where the control is (inventory.md P8). */
function Refusal({ message }: { message: string }) {
  return <span className="text-xs text-(--color-error)">{message}</span>;
}

/**
 * Prose: a textarea, a count against the declared maximum, and the value type's
 * refusal when there is one.
 *
 * **The store is what makes it a textarea** — `system-prompt-file` is the only
 * one whose values are prose, which is why the design rejected a
 * `presentation: "multiline"` field for the same job. A `text` row over another
 * store has no control yet and so is not generated at all
 * (`setting-values.ts` → `hasControl`).
 */
function GeneratedTextarea({ settingKey }: { settingKey: SettingKey }) {
  const { value, changedElsewhere, set } = useSettingDraft(settingKey);
  const declaration = settingOf(settingKey);
  const text = typeof value === "string" ? value : "";
  const maxLength = declaration.type.shape.maxLength;
  const check = declaration.type.validate(text, declaration.label);
  return (
    <div className="space-y-2">
      {changedElsewhere && <ChangedElsewhere settingKey={settingKey} />}
      <DeclaredTextarea
        settingKey={settingKey}
        value={text}
        onChange={set}
        className="min-h-30 w-full bg-(--color-bg-secondary) border border-(--color-border-secondary) rounded-md px-3 py-2 text-sm text-(--color-text-primary) placeholder-(--color-text-tertiary) resize-y focus:outline-none focus:border-(--color-border-focus)"
      />
      <div className="flex items-start justify-between gap-4 text-xs text-(--color-text-secondary)">
        {check.ok ? <span /> : <Refusal message={check.message} />}
        {typeof maxLength === "number" && (
          <span className={check.ok ? "" : "text-(--color-error)"}>
            {text.length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

function identityOf(value: unknown): { name: string; email: string } {
  const row = value as Partial<{ name: string; email: string }> | null | undefined;
  return {
    name: typeof row?.name === "string" ? row.name : "",
    email: typeof row?.email === "string" ? row.email : "",
  };
}

/**
 * A name and an email, which are one setting because they are written together
 * (inventory.md P9, `value-types.ts` → `gitIdentity`).
 *
 * Two boxes over one declaration is what a composite value IS: they edit two
 * halves of one draft and are committed by one write.
 */
function GeneratedGitIdentity({ settingKey }: { settingKey: SettingKey }) {
  const { value, changedElsewhere, set } = useSettingDraft(settingKey);
  const declaration = settingOf(settingKey);
  const identity = identityOf(value);
  const check = declaration.type.validate(identity, declaration.label);
  const field = (part: "name" | "email", label: string, type: string) => (
    <div>
      <label
        className="block text-sm text-(--color-text-primary) mb-1"
        htmlFor={`git-identity-${part}`}
      >
        {label}
      </label>
      <input
        id={`git-identity-${part}`}
        type={type}
        value={identity[part]}
        onChange={(e) => { set({ ...identity, [part]: e.target.value }); }}
        className={inputClass}
      />
    </div>
  );
  return (
    <div className="space-y-3">
      <SettingCopy settingKey={settingKey} heading />
      {changedElsewhere && <ChangedElsewhere settingKey={settingKey} />}
      {field("name", "Name", "text")}
      {field("email", "Email", "email")}
      {!check.ok && <Refusal message={check.message} />}
    </div>
  );
}

interface Control {
  render: (key: SettingKey) => ReactNode;
  /**
   * The control holds a draft and is stored by the tab's Save rather than on
   * change (inventory.md P5), which is what tells the renderer to place one.
   */
  commitsOnButton?: true;
}

export const CONTROLS: Partial<Record<SettingValueKind, Control>> = {
  bool: { render: (key) => <GeneratedToggle settingKey={key} /> },
  enum: { render: (key) => <GeneratedEnum settingKey={key} /> },
  text: { render: (key) => <GeneratedTextarea settingKey={key} />, commitsOnButton: true },
  gitIdentity: {
    render: (key) => <GeneratedGitIdentity settingKey={key} />,
    commitsOnButton: true,
  },
};
