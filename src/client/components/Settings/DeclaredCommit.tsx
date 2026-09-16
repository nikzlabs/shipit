/**
 * The Save button of a tab whose rows commit on a button
 * (docs/308-data-driven-settings req 1, inventory.md P5).
 *
 * **It names a tab, never a setting.** One Save commits every edited row on the
 * tab in a single write, which is what the catalogue's `instructions.commit`
 * exclusion already says the two instruction boxes do — so the button belongs to
 * no declaration, and a third box added to the tab is committed by it with no
 * edit here. What it may commit it takes from the drafts; whether it may commit
 * at all it takes from each value type's own `validate()` (inventory.md P8), so
 * the bounds a control used to carry in JSX live in one place.
 */

import { useState } from "react";
import { Button } from "../ui/button.js";
import { useEventListener } from "../../hooks/useEventListener.js";
import type { SettingTab } from "../../../server/shared/settings-catalogue/index.js";
import { commitSettings, useTabDrafts } from "./declared-setting.js";

export function DeclaredCommit({ tab }: { tab: SettingTab }) {
  const pending = useTabDrafts(tab);
  const [saved, setSaved] = useState(false);
  const [writing, setWriting] = useState(false);
  const refused = pending.some(
    ({ declaration, value }) => !declaration.type.validate(value, declaration.label).ok,
  );
  /*
    Nothing edited is nothing to save. Disabled WHILE WRITING for a second
    reason: nothing sequences two commits of the same setting, so responses
    arriving out of order would leave the record on the older value with the
    server holding the newer, and the `settings_changed` refresh that would
    have corrected it has already run.
  */
  const disabled = writing || pending.length === 0 || refused;

  const commit = async () => {
    if (disabled) return;
    setWriting(true);
    try {
      if (await commitSettings(pending.map(({ key, value }) => [key, value]))) setSaved(true);
    } finally {
      setWriting(false);
    }
  };

  useEventListener(document, "keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void commit();
  });

  return (
    <Button
      variant="primary"
      size="md"
      onClick={() => { void commit(); }}
      disabled={disabled}
      className="rounded-md"
    >
      {saved && pending.length === 0 ? "Saved" : "Save"}
    </Button>
  );
}
