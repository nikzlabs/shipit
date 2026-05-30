/**
 * Per-turn Play/Pause control (docs/144).
 *
 * Lives on the assistant turn footer. Reads playback state from the shared
 * store, so only the turn that is actually playing shows the playing/paused
 * UI — every other button reads as idle. Includes a thin progress bar and a
 * speed dropdown (persisted in settings; applied to the next synthesis, since
 * OpenAI bakes speed into the audio).
 */

import { PlayIcon, PauseIcon, SpinnerGapIcon, StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ICON_SIZE } from "../design-tokens.js";
import { WithTooltip } from "./ui/tooltip.js";
import { useVoicePlayback } from "../voice/use-voice-playback.js";
import { useSettingsStore } from "../stores/settings-store.js";

const SPEEDS = [1, 1.25, 1.5, 2] as const;

export function PlayTurnButton({ turnId, text }: { turnId: string; text: string }) {
  const playback = useVoicePlayback();
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const setTtsSpeed = useSettingsStore((s) => s.setTtsSpeed);

  const isActive = playback.playingTurnId === turnId;
  const state = isActive ? playback.state : "idle";
  const progress =
    isActive && playback.durationMs > 0
      ? Math.min(1, playback.positionMs / playback.durationMs)
      : 0;

  const handleMainClick = () => {
    if (state === "playing") {
      playback.pause();
    } else if (state === "paused") {
      playback.resume();
    } else {
      // idle, loading (ignored below), or error → (re)start this turn
      if (state !== "loading") void playback.play(turnId, text);
    }
  };

  const mainIcon =
    state === "loading" ? (
      <SpinnerGapIcon size={ICON_SIZE.SM} className="animate-spin" />
    ) : state === "playing" ? (
      <PauseIcon size={ICON_SIZE.SM} weight="fill" />
    ) : state === "error" ? (
      <WarningCircleIcon size={ICON_SIZE.SM} weight="fill" />
    ) : (
      <PlayIcon size={ICON_SIZE.SM} weight="fill" />
    );

  const mainLabel =
    state === "playing" ? "Pause" : state === "paused" ? "Resume" : state === "error" ? "Retry playback" : "Play";

  return (
    <div className="flex items-center gap-1.5" data-testid="play-turn" data-state={state}>
      <WithTooltip label={mainLabel}>
        <button
          onClick={handleMainClick}
          className={`flex items-center justify-center shrink-0 rounded-md p-1 transition-colors ${
            state === "error"
              ? "text-(--color-error) hover:bg-(--color-error)/15"
              : "text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover)"
          }`}
          aria-label={mainLabel}
          data-testid="play-turn-main"
        >
          {mainIcon}
        </button>
      </WithTooltip>

      {/* Progress + stop, only while this turn owns the player. */}
      {isActive && (state === "playing" || state === "paused") && (
        <>
          <div className="h-1 w-16 rounded-full bg-(--color-bg-hover) overflow-hidden" aria-hidden>
            <div
              className="h-full bg-(--color-accent) transition-[width] duration-200"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <WithTooltip label="Stop">
            <button
              onClick={() => playback.stop()}
              className="flex items-center justify-center shrink-0 rounded-md p-1 text-(--color-text-tertiary) hover:text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
              aria-label="Stop playback"
              data-testid="play-turn-stop"
            >
              <StopIcon size={ICON_SIZE.SM} weight="fill" />
            </button>
          </WithTooltip>
        </>
      )}

      {/* Speed — persisted; applied to the next synthesis. */}
      <select
        value={ttsSpeed}
        onChange={(e) => setTtsSpeed(Number(e.target.value))}
        className="bg-transparent text-xs text-(--color-text-tertiary) hover:text-(--color-text-secondary) rounded px-1 py-0.5 cursor-pointer focus:outline-none"
        aria-label="Playback speed"
        data-testid="play-turn-speed"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s} className="bg-(--color-bg-secondary) text-(--color-text-primary)">
            {s}×
          </option>
        ))}
      </select>
    </div>
  );
}
