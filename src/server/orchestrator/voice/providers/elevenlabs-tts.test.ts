import { describe, it, expect, vi } from "vitest";
import { createElevenLabsTtsProvider } from "./elevenlabs-tts.js";
import { VoiceProviderError } from "./types.js";

function audioResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
}

describe("createElevenLabsTtsProvider", () => {
  it("posts to the per-voice URL with the xi-api-key header and returns the response body stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    const provider = createElevenLabsTtsProvider("xi-test", fetchImpl as unknown as typeof fetch);

    const body = await provider.speak("hello", { voice: "21m00Tcm4TlvDq8ikWAM", speed: 1 });

    expect(body).toBeInstanceOf(ReadableStream);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(init.headers["xi-api-key"]).toBe("xi-test");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model_id: "eleven_multilingual_v2", text: "hello", voice_settings: { speed: 1 } });
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    const provider = createElevenLabsTtsProvider("xi-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.speak("hi", { voice: "21m00Tcm4TlvDq8ikWAM", speed: 1 })).rejects.toBeInstanceOf(
      VoiceProviderError,
    );
  });

  it("wraps network failures as a 502 VoiceProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = createElevenLabsTtsProvider("xi-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.speak("hi", { voice: "21m00Tcm4TlvDq8ikWAM", speed: 1 })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});
