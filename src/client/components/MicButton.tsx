/**
 * Presentational mic button (docs/144).
 *
 * Renders the four voice-input states (idle / recording / transcribing /
 * error) and turns clicks into start/stop calls on the voice hook. It is
 * intentionally dumb: all recording state lives in `useVoiceInput`, and
 * the same component instance renders identically in MessageInput (Mode A)
 * and the quick-capture overlay (Mode B).
 *
 * Click is a toggle on both desktop and mobile (start → click again to
 * stop). On desktop the push-to-talk hotkey is the primary gesture; the
 * button is the mobile/no-keyboard path. Click-and-hold is deliberately
 * not supported (see plan "Gestures (resolved)").
 */

import { MicrophoneIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Spinner } from "./Spinner.js";
import { ICON_SIZE } from "../design-tokens.js";
import { WithTooltip } from "./ui/tooltip.js";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover.js";
import { VoiceErrorPanel } from "./VoiceErrorPanel.js";
import type { VoiceInputApi } from "../voice/use-voice-input.js";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MicButton({
  voice,
  hotkeyLabel,
  onOpenSettings,
  large = false,
}: {
  voice: VoiceInputApi;

  hotkeyLabel?: string;

  onOpenSettings?: () => void;

  large?: boolean;
}) {
  const { state, elapsedMs, errorMessage } = voice;

  const pad = large ? "p-3" : "p-1.5";
  const iconSize = large ? ICON_SIZE.MD : ICON_SIZE.SM;
  const floor = large ? "min-h-11 min-w-11" : "";

  const handleClick = () => {
    if (state === "recording") {
      voice.stopRecording();
    } else if (state === "error") {
      voice.dismissError();
    } else if (state === "idle") {
      voice.startRecording();
    }

  };

  if (state === "recording") {
    return (
      <WithTooltip label="Stop recording">
        <button
          onClick={handleClick}
          className={`flex items-center gap-1.5 shrink-0 rounded-lg px-2 py-1.5 ${floor} bg-(--color-error)/15 text-(--color-error) hover:bg-(--color-error)/25 transition-colors`}
          aria-label="Stop recording"
          data-testid="mic-button"
          data-state="recording"
        >
          <span className="relative flex items-center justify-center">
            <MicrophoneIcon size={iconSize} weight="fill" />
            <span className="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-(--color-error) animate-pulse" />
          </span>
          <span className="text-xs tabular-nums">{formatElapsed(elapsedMs)}</span>
        </button>
      </WithTooltip>
    );
  }

  if (state === "transcribing") {
    return (
      <WithTooltip label="Transcribing…">
        <button
          disabled
          className={`flex items-center justify-center shrink-0 rounded-lg ${pad} ${floor} text-(--color-text-tertiary) cursor-default`}
          aria-label="Transcribing"
          data-testid="mic-button"
          data-state="transcribing"
        >
          <Spinner size={iconSize} />
        </button>
      </WithTooltip>
    );
  }

  if (state === "error") {
    const errorButton = (
      <button
        onClick={handleClick}
        className={`flex items-center justify-center shrink-0 rounded-lg ${pad} ${floor} text-(--color-error) hover:bg-(--color-error)/15 transition-colors`}
        aria-label={errorMessage ?? "Voice error"}
        data-testid="mic-button"
        data-state="error"
      >
        <WarningCircleIcon size={iconSize} weight="fill" />
      </button>
    );

    if (large) {
      return <WithTooltip label={errorMessage ?? "Voice error"}>{errorButton}</WithTooltip>;
    }

    return (
      <Popover open onOpenChange={(open) => { if (!open) voice.dismissError(); }}>
        <PopoverAnchor asChild>{errorButton}</PopoverAnchor>
        <PopoverContent side="top" align="end" className="w-72">
          <VoiceErrorPanel voice={voice} onOpenSettings={onOpenSettings} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <WithTooltip label={hotkeyLabel ? `Dictate (${hotkeyLabel})` : "Dictate"}>
      <button
        onClick={handleClick}
        className={`flex items-center justify-center shrink-0 rounded-lg ${pad} ${floor} text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors`}
        aria-label="Dictate a message"
        data-testid="mic-button"
        data-state="idle"
      >
        <MicrophoneIcon size={iconSize} />
      </button>
    </WithTooltip>
  );
}
