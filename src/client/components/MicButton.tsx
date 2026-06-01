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

import { MicrophoneIcon, SpinnerGapIcon, WarningCircleIcon } from "@phosphor-icons/react";
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
  /** Human-readable hotkey shown in the idle tooltip, e.g. "Ctrl+Shift+Space". */
  hotkeyLabel?: string;
  /** Opens the Voice settings tab — wired to the error state's "Fix in settings". */
  onOpenSettings?: () => void;
  /**
   * Enlarge the touch target. Set on mobile, where this button — not the
   * push-to-talk hotkey — is the only way to start dictation, so a tiny
   * icon is a usability problem (docs/144).
   */
  large?: boolean;
}) {
  const { state, elapsedMs, errorMessage } = voice;
  // On mobile (`large`) the mic is a primary thumb target sitting next to Send,
  // so it grows to match the bottom-bar buttons: MD icon, larger padding, and a
  // 44px floor on the hit area (Apple HIG minimum). Desktop stays compact.
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
    // transcribing: ignore clicks
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
          <SpinnerGapIcon size={iconSize} className="animate-spin" />
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

    // Mobile (`large`): the full-screen MobileRecordingOverlay owns the error
    // UI (message + Resend/Re-record/Dismiss); this inline button sits behind
    // it, so a plain dismiss-on-click is enough. Desktop: anchor a popover that
    // surfaces the message and the recovery actions inline.
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
