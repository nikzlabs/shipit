/**
 * Full-screen mobile recording surface (docs/144).
 *
 * On a phone the inline mic icon is a ~28px target — fine on desktop where
 * push-to-talk is the real gesture, painful on mobile where the button *is*
 * the whole interface. This overlay takes over the screen for every non-idle
 * voice state:
 *
 * - **recording** — large Stop button, live timer, Cancel escape hatch.
 * - **transcribing** — spinner; auto-dismisses once the transcript splices in.
 * - **error** — the error message plus recovery actions: when the audio was
 *   captured before the failure (`canRetryTranscription`) the primary button is
 *   **Resend** (re-submits the same recording verbatim) with **Re-record** as a
 *   fallback; otherwise it's **Try again** (record afresh). Plus a Dismiss
 *   control. On desktop the inline MicButton owns the error UI (a popover); here
 *   the full-screen surface is the only legible way to show it on a phone.
 *
 * It is purely presentational over `useVoiceInput` — no recording state lives
 * here. The start end is handled separately by enlarging the inline MicButton's
 * tap target (MicButton `large` prop); start has to coexist with the composer,
 * so it can't be a full-screen takeover the way the rest can.
 *
 * Rendered only on mobile (gated by the caller via `useIsMobile()`); desktop
 * keeps the inline icon + hotkey.
 */

// eslint-disable-next-line no-restricted-imports -- Escape listener while the overlay is open
import { useEffect } from "react";
import {
  StopIcon,
  SpinnerGapIcon,
  XIcon,
  WarningCircleIcon,
  ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import type { VoiceInputApi } from "../voice/use-voice-input.js";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MobileRecordingOverlay({ voice }: { voice: VoiceInputApi }) {
  const { state, elapsedMs, errorMessage, canRetryTranscription } = voice;
  const recording = state === "recording";
  const transcribing = state === "transcribing";
  const error = state === "error";
  const active = recording || transcribing || error;
  // After a transcription failure the audio is retained, so the primary
  // recovery is to resend it verbatim rather than make the user re-speak.
  const canResend = error && canRetryTranscription;

  // Escape cancels an active recording or dismisses an error (no-op once
  // transcribing — the audio is already in flight). Harmless on mobile where
  // there's no keyboard; useful for desktop testing of this view.
  // eslint-disable-next-line no-restricted-syntax -- Escape listener scoped to the open overlay
  useEffect(() => {
    if (!recording && !error) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (recording) voice.cancelRecording();
      else voice.dismissError();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [recording, error, voice]);

  if (!active) return null;

  // Deliberately theme-independent: a recording surface is dark-with-light-text
  // in every app (Voice Memos, WhatsApp), and the themeable text tokens flip to
  // dark in light themes, blending into the scrim. A fixed dark scrim + explicit
  // light text keeps contrast high in every theme.
  return (
    <div
      role="dialog"
      aria-label="Voice recording"
      data-testid="mobile-recording-overlay"
      data-state={state}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 bg-black/75 px-6 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-2">
        {recording && (
          <>
            <span className="text-6xl font-light tabular-nums text-white">
              {formatElapsed(elapsedMs)}
            </span>
            <span className="text-sm text-white/60">Listening…</span>
          </>
        )}
        {transcribing && <span className="text-xl text-white/80">Transcribing…</span>}
        {error && (
          <div className="flex flex-col items-center gap-2">
            <WarningCircleIcon size={ICON_SIZE.LG} weight="fill" className="text-red-400" />
            <p className="max-w-xs text-center text-base text-red-400">
              {errorMessage ?? "Something went wrong"}
            </p>
          </div>
        )}
      </div>

      {recording && (
        <button
          onClick={() => voice.stopRecording()}
          aria-label="Stop recording"
          data-testid="mobile-recording-stop"
          className="relative flex h-32 w-32 items-center justify-center rounded-full bg-(--color-error) text-white shadow-2xl transition-transform active:scale-95"
        >
          <span className="absolute inset-0 rounded-full bg-(--color-error)/40 motion-safe:animate-ping" />
          <StopIcon size={ICON_SIZE.XL} weight="fill" className="relative" />
        </button>
      )}
      {transcribing && (
        <div className="flex h-32 w-32 items-center justify-center rounded-full bg-white/10">
          <SpinnerGapIcon size={ICON_SIZE.XL} className="animate-spin text-white/80" />
        </div>
      )}
      {error && (
        <button
          onClick={() => (canResend ? voice.retryTranscription() : voice.startRecording())}
          aria-label={canResend ? "Resend" : "Try again"}
          data-testid="mobile-recording-retry"
          className="relative flex h-32 w-32 flex-col items-center justify-center gap-1 rounded-full bg-red-500/20 text-red-300 transition-transform active:scale-95"
        >
          <ArrowClockwiseIcon size={ICON_SIZE.LG} weight="bold" />
          <span className="text-xs font-medium">{canResend ? "Resend" : "Try again"}</span>
        </button>
      )}

      {recording && (
        <>
          <span className="text-sm text-white/60">Tap to stop</span>
          <button
            onClick={() => voice.cancelRecording()}
            aria-label="Cancel recording"
            data-testid="mobile-recording-cancel"
            className="mt-2 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <XIcon size={ICON_SIZE.SM} />
            Cancel
          </button>
        </>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-3">
          {canResend && (
            <button
              onClick={() => voice.startRecording()}
              aria-label="Re-record"
              data-testid="mobile-recording-rerecord"
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              Re-record
            </button>
          )}
          <button
            onClick={() => voice.dismissError()}
            aria-label="Dismiss"
            data-testid="mobile-recording-dismiss"
            className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <XIcon size={ICON_SIZE.SM} />
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
