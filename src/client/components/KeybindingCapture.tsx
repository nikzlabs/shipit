// eslint-disable-next-line no-restricted-imports -- useEffect: window keydown capture with cleanup while recording
import { useEffect, useState } from "react";
import { ICON_SIZE } from "../design-tokens.js";
import { KeyboardIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { chordFromEvent, chordToKeys } from "../keybindings/registry.js";

function KeyTokens({ chord }: { chord: string }) {
  const keys = chordToKeys(chord);
  if (keys.length === 0) return <span className="text-(--color-text-tertiary) text-sm">Not set</span>;
  return (
    <span className="flex items-center gap-1">
      {keys.map((key, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="text-(--color-text-secondary) mx-0.5">+</span>}
          <kbd className="inline-block min-w-[1.5rem] text-center px-1.5 py-0.5 text-xs font-mono rounded bg-(--color-bg-tertiary) border border-(--color-border-secondary) text-(--color-text-primary)">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * Press-keys capture field for a single keybinding (docs/180). Clicking
 * "Change" arms a one-shot global keydown listener; the next non-modifier key
 * (plus any modifiers held) becomes the new chord, normalized via
 * `chordFromEvent`. Esc cancels recording without changing anything.
 */
export function KeybindingCapture({
  value,
  onCapture,
  invalid,
}: {
  value: string;
  onCapture: (chord: string) => void;
  invalid?: boolean;
}) {
  const [recording, setRecording] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- one-shot global capture while recording, cleaned up on stop
  useEffect(() => {
    if (!recording) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // modifier-only press — keep waiting
      onCapture(chord);
      setRecording(false);
    };
    // Capture phase so we intercept before app-level shortcut handlers fire.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recording, onCapture]);

  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-9 min-w-[10rem] items-center gap-2 rounded-md border px-3 ${
          recording
            ? "border-(--color-border-focus) bg-(--color-bg-tertiary)"
            : invalid
              ? "border-(--color-error) bg-(--color-bg-tertiary)"
              : "border-(--color-border-secondary) bg-(--color-bg-tertiary)"
        }`}
      >
        {recording ? (
          <span className="flex items-center gap-1.5 text-sm text-(--color-text-secondary)">
            <KeyboardIcon size={ICON_SIZE.SM} weight="fill" className="text-(--color-accent)" />
            Press keys…
          </span>
        ) : (
          <KeyTokens chord={value} />
        )}
      </div>
      <Button variant="secondary" size="sm" onClick={() => setRecording((r) => !r)}>
        {recording ? "Cancel" : "Change"}
      </Button>
    </div>
  );
}
