// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown listener for ?/toggle with cleanup (browser API subscription)
import { useEffect } from "react";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";
import { useSettingsStore } from "../stores/settings-store.js";
import {
  KEYBINDINGS,
  chordToKeys,
  eventMatchesChord,
  type KeybindingDef,
  type KeybindingGroup,
} from "../keybindings/registry.js";

const GROUP_ORDER: KeybindingGroup[] = ["General", "Sessions", "Chat", "Search", "Voice"];

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && <span className="text-(--color-text-secondary) mx-0.5">+</span>}
          <kbd className="inline-block min-w-[1.5rem] text-center px-1.5 py-0.5 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-primary)">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsOverlay({ onClose, onEdit }: { onClose: () => void; onEdit?: () => void }) {
  // Read overrides so the displayed chords reflect any customizations live.
  const keybindings = useSettingsStore((s) => s.keybindings);

  const displayKeys = (def: KeybindingDef): string[] => {
    if (!def.editable) return def.fixedHint ? [def.fixedHint] : [];
    return chordToKeys(keybindings[def.id] ?? def.defaultBinding);
  };

  // The shared Dialog handles Escape, the backdrop, the close button, and the
  // Back button. This listener only adds the two app-specific toggles: "?" and
  // the (rebindable) toggle-shortcuts chord both close the open overlay.
  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggle = keybindings["toggle-shortcuts"] ?? "mod+/";
      if (e.key === "?" || eventMatchesChord(e, toggle)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, keybindings]);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    defs: KEYBINDINGS.filter((d) => d.group === group),
  })).filter((g) => g.defs.length > 0);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg w-full md:mx-4 md:max-h-[85vh] overflow-y-auto p-6 space-y-5">
        {/* pr leaves room for the dialog's corner close button */}
        <div className="flex items-center justify-between pr-10">
          <DialogTitle className="text-lg font-semibold text-(--color-text-primary)">
            Keyboard Shortcuts
          </DialogTitle>
          {onEdit && (
            <Button variant="secondary" size="md" onClick={onEdit} className="gap-1.5">
              <PencilSimpleIcon size={ICON_SIZE.SM} />
              Edit
            </Button>
          )}
        </div>

        {groups.map(({ group, defs }) => (
          <div key={group} className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-(--color-text-secondary)">
              {group}
            </h3>
            <div className="space-y-1">
              {defs.map((def) => (
                <div
                  key={def.id}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-(--color-bg-hover)"
                >
                  <span className="text-sm text-(--color-text-primary)">{def.label}</span>
                  <KeyCombo keys={displayKeys(def)} />
                </div>
              ))}
            </div>
          </div>
        ))}

        <p className="text-xs text-(--color-text-tertiary) text-center pt-2 border-t border-(--color-border-primary)">
          Customize these in <span className="text-(--color-text-secondary)">Settings → Keyboard</span>
        </p>
      </DialogContent>
    </Dialog>
  );
}
