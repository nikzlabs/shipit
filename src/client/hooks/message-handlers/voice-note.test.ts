import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSessionStore } from "../../stores/session-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { usePlaybackStore } from "../../voice/playback-store.js";
import { armAutoplay, __resetVoiceNotesStateForTest } from "../../voice/voice-notes.js";
import { handleVoiceNote } from "./voice-note.js";
import type { HandlerContext } from "./types.js";
import type { WsVoiceNote } from "../../../server/shared/types.js";

const ctx: HandlerContext = {
  terminalRef: { current: null },
  queuedMessageStash: new Map(),
};

const note = (over: Partial<WsVoiceNote> = {}): WsVoiceNote => ({
  type: "voice_note",
  sessionId: "s1",
  id: "voice-1",
  headline: "Done — one test is still red, want me to dig in?",
  needsAttention: true,
  kind: "authored",
  createdAt: "2026-06-01T00:00:00.000Z",
  ...over,
});

let playSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useSessionStore.setState({ messages: [] });
  useSettingsStore.setState({ voiceHandsFree: false });
  __resetVoiceNotesStateForTest();
  playSpy = vi.fn(async () => undefined);
  usePlaybackStore.setState({ play: playSpy as unknown as (turnId: string, text: string) => Promise<void> });
});

describe("handleVoiceNote (docs/163)", () => {
  it("appends an assistant message carrying voiceNote metadata", () => {
    handleVoiceNote(ctx, note());
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "",
      voiceNote: { id: "voice-1", headline: note().headline, needsAttention: true, kind: "authored" },
    });
  });

  it("is idempotent by id — a duplicate delivery (reconnect replay) appends once", () => {
    useSettingsStore.setState({ voiceHandsFree: true });
    armAutoplay();
    handleVoiceNote(ctx, note());
    handleVoiceNote(ctx, note()); // same id, e.g. history load + buffer replay
    expect(useSessionStore.getState().messages).toHaveLength(1);
    // And the duplicate must not re-trigger autoplay.
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT autoplay when hands-free is off", () => {
    handleVoiceNote(ctx, note());
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("does NOT autoplay when hands-free is on but autoplay is not unlocked", () => {
    useSettingsStore.setState({ voiceHandsFree: true });
    handleVoiceNote(ctx, note());
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("autoplays when hands-free is on and unlocked", () => {
    useSettingsStore.setState({ voiceHandsFree: true });
    armAutoplay();
    handleVoiceNote(ctx, note());
    expect(playSpy).toHaveBeenCalledWith("voice-1", note().headline);
  });

  it("never autoplays a needsAttention:false (silent) note even with hands-free on", () => {
    useSettingsStore.setState({ voiceHandsFree: true });
    armAutoplay();
    handleVoiceNote(ctx, note({ needsAttention: false }));
    expect(playSpy).not.toHaveBeenCalled();
    // The silent note still renders a bubble.
    expect(useSessionStore.getState().messages).toHaveLength(1);
  });
});
