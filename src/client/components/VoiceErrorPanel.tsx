

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
            size="md"
            onClick={() => {
              onOpenSettings();
              voice.dismissError();
            }}
          >
            Settings
          </Button>
        )}
        <Button variant="ghost" size="md" onClick={() => voice.dismissError()}>
          Dismiss
        </Button>
        {canRetryTranscription ? (
          <>
            <Button variant="secondary" size="md" onClick={() => voice.startRecording()}>
              Re-record
            </Button>
            <Button variant="primary" size="md" onClick={() => voice.retryTranscription()}>
              Resend
            </Button>
          </>
        ) : (
          <Button variant="primary" size="md" onClick={() => voice.startRecording()}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
