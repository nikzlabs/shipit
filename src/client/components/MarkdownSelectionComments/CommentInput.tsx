/**
 * The doc-comment composer — used for both a new selection comment and an
 * in-place edit of an existing one (CommentCard), so wiring voice here covers
 * both paths.
 *
 * Voice dictation (docs/144) reuses the same stack as the chat composer and the
 * AskUserQuestion "Other" field: `useVoiceInput` owns the recording state
 * machine, `MicButton` renders the four states, and `spliceTranscript` inserts
 * the cleaned transcript at the cursor. As in the question card there is **no
 * push-to-talk hotkey** — the global hotkey belongs to the chat composer, and a
 * doc can have a pending comment and an open edit mounted at once, which would
 * fire both recorders on one keypress. The mic is button-only.
 */

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

  // Focus the textarea on mount without the browser scrolling it into view.
  // The new-comment input renders at the bottom of the document, so the native
  // `autoFocus` attribute would jump the scroll position to the bottom and lose
  // the user's place. `focus({ preventScroll: true })` focuses in place.
  // eslint-disable-next-line no-restricted-syntax -- focus the input without auto-scroll
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Splice each dictated transcript in at the cursor. Kept in a ref-free
  // closure over `setText`'s updater form so the subscription wires up once and
  // still sees freshly-typed text.
  // eslint-disable-next-line no-restricted-syntax -- transcript subscription with cleanup
  useEffect(() => {
    return voice.onTranscript((transcript) => {
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
  }, [voice.onTranscript]);

  useEventListener(window, "keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    // Escape while dictating cancels the *recording*, not the comment — losing
    // a half-typed comment to a mistimed Escape would be the worse outcome.
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
        {/* Mic sits opposite the actions rather than floating over the textarea:
            this composer is a resizable multi-line card, so an absolute overlay
            would collide with dictated text as it grows. */}
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
      {/* Mobile full-screen recording surface — null when idle, so harmless. */}
      {voiceInputEnabled && isMobile && <MobileRecordingOverlay voice={voice} />}
    </div>
  );
}
