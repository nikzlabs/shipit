import { useState } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { useSettingsStore } from "../stores/settings-store.js";
import {
  KEYBINDINGS,
  getKeybindingDef,
  isValidChord,
  normalizeChord,
  type KeybindingDef,
  type KeybindingGroup,
} from "../keybindings/registry.js";
import { KeybindingCapture } from "./KeybindingCapture.js";

const GROUP_ORDER: KeybindingGroup[] = ["General", "Sessions", "Chat", "Search", "Voice"];

function invalidMessage(def: KeybindingDef): string {
  return def.requiresSecondModifier
    ? "Use Ctrl/Cmd plus Alt or Shift, for example Ctrl+Shift+Space."
    : "Use Ctrl/Cmd plus a key, for example Ctrl+/.";
}

function FixedRow({ def }: { def: KeybindingDef }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-(--color-text-primary)">{def.label}</span>
      <kbd className="inline-block px-2 py-1 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-secondary)">
        {def.fixedHint}
      </kbd>
    </div>
  );
}

export function KeybindingSettings() {
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setKeybinding = useSettingsStore((s) => s.setKeybinding);
  const resetKeybinding = useSettingsStore((s) => s.resetKeybinding);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const resolve = (def: KeybindingDef): string => keybindings[def.id] ?? def.defaultBinding;

  // Conflict map: a normalized chord shared by >1 editable binding is a clash.
  const counts = new Map<string, number>();
  for (const def of KEYBINDINGS) {
    if (!def.editable) continue;
    const c = normalizeChord(resolve(def));
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const isConflicting = (def: KeybindingDef) => (counts.get(normalizeChord(resolve(def))) ?? 0) > 1;

  const handleCapture = (def: KeybindingDef, chord: string) => {
    if (!isValidChord(chord, def.requiresSecondModifier)) {
      setErrors((e) => ({ ...e, [def.id]: invalidMessage(def) }));
      return;
    }
    setErrors((e) => {
      const next = { ...e };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by keybinding id
      delete next[def.id];
      return next;
    });
    setKeybinding(def.id, chord);
  };

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    defs: KEYBINDINGS.filter((d) => d.group === group),
  })).filter((g) => g.defs.length > 0);

  return (
    <div className="px-5 py-4 flex flex-col gap-6 overflow-y-auto h-full">
      <p className="text-sm text-(--color-text-secondary)">
        Customize keyboard shortcuts. Click <span className="text-(--color-text-primary)">Change</span> and press the
        keys you want. Editor keys like Enter and Esc are fixed.
      </p>

      {grouped.map(({ group, defs }) => (
        <div key={group} className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wider text-(--color-text-secondary)">{group}</h3>
          <div className="divide-y divide-(--color-border-primary)">
            {defs.map((def) =>
              def.editable ? (
                <div key={def.id} className="py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-(--color-text-primary)">{def.label}</span>
                    <div className="flex items-center gap-1.5">
                      <KeybindingCapture
                        value={resolve(def)}
                        onCapture={(chord) => handleCapture(def, chord)}
                        invalid={!!errors[def.id] || isConflicting(def)}
                      />
                      {keybindings[def.id] !== undefined && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Reset ${def.label} to default`}
                          title={`Reset to ${getKeybindingDef(def.id).defaultBinding}`}
                          onClick={() => {
                            setErrors((e) => {
                              const next = { ...e };
                              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by keybinding id
                              delete next[def.id];
                              return next;
                            });
                            resetKeybinding(def.id);
                          }}
                        >
                          <ArrowCounterClockwiseIcon size={ICON_SIZE.SM} />
                        </Button>
                      )}
                    </div>
                  </div>
                  {errors[def.id] ? (
                    <p className="text-xs text-(--color-error)">{errors[def.id]}</p>
                  ) : isConflicting(def) ? (
                    <p className="text-xs text-(--color-error)">This shortcut conflicts with another binding.</p>
                  ) : null}
                </div>
              ) : (
                <FixedRow key={def.id} def={def} />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
