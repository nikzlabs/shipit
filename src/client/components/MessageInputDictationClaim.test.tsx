/**
 * docs/144 — dictation on the new-session view survives the session claim.
 *
 * `/{slug}/new` claims its session in the background, so the composer's
 * `sessionId` goes from undefined to the claimed id while its `focusKey`
 * (`new:{slug}`) holds still. A recording started before the claim landed was
 * aborted by it — the mic UI flashed and vanished on a phone. The real
 * `useVoiceInput` runs here; only the microphone is faked.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useSettingsStore } from "../stores/settings-store.js";

const abort = vi.fn();

vi.mock("../voice/capture.js", () => ({
  startCapture: () =>
    Promise.resolve({
      stop: () => Promise.resolve({ blob: new Blob(["a"]), mimeType: "audio/webm" }),
      abort,
    }),
  MicPermissionError: class extends Error {},
}));

const { MessageInput } = await import("./MessageInput/MessageInput.js");

function micState(): string | null {
  return screen.getByTestId("mic-button").getAttribute("data-state");
}

async function startDictating() {
  fireEvent.click(screen.getByTestId("mic-button"));
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
  expect(micState()).toBe("recording");
}

beforeEach(() => {
  useSettingsStore.setState({ voiceInputEnabled: true });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  abort.mockClear();
});

describe("MessageInput dictation across a session claim (docs/144)", () => {
  it("keeps recording when the new-session view's session is claimed", async () => {
    const { rerender } = render(
      <MessageInput onSend={() => true} disabled={false} focusKey="new:acme-app" />,
    );
    await startDictating();

    rerender(
      <MessageInput onSend={() => true} disabled={false} focusKey="new:acme-app" sessionId="claimed-1" />,
    );

    expect(micState()).toBe("recording");
    expect(abort).not.toHaveBeenCalled();
  });

  it("still aborts when the composer moves to a different draft", async () => {
    const { rerender } = render(
      <MessageInput onSend={() => true} disabled={false} focusKey="s1" sessionId="s1" />,
    );
    await startDictating();

    rerender(<MessageInput onSend={() => true} disabled={false} focusKey="s2" sessionId="s2" />);

    expect(micState()).toBe("idle");
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
