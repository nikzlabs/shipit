/**
 * The memory budget: stored in MB, shown in GB, saved on a button
 * (docs/308-data-driven-settings req 3, inventory.md P4).
 *
 * The first setting with a `component`. It is one because of the unit and the
 * explicit commit, and neither is worth a field on the value type for a single
 * setting — so what is custom here is the control, and nothing else: the words
 * are the declaration's, and the value goes to the store the declaration names,
 * through the same writer every generated row uses.
 */

import { useRef, useState } from "react";
import { Button } from "../../ui/button.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { SettingCopy } from "../declared.js";
import { useSetting } from "../declared-setting.js";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";

const MB_PER_GB = 1024;

function toGb(mb: number | null): string {
  return mb === null ? "" : String(Math.round((mb / MB_PER_GB) * 10) / 10);
}

export function MemoryBudget({ settingKey }: { settingKey: SettingKey }) {
  const { value, set } = useSetting(settingKey);
  const storedMb = typeof value === "number" ? value : null;
  const [draftGb, setDraftGb] = useState(() => toGb(storedMb));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Typed since the write in flight was sent, so its "Saved" is not this box's. */
  const editedSinceSend = useRef(false);

  // docs/284 req 13 — the default differs by deployment, so the field cannot
  // show it as its own value; what the install is actually following is said
  // beneath the description instead.
  const dockerMemory = useUiStore((s) => s.dockerMemory);
  const effectiveGb = storedMb === null && dockerMemory?.budgetBytes
    ? Math.round((dockerMemory.budgetBytes / 1024 ** 3) * 10) / 10
    : null;

  // "Saved" is the server's answer rather than the click's, and it is about the
  // value that was SENT: a refusal rolls the record back while this box keeps
  // what was typed, so the button is the only thing that can report either.
  const save = async () => {
    const gb = Number(draftGb);
    editedSinceSend.current = false;
    setSaving(true);
    const stored = await set(draftGb.trim() === "" || !(gb > 0) ? null : Math.round(gb * MB_PER_GB));
    setSaving(false);
    setSaved(stored && !editedSinceSend.current);
  };

  return (
    <div className="space-y-3">
      <SettingCopy
        settingKey={settingKey}
        heading
        detail={
          effectiveGb ? (
            <p className="mt-1 text-xs text-(--color-text-tertiary)" data-testid="settings-memory-budget-effective">
              Currently following the install default of {effectiveGb} GB.
            </p>
          ) : undefined
        }
      />
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={0}
          step={0.5}
          placeholder="whole machine"
          aria-label="Memory budget"
          value={draftGb}
          onChange={(e) => {
            setDraftGb(e.target.value);
            setSaved(false);
            editedSinceSend.current = true;
          }}
          className="w-36 rounded-lg bg-(--color-bg-secondary) border border-(--color-border-secondary) px-3 py-2 text-sm text-(--color-text-primary) focus:outline-none focus:border-(--color-border-focus)"
          data-testid="settings-memory-budget"
        />
        <span className="text-sm text-(--color-text-secondary)">GB</span>
        <Button
          variant="primary"
          size="md"
          disabled={saving}
          aria-label={saving ? "Saving memory budget" : saved ? "Memory budget saved" : "Save memory budget"}
          onClick={() => { void save(); }}
          className="rounded-md"
          data-testid="settings-memory-budget-save"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </Button>
      </div>
    </div>
  );
}
