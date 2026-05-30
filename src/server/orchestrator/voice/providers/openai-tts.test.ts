import { describe, it, expect, vi } from "vitest";
import { createOpenAiTtsProvider } from "./openai-tts.js";
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

describe("createOpenAiTtsProvider", () => {
  it("posts the synthesis request and returns the response body stream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    const provider = createOpenAiTtsProvider("sk-test", fetchImpl as unknown as typeof fetch);

    const body = await provider.speak("hello", { voice: "nova", speed: 1.25 });

    expect(body).toBeInstanceOf(ReadableStream);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: "tts-1", input: "hello", voice: "nova", speed: 1.25, response_format: "mp3" });
  });

  it("honors a requested format override", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    const provider = createOpenAiTtsProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await provider.speak("hi", { voice: "alloy", speed: 1, format: "opus" });

    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.response_format).toBe("opus");
  });

  it("throws VoiceProviderError on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad", { status: 400 }));
    const provider = createOpenAiTtsProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.speak("hi", { voice: "alloy", speed: 1 })).rejects.toBeInstanceOf(VoiceProviderError);
  });

  it("wraps network failures as a 502 VoiceProviderError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const provider = createOpenAiTtsProvider("sk-test", fetchImpl as unknown as typeof fetch);

    await expect(provider.speak("hi", { voice: "alloy", speed: 1 })).rejects.toMatchObject({ statusCode: 502 });
  });
});
