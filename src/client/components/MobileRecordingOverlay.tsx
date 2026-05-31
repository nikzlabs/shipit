/**
 * Full-screen mobile recording surface (docs/144).
 *
 * On a phone the inline mic icon is a ~28px target — fine on desktop where
 * push-to-talk is the real gesture, painful on mobile where the button *is*
 * the whole interface. This overlay solves the stop end of that problem: while
 * recording (or transcribing), it takes over the screen with a large centered
 * Stop button, a live timer, and a Cancel escape hatch.
 *
 * It is purely presentational over `useVoiceInput` — no recording state lives
 * here. The start end is handled separately by enlarging the inline MicButton's
 * tap target (MicButton `large` prop); start has to coexist with the composer,
 * so it can't be a full-screen takeover the way stop can.
 *
 * Rendered only on mobile (gated by the caller via `useIsMobile()`); desktop
 * keeps the inline icon + hotkey.
 */

// eslint-disable-next-line no-restricted-imports -- Escape-to-cancel listener while the overlay is open
import { useEffect } from "react";
import { StopIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { VoiceInputApi } from "../voice/use-voice-input.js";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MobileRecordingOverlay({ voice }: { voice: VoiceInputApi }) {
  const { state, elapsedMs } = voice;
  const recording = state === "recording";
  const transcribing = state === "transcribing";
  const active = recording || transcribing;

  // Escape cancels an active recording (no-op once transcribing). Harmless on
  // mobile where there's no keyboard; useful for desktop testing of this view.
  // eslint-disable-next-line no-restricted-syntax -- Escape listener scoped to the open overlay
  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        voice.cancelRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording, voice]);

  if (!active) return null;

  return (
    <div
      role="dialog"
      aria-label="Voice recording"
      data-testid="mobile-recording-overlay"
      data-state={state}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-(--color-bg-overlay) px-6 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-2">
        {recording ? (
          <span className="text-6xl font-light tabular-nums text-(--color-text-primary)">
            {formatElapsed(elapsedMs)}
          </span>
        ) : (
          <span className="text-xl text-(--color-text-secondary)">Transcribing…</span>
        )}
        {recording && <span className="text-sm text-(--color-text-tertiary)">Listening…</span>}
      </div>

      {recording ? (
        <button
          onClick={() => voice.stopRecording()}
          aria-label="Stop recording"
          data-testid="mobile-recording-stop"
          className="relative flex h-32 w-32 items-center justify-center rounded-full bg-(--color-error) text-white shadow-2xl transition-transform active:scale-95"
        >
          <span className="absolute inset-0 rounded-full bg-(--color-error)/40 motion-safe:animate-ping" />
          <StopIcon size={ICON_SIZE.XL} weight="fill" className="relative" />
        </button>
      ) : (
        <div className="flex h-32 w-32 items-center justify-center rounded-full bg-(--color-bg-elevated)">
          <SpinnerGapIcon
            size={ICON_SIZE.XL}
            className="animate-spin text-(--color-text-secondary)"
          />
        </div>
      )}

      {recording && (
        <>
          <span className="text-sm text-(--color-text-tertiary)">Tap to stop</span>
          <button
            onClick={() => voice.cancelRecording()}
            aria-label="Cancel recording"
            data-testid="mobile-recording-cancel"
            className="mt-2 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          >
            <XIcon size={ICON_SIZE.SM} />
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
