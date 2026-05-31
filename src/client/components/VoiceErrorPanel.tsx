/**
 * Desktop voice-error panel (docs/144).
 *
 * The inline mic icon can show a warning glyph, but a ~16px icon + tooltip is
 * too thin to recover from a failure. This panel — rendered in a popover
 * anchored to the mic button on desktop — surfaces the error message and the
 * recovery actions. The mobile equivalent lives in `MobileRecordingOverlay`;
 * both share the same decision: if the audio was captured before the failure
 * (`canRetryTranscription`), the primary action is **Resend** (re-submit the
 * same recording — no re-speaking), with **Re-record** as the fallback;
 * otherwise the only recovery is **Try again** (record afresh).
 *
 * Purely presentational over `useVoiceInput`.
 */

import { WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { Button } from "./ui/button.js";
import type { VoiceInputApi } from "../voice/use-voice-input.js";

export function VoiceErrorPanel({
  voice,
  onOpenSettings,
}: {
  voice: VoiceInputApi;
  onOpenSettings?: () => void;
}) {
  const { errorMessage, canRetryTranscription } = voice;

  return (
    <div className="p-3" data-testid="voice-error-panel">
      <div className="flex items-start gap-2">
        <WarningCircleIcon
          size={ICON_SIZE.SM}
          weight="fill"
          className="mt-0.5 shrink-0 text-(--color-error)"
        />
        <p className="text-sm text-(--color-text-secondary)">
          {errorMessage ?? "Something went wrong"}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {onOpenSettings && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenSettings();
              voice.dismissError();
            }}
          >
            Settings
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => voice.dismissError()}>
          Dismiss
        </Button>
        {canRetryTranscription ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => voice.startRecording()}>
              Re-record
            </Button>
            <Button variant="primary" size="sm" onClick={() => voice.retryTranscription()}>
              Resend
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={() => voice.startRecording()}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
