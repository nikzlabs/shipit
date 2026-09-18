// eslint-disable-next-line no-restricted-imports -- useEffect: focus the textarea on mount and subscribe to the voice transcript
import { useState, useCallback, useEffect, useRef } from "react";
import { useEventListener } from "../../hooks/useEventListener.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useVoiceInput } from "../../voice/use-voice-input.js";
import { spliceTranscript } from "../../voice/insert-transcript.js";
import { MicButton } from "../MicButton.js";
import { MobileRecordingOverlay } from "../MobileRecordingOverlay.js";
import { Button } from "../ui/button.js";

export function CommentInput({
  onSubmit,
  onCancel,
  initialText,
  quotedText,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
  quotedText?: string;
}) {
  const [text, setText] = useState(initialText ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();

  const voiceInputEnabled = useSettingsStore((s) => s.voiceInputEnabled);
  const cleanupEnabled = useSettingsStore((s) => s.cleanupEnabled);
  const voiceLanguage = useSettingsStore((s) => s.voiceLanguage);
  const sttProvider = useSettingsStore((s) => s.sttProvider);

  const voice = useVoiceInput({
    enabled: voiceInputEnabled,
    hotkey: "",
    cleanup: cleanupEnabled,
    language: voiceLanguage || undefined,
    sttProvider,
  });
  const { onTranscript } = voice;

  // Avoid moving the document to an input rendered below the selection.
  // eslint-disable-next-line no-restricted-syntax -- focus the input without auto-scroll
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return onTranscript((transcript) => {
      const ta = textareaRef.current;
      let cursor = 0;
      setText((current) => {
        const res = spliceTranscript({
          value: current,
          selectionStart: ta?.selectionStart,
          selectionEnd: ta?.selectionEnd,
          transcript,
        });
        cursor = res.cursor;
        return res.value;
      });
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus({ preventScroll: true });
          el.setSelectionRange(cursor, cursor);
        }
      });
    });
  }, [onTranscript]);

  useEventListener(window, "keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    // Preserve the draft when Escape stops an active recording.
    if (voice.state === "recording") {
      voice.cancelRecording();
      return;
    }
    onCancel();
  });

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }
    },
    [text, onSubmit],
  );

  return (
    <div className="mt-2 mb-3 ml-4 border border-(--color-border-secondary) rounded-lg bg-(--color-bg-secondary) p-3">
      {quotedText && (
        <blockquote className="mb-2 border-l-2 border-(--color-border-secondary) pl-2 text-xs text-(--color-text-secondary) italic line-clamp-3">
          {quotedText}
        </blockquote>
      )}
      <textarea
        ref={textareaRef}
        className="w-full bg-transparent text-sm text-(--color-text-primary) outline-none resize-none min-h-[60px] placeholder:text-(--color-text-tertiary)"
        placeholder="Add a comment... (Cmd+Enter to submit, Escape to cancel)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="flex items-center">
          {voiceInputEnabled && (
            <MicButton
              voice={voice}
              large={isMobile}
              onOpenSettings={() => {
                const ui = useUiStore.getState();
                ui.setSettingsTab("voice");
                ui.setSettingsOpen(true);
              }}
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => { if (text.trim()) onSubmit(text.trim()); }}
            disabled={!text.trim()}
          >
            Add
          </Button>
        </div>
      </div>
      {voiceInputEnabled && isMobile && <MobileRecordingOverlay voice={voice} />}
    </div>
  );
}
