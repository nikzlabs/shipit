/**
 * VoiceNoteCard (docs/163) — the inline rendering of a Native-sink voice note.
 *
 * Distinct from `PlayTurnButton` (which reads a finished turn's prose): a voice
 * note is an ear-shaped headline the agent emitted when it needs the user. The
 * card shows the headline text and a play control backed by the shared
 * playback-store (keyed by the note's synthetic id). When hands-free is off, or
 * autoplay isn't unlocked, this is the prominent tap-to-play prompt; tapping it
 * arms autoplay for subsequent notes.
 *
 * `needsAttention: false` notes render as a quieter "silent" bubble.
 */

import { PlayIcon, PauseIcon, SpinnerGapIcon, WarningCircleIcon, MegaphoneIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { useVoicePlayback } from "../voice/use-voice-playback.js";
import { armAutoplay } from "../voice/voice-notes.js";

export function VoiceNoteCard({
  id,
  headline,
  needsAttention,
}: {
  id: string;
  headline: string;
  needsAttention: boolean;
}) {
  const playback = useVoicePlayback();
  const isActive = playback.playingTurnId === id;
  const state = isActive ? playback.state : "idle";

  const handleClick = () => {
    if (state === "playing") {
      playback.pause();
    } else if (state === "paused") {
      playback.resume();
    } else if (state !== "loading") {
      // A tap is a user gesture — arm autoplay so later notes can play
      // themselves, then (re)start this note.
      armAutoplay();
      void playback.play(id, headline);
    }
  };

  const icon =
    state === "loading" ? (
      <SpinnerGapIcon size={ICON_SIZE.SM} className="animate-spin" />
    ) : state === "playing" ? (
      <PauseIcon size={ICON_SIZE.SM} weight="fill" />
    ) : state === "error" ? (
      <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" />
    ) : (
      <PlayIcon size={ICON_SIZE.SM} weight="fill" />
    );

  const label =
    state === "playing" ? "Pause" : state === "paused" ? "Resume" : state === "error" ? "Retry" : needsAttention ? "Play — the agent needs you" : "Play";

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
        needsAttention
          ? "border-(--color-accent)/40 bg-(--color-accent)/10"
          : "border-(--color-border) bg-(--color-bg-secondary)"
      }`}
      data-testid="voice-note-card"
      data-needs-attention={needsAttention}
      data-state={state}
    >
      <button
        onClick={handleClick}
        disabled={state === "loading"}
        className={`flex items-center justify-center shrink-0 rounded-full h-8 w-8 transition-colors ${
          state === "error"
            ? "text-(--color-error) hover:bg-(--color-error)/15"
            : needsAttention
              ? "text-(--color-accent) hover:bg-(--color-accent)/15"
              : "text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
        }`}
        aria-label={label}
        data-testid="voice-note-play"
      >
        {icon}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-(--color-text-tertiary)">
          <MegaphoneIcon size={ICON_SIZE.XS} weight="fill" />
          <span>{needsAttention ? "Voice note — needs you" : "Voice note"}</span>
        </div>
        <p className="text-sm text-(--color-text-primary) mt-0.5">{headline}</p>
      </div>
    </div>
  );
}
